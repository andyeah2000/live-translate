import { SpeechPreprocessor, base64FromInt16, floatToInt16, int16FromBase64, int16ToFloat } from './pcm';
import {
  GEMINI_EDGE_DECLICK_S,
  GEMINI_FADE_IN_S,
  GEMINI_INTERRUPT_FADE_S,
  GEMINI_FADE_OUT_S,
  applyCosineEdgeFades,
  fadeOutAudioParam,
  rampAudioParam
} from './audio-envelope';
import {
  MAX_PREROLL_AUDIO_MS,
  SEND_CHUNK_MS,
  reconnectDelayMs,
  samplesForDuration
} from './stream-timing';
import { softLimitInPlace } from './soft-limiter';

const WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const MODEL = 'models/gemini-3.5-live-translate-preview';
const OUTPUT_SAMPLE_RATE = 24000;
const WS_CONNECTING_STATE = 0;
const WS_OPEN_STATE = 1;
const MAX_RECONNECTS = 8;
const CONNECT_TIMEOUT_MS = 15_000;
const WORKLET_FLUSH_TIMEOUT_MS = 250;
const FINISH_INPUT_TIMEOUT_MS = 8_000;
const MIN_FINISH_INPUT_TIMEOUT_MS = 250;
const RECONNECT_STABLE_RESET_MS = 30_000;
export const MAX_RECONNECT_PLAYBACK_LEAD_S = 0.75;
const INPUT_PCM_BYTES_PER_SECOND = 16_000 * Int16Array.BYTES_PER_ELEMENT;
const BASE64_AUDIO_BYTES_PER_SECOND = (INPUT_PCM_BYTES_PER_SECOND * 4) / 3;
/** Maximal tolerierter lokaler WebSocket-Rückstau, bevor frisch neu verbunden wird. */
export const MAX_BUFFERED_AUDIO_MS = 750;
export const MAX_BUFFERED_BYTES = Math.floor(
  (BASE64_AUDIO_BYTES_PER_SECOND * MAX_BUFFERED_AUDIO_MS) / 1_000
);
const HANDOFF_SEND_PUMP_MS = 25;
export const TRANSCRIPT_SETTLE_MS = 350;
// Close-Codes, bei denen ein Reconnect sinnlos ist (Konfig-/Protokollfehler).
// 1008 gehört bewusst NICHT dazu: Gemini beendet damit auch reguläre
// Sitzungen nach Ablauf des Zeitlimits (goAway) – das ist reconnectbar.
const PERMANENT_CLOSE_CODES = new Set([1002, 1003, 1007]);

interface PlaybackTurn {
  gain: GainNode;
  sources: Set<AudioBufferSourceNode>;
  startTime: number;
  endTime: number;
  closed: boolean;
}

interface ScheduledPlayback {
  startTime: number;
  endTime: number;
  turn: PlaybackTurn;
}

interface GeminiServerMessage {
  setupComplete?: unknown;
  goAway?: { timeLeft?: unknown };
  sessionResumptionUpdate?: { newHandle?: unknown; resumable?: unknown };
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> };
    outputTranscription?: { text?: string };
    interrupted?: boolean;
    generationComplete?: boolean;
    turnComplete?: boolean;
  };
  error?: { message?: string };
}

export type TranscriptionPlacement = 'setup' | 'generation' | 'disabled';

export interface GeminiSessionSetup {
  resumptionEnabled?: boolean;
  compressionEnabled?: boolean;
  resumptionHandle?: string | null;
}

export type SessionManagementFeature = 'resumption' | 'compression';

export interface GeminiTranslatorOptions {
  apiKey: string;
  ctx: AudioContext;
  modelSource: AudioNode;
  outputNode: AudioNode;
  targetLanguage: string;
  onTranscript(text: string, final: boolean): void;
  onStatus(status: string): void;
  onReadyChange(ready: boolean): void;
  canContinueWithoutTranscript(): boolean;
  onError(detail: string): void;
}

export interface AudioTransportStats {
  capturedSamples: number;
  sentSamples: number;
  droppedSamples: number;
  pendingSamples: number;
}

export interface TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_TIMER_SCHEDULER: TimerScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number)
};

/** Schätzt nur die unvermeidbare lokale Sendelatenz; JSON-Overhead macht sie real etwas höher. */
export function bufferedAudioDurationMs(bufferedBytes: number): number {
  if (!Number.isFinite(bufferedBytes) || bufferedBytes <= 0) return 0;
  return (bufferedBytes / BASE64_AUDIO_BYTES_PER_SECOND) * 1_000;
}

export function shouldRestartForBackpressure(bufferedBytes: number): boolean {
  return Number.isFinite(bufferedBytes) && bufferedBytes >= MAX_BUFFERED_BYTES;
}

/** Protobuf-Duration kommt in JSON normalerweise als z. B. "4.25s". */
export function goAwayTimeLeftMs(goAway: unknown): number | null {
  if (!goAway || typeof goAway !== 'object') return null;
  const value = (goAway as { timeLeft?: unknown }).timeLeft;
  if (typeof value === 'string') {
    const match = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(value.trim());
    if (!match) return null;
    const milliseconds = Number(match[1]) * 1_000;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  if (!value || typeof value !== 'object') return null;
  const duration = value as { seconds?: unknown; nanos?: unknown };
  const seconds = Number(duration.seconds ?? 0);
  const nanos = Number(duration.nanos ?? 0);
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos) || seconds < 0 || nanos < 0) {
    return null;
  }
  return seconds * 1_000 + nanos / 1_000_000;
}

/**
 * Output-Transkripte dürfen laut Live-API nach `turnComplete` eintreffen.
 * Deshalb wird ein Turn erst nach einer kurzen Ruhephase finalisiert; ein
 * verspäteter Text-Chunk startet die Frist erneut.
 */
export class TranscriptTurnCoordinator {
  private timer: unknown = null;
  private completionPending = false;
  private hasText = false;

  constructor(
    private readonly emit: (text: string, final: boolean) => void,
    private readonly scheduler: TimerScheduler = DEFAULT_TIMER_SCHEDULER
  ) {}

  push(text: string): void {
    if (!text) return;
    this.hasText = true;
    this.emit(text, false);
    if (this.completionPending) this.armFinalization();
  }

  complete(): void {
    this.completionPending = true;
    this.armFinalization();
  }

  interrupt(): void {
    this.cancelTimer();
    this.completionPending = false;
    this.hasText = false;
    this.emit('', true);
  }

  finalizeNow(): void {
    if (!this.completionPending && !this.hasText) return;
    this.cancelTimer();
    this.completionPending = false;
    this.hasText = false;
    this.emit('', true);
  }

  reset(): void {
    this.cancelTimer();
    this.completionPending = false;
    this.hasText = false;
  }

  private armFinalization(): void {
    this.cancelTimer();
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      this.completionPending = false;
      this.hasText = false;
      this.emit('', true);
    }, TRANSCRIPT_SETTLE_MS);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timer = null;
  }
}

export function createGeminiSetup(
  targetLanguage: string,
  transcriptionPlacement: TranscriptionPlacement = 'setup',
  session: GeminiSessionSetup = {}
): object {
  const generationConfig: Record<string, unknown> = {
    responseModalities: ['AUDIO'],
    translationConfig: {
      targetLanguageCode: targetLanguage,
      echoTargetLanguage: false
    }
  };
  const setup: Record<string, unknown> = {
    model: MODEL,
    generationConfig,
    // Gegen falsch erkannte Wörter bei Musik/Atmo im Hintergrund:
    // Sprachanfänge eifrig erkennen und mit Vorlauf senden (nichts
    // abschneiden), Sätze nicht vorschnell beenden.
    realtimeInputConfig: {
      automaticActivityDetection: {
        startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
        prefixPaddingMs: 300,
        endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
        silenceDurationMs: 800
      }
    }
  };
  if (session.resumptionEnabled !== false) {
    setup.sessionResumption = session.resumptionHandle
      ? { handle: session.resumptionHandle }
      : {};
  }
  if (session.compressionEnabled !== false) {
    // Ohne Sliding-Window endet eine reine Audiositzung nach ca. 15 Minuten.
    // Die API wählt ohne explizite Token-Grenzen modellgerechte Defaults.
    setup.contextWindowCompression = { slidingWindow: {} };
  }
  // Die produktive Raw-v1beta-Runtime und die aktuelle Live-Translate-Doku
  // haben dieses Feld zeitweise an unterschiedlichen Stellen verlangt. Der
  // Client beherrscht beide Schemata und kann als letzte Stufe ohne Transkript
  // weiterübersetzen.
  if (transcriptionPlacement === 'setup') setup.outputAudioTranscription = {};
  else if (transcriptionPlacement === 'generation') {
    generationConfig.outputAudioTranscription = {};
  }
  return { setup };
}

export function isSessionManagementSchemaError(closeCode: number, reason: string): boolean {
  return rejectedSessionManagementFeature(closeCode, reason) !== null;
}

export function rejectedSessionManagementFeature(
  closeCode: number,
  reason: string
): SessionManagementFeature | null {
  if (closeCode !== 1007) return null;
  if (/session.?resumption/i.test(reason)) return 'resumption';
  if (/context.?window.?compression/i.test(reason)) return 'compression';
  return null;
}

export function nextTranscriptionPlacement(
  current: TranscriptionPlacement,
  closeCode: number,
  reason: string
): TranscriptionPlacement | null {
  if (closeCode !== 1007 || !/output.?audio.?transcription/i.test(reason)) return null;
  if (current === 'setup') return 'generation';
  if (current === 'generation') return 'disabled';
  return null;
}

export class GeminiTranslator {
  private ws: WebSocket | null = null;
  private handoffWs: WebSocket | null = null;
  private worklet: AudioWorkletNode | null = null;
  private silentSink: GainNode | null = null;
  private ready = false;
  private connectionReady = false;
  private stopped = false;
  private reconnectAttempts = 0;
  private pendingChunks: Int16Array[] = [];
  private pendingSamples = 0;
  private capturedSamples = 0;
  private sentSamples = 0;
  private droppedSamples = 0;
  private nextPlayTime = 0;
  private reconnectTimer: number | null = null;
  private connectTimer: number | null = null;
  private handoffConnectTimer: number | null = null;
  private handoffRetryTimer: number | null = null;
  private pendingFlushTimer: number | null = null;
  private stableConnectionTimer: number | null = null;
  private handoffInputPaused = false;
  private handoffDrainActive = false;
  private transcriptionPlacement: TranscriptionPlacement = 'setup';
  private sessionResumptionEnabled = true;
  private contextCompressionEnabled = true;
  private resumptionHandle: string | null = null;
  private readonly playingSources = new Set<AudioBufferSourceNode>();
  private readonly sourceSchedule = new Map<AudioBufferSourceNode, ScheduledPlayback>();
  private readonly playbackTurns = new Set<PlaybackTurn>();
  private playbackTurn: PlaybackTurn | null = null;
  private readonly preprocessor: SpeechPreprocessor;
  private readonly transcriptTurns: TranscriptTurnCoordinator;
  private readonly sendRate = 16000;
  private workletFlushResolver: (() => void) | null = null;
  private finishPromise: Promise<void> | null = null;
  private finishResolver: (() => void) | null = null;
  private finishTimer: number | null = null;
  private finishForceTimer: number | null = null;
  private finishTimedOut = false;
  private captureClosed = false;
  private inputEndSent = false;

  constructor(private readonly opts: GeminiTranslatorOptions) {
    // Gemini Live Translate akzeptiert ausschließlich PCM16/16 kHz. Der
    // optionale Highpass sitzt bereits im Audio-Graphen;
    // hier folgen nur Anti-Aliasing und Resampling.
    this.preprocessor = new SpeechPreprocessor(opts.ctx.sampleRate, { highpass: false });
    this.transcriptTurns = new TranscriptTurnCoordinator(opts.onTranscript);
  }

  async start(): Promise<void> {
    const { ctx, modelSource } = this.opts;
    this.opts.onStatus('Verbinde mit Gemini…');

    // Netzwerk-Handshake und lokales Worklet parallel starten. Früher begann
    // die Verbindung erst nach dem Worklet-Setup und verlor dadurch unnötig
    // den Anfang des laufenden Videos.
    this.openSocket();
    await ctx.audioWorklet.addModule(chrome.runtime.getURL('worklet.js'));
    if (this.stopped) return;
    this.worklet = new AudioWorkletNode(ctx, 'pcm-capture');
    // Der Worklet liefert nur Daten, wenn er mit dem Graphen verbunden ist;
    // der stumme Gain verhindert, dass das Original doppelt hörbar wird.
    this.silentSink = ctx.createGain();
    this.silentSink.gain.value = 0;
    modelSource.connect(this.worklet);
    this.worklet.connect(this.silentSink).connect(ctx.destination);
    this.worklet.port.onmessage = (event) => this.handleWorkletMessage(event.data as unknown);

  }

  /** Sample-Bilanz für reproduzierbare Transport-QA, ohne Audioinhalte. */
  getAudioTransportStats(): AudioTransportStats {
    return {
      capturedSamples: this.capturedSamples,
      sentSamples: this.sentSamples,
      droppedSamples: this.droppedSamples,
      pendingSamples: this.pendingSamples
    };
  }

  /**
   * Leert den letzten Capture-/PCM-Block, signalisiert Geminis Stream-Ende und
   * lässt die bereits erzeugte letzte Phrase begrenzt ausspielen.
   */
  finishInput(timeoutMs = FINISH_INPUT_TIMEOUT_MS): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.finishPromise) return this.finishPromise;
    const boundedTimeoutMs = Math.max(
      MIN_FINISH_INPUT_TIMEOUT_MS,
      Number.isFinite(timeoutMs) ? timeoutMs : FINISH_INPUT_TIMEOUT_MS
    );
    this.finishPromise = new Promise<void>((resolve) => {
      this.finishResolver = resolve;
    });
    this.finishTimer = globalThis.setTimeout(() => {
      this.finishTimer = null;
      this.finishTimedOut = true;
      // audioStreamEnd hat im Raw-Protokoll keine korrelierbare Quittung. Daher
      // wird kein beliebiges turnComplete/generationComplete als Ack gedeutet:
      // erst dieses konservative Drain-Fenster darf den Abschluss freigeben.
      this.maybeResolveFinishInput();
    }, boundedTimeoutMs);
    // Eine defekte/abgebrochene Servergeneration darf Stop niemals unendlich
    // blockieren. Diese zweite Grenze ist der explizite Notausgang; im
    // Normalfall löst der erste Timer oder das letzte onended deutlich vorher.
    this.finishForceTimer = globalThis.setTimeout(
      () => this.resolveFinishInput(),
      boundedTimeoutMs * 2
    );
    void this.beginFinishInput();
    return this.finishPromise;
  }

  stop(): void {
    this.stopped = true;
    this.setConnectionReady(false);
    this.resolveFinishInput();
    this.clearTimers();
    this.clearInputQueue();
    this.clearPlaybackQueue();
    this.transcriptTurns.reset();
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.disconnect();
      this.worklet = null;
    }
    this.silentSink?.disconnect();
    this.silentSink = null;
    const ws = this.ws;
    if (ws?.readyState === WS_CONNECTING_STATE || ws?.readyState === WS_OPEN_STATE) {
      try {
        ws.close(1000, 'client stop');
      } catch {
        // Browser-spezifischer Randfall; Referenz sofort verwerfen.
      }
    }
    this.ws = null;
    const handoffWs = this.handoffWs;
    if (
      handoffWs?.readyState === WS_CONNECTING_STATE ||
      handoffWs?.readyState === WS_OPEN_STATE
    ) {
      try {
        handoffWs.close(1000, 'client stop');
      } catch {
        // Referenz wird unten in jedem Fall verworfen.
      }
    }
    this.handoffWs = null;
  }

  private openSocket(): void {
    if (this.stopped) return;
    this.setConnectionReady(false);
    this.clearConnectTimer();

    const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(this.opts.apiKey)}`);
    this.ws = ws;
    this.connectTimer = globalThis.setTimeout(() => {
      if (this.ws !== ws || this.ready) return;
      if (ws.readyState === WS_CONNECTING_STATE || ws.readyState === WS_OPEN_STATE) {
        try {
          ws.close(4000, 'setup timeout');
        } catch {
          // handleClose oder der nächste Verbindungsversuch übernimmt.
        }
      }
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      ws.send(
        JSON.stringify(
          createGeminiSetup(this.opts.targetLanguage, this.transcriptionPlacement, {
            resumptionEnabled: this.sessionResumptionEnabled,
            compressionEnabled: this.contextCompressionEnabled,
            resumptionHandle: this.resumptionHandle
          })
        )
      );
    };
    ws.onmessage = (event) =>
      void this.handleServerMessage(ws, event.data as string | Blob | ArrayBuffer);
    ws.onclose = (event) => this.handleClose(ws, event);
  }

  /**
   * Baut bei einem planmäßigen Gemini-GoAway den Nachfolger parallel auf.
   * Ab der Kandidaten-Grenze wartet neues Audio in der lokalen FIFO. Nach
   * `setupComplete` geht es exakt einmal an den Nachfolger – auch wenn Gemini
   * die alte Sitzung zuvor als nicht fortsetzbar markiert hat.
   */
  private openHandoffSocket(): void {
    const active = this.ws;
    if (
      this.stopped ||
      this.handoffWs !== null ||
      active?.readyState !== WS_OPEN_STATE ||
      !this.connectionReady
    ) {
      return;
    }
    this.clearHandoffConnectTimer();
    const candidate = new WebSocket(`${WS_URL}?key=${encodeURIComponent(this.opts.apiKey)}`);
    this.handoffWs = candidate;
    this.handoffInputPaused = true;
    // Während der kurzen eindeutigen Sample-Grenze bleibt der Originalton
    // fail-open bei 100 %, statt Sprache ohne zeitgleiche Übersetzung zu ducken.
    this.setReady(false);
    this.handoffConnectTimer = globalThis.setTimeout(() => {
      if (this.handoffWs !== candidate) return;
      try {
        if (
          candidate.readyState === WS_CONNECTING_STATE ||
          candidate.readyState === WS_OPEN_STATE
        ) {
          candidate.close(4000, 'handoff setup timeout');
        }
      } catch {
        this.abandonHandoff(candidate);
      }
    }, CONNECT_TIMEOUT_MS);
    candidate.onopen = () => {
      if (this.stopped || this.handoffWs !== candidate) return;
      candidate.send(
        JSON.stringify(
          createGeminiSetup(this.opts.targetLanguage, this.transcriptionPlacement, {
            resumptionEnabled: this.sessionResumptionEnabled,
            compressionEnabled: this.contextCompressionEnabled,
            // Bis zum tatsächlichen Setup immer den jüngsten ausdrücklich
            // sicheren Server-Checkpoint verwenden. Session Resumption setzt
            // dieselbe serverseitige Sitzung fort; Audio doppelt zu senden
            // würde dagegen Wörter doppelt übersetzen.
            resumptionHandle: this.resumptionHandle
          })
        )
      );
    };
    candidate.onmessage = (event) =>
      void this.handleServerMessage(candidate, event.data as string | Blob | ArrayBuffer);
    candidate.onclose = (event) => this.handleClose(candidate, event);
  }

  private handleClose(ws: WebSocket, event: CloseEvent): void {
    if (this.stopped) return;
    if (ws === this.handoffWs) {
      this.handleHandoffClose(ws, event);
      return;
    }
    if (ws !== this.ws) return;
    this.clearConnectTimer();
    this.clearStableConnectionTimer();
    this.ws = null;
    this.prepareForReconnect();
    const reason = `Code ${event.code}${event.reason ? `: ${event.reason}` : ''}`;
    // Wenn der planmäßige Nachfolger bereits verbindet, erhält er zuerst die
    // Chance zur Übernahme. Sein Timeout/Close startet bei Bedarf den normalen
    // Reconnect; zwei konkurrierende neue Sockets würden nur Duplikate erzeugen.
    if (this.handoffWs !== null) {
      this.opts.onStatus('Gemini-Sitzungswechsel läuft…');
      return;
    }
    if (this.scheduleSessionManagementFallback(event.code, event.reason, reason)) return;
    if (this.scheduleTranscriptionFallback(event.code, event.reason, reason)) return;
    if (PERMANENT_CLOSE_CODES.has(event.code)) {
      this.fail(`Gemini hat die Verbindung abgelehnt (${reason})`);
      return;
    }
    if (this.reconnectAttempts >= MAX_RECONNECTS) {
      this.fail(`Gemini-Verbindung verloren (${reason})`);
      return;
    }
    this.reconnectAttempts++;
    // Exponentieller Backoff: Der Server zählt die alte Sitzung ggf. noch –
    // zu schnelle Versuche werden mit 1006 abgelehnt.
    const delayMs = reconnectDelayMs(this.reconnectAttempts);
    console.warn(
      `[live-translate] Gemini getrennt (${reason}) – Reconnect ${this.reconnectAttempts}/${MAX_RECONNECTS} in ${delayMs / 1000}s`
    );
    this.opts.onStatus(`Verbindung unterbrochen – verbinde neu (${this.reconnectAttempts}/${MAX_RECONNECTS})…`);
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delayMs);
  }

  private handleHandoffClose(candidate: WebSocket, event: CloseEvent): void {
    if (candidate !== this.handoffWs) return;
    this.abandonHandoff(candidate);
    const reason = `Code ${event.code}${event.reason ? `: ${event.reason}` : ''}`;
    const active = this.ws;
    if (
      active?.readyState === WS_OPEN_STATE &&
      this.connectionReady &&
      this.reconnectAttempts < MAX_RECONNECTS
    ) {
      this.reconnectAttempts++;
      const delayMs = reconnectDelayMs(this.reconnectAttempts);
      console.warn(
        `[live-translate] Gemini-Handover fehlgeschlagen (${reason}) – neuer Versuch in ${delayMs} ms`
      );
      this.opts.onStatus('Gemini bereitet den nächsten Sitzungswechsel erneut vor…');
      this.handoffRetryTimer = globalThis.setTimeout(() => {
        this.handoffRetryTimer = null;
        this.openHandoffSocket();
      }, delayMs);
      return;
    }
    // Der alte Socket ist ebenfalls fort: auf dem normalen, begrenzten
    // Reconnect-Pfad weiterarbeiten.
    if (this.reconnectAttempts >= MAX_RECONNECTS) {
      this.fail(`Gemini-Verbindung verloren (${reason})`);
      return;
    }
    this.reconnectAttempts++;
    const delayMs = reconnectDelayMs(this.reconnectAttempts);
    this.opts.onStatus(`Verbindung unterbrochen – verbinde neu (${this.reconnectAttempts}/${MAX_RECONNECTS})…`);
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delayMs);
  }

  private fail(detail: string): void {
    if (this.stopped) return;
    this.stop();
    this.opts.onError(detail);
  }

  private handleCapturedAudio(chunk: Float32Array<ArrayBuffer>): void {
    if (this.stopped || this.captureClosed || this.inputEndSent) return;
    const samples = this.preprocessor.process(chunk);
    if (samples.length === 0) return;
    // Der Web-Audio-Kompressor ist absichtlich musikalisch und kein echter
    // Peak-Limiter. Diese transparente Sample-Kennlinie verhindert deshalb
    // nachweisbar PCM16-Sättigung, ohne normale Sprachpegel anzutasten.
    softLimitInPlace(samples);
    const pcm = floatToInt16(samples);
    this.capturedSamples += pcm.length;
    this.pendingChunks.push(pcm);
    this.pendingSamples += pcm.length;

    if (this.handoffInputPaused) {
      // Nicht an den alten Socket senden: dieselbe FIFO wird nach
      // setupComplete vom Kandidaten geleert. Das ist eine eindeutige
      // Sample-Grenze ohne Verlust oder Doppelversand.
      return;
    }

    const ws = this.ws;
    if (!this.connectionReady || ws?.readyState !== WS_OPEN_STATE) {
      // Setup und schnelle Reconnects überbrücken, aber nie einen langen,
      // später hörbaren Rückstau aufbauen. Bei Überlauf bleibt das frischeste
      // Audio erhalten, weil es zeitlich am besten zum laufenden Video passt.
      const maxPrerollSamples = samplesForDuration(this.sendRate, MAX_PREROLL_AUDIO_MS);
      if (this.pendingSamples > maxPrerollSamples) {
        this.dropPendingSamples(this.pendingSamples - maxPrerollSamples);
      }
      return;
    }
    this.flushPendingAudio(ws);
  }

  private flushPendingAudio(ws: WebSocket, includePartial = false): void {
    if (this.pendingSamples === 0) {
      this.finishHandoffDrain();
      return;
    }
    // Bereits wenige hundert Millisekunden Rückstau zerstören die zeitliche
    // Zuordnung zwischen Video, Ducking und Übersetzung. Die alte Verbindung
    // wird deshalb verworfen, statt ihren Puffer später noch abzuspielen.
    if (shouldRestartForBackpressure(ws.bufferedAmount)) {
      if (this.handoffDrainActive) {
        this.schedulePendingFlush(ws);
        return;
      }
      this.restartSocketImmediately(
        ws,
        `Netz überlastet (${Math.round(bufferedAudioDurationMs(ws.bufferedAmount))} ms Rückstau) · verbinde neu…`,
        'backpressure restart',
        4001,
        true
      );
      return;
    }
    const chunkSize = (this.sendRate * SEND_CHUNK_MS) / 1000;
    while (this.pendingSamples >= chunkSize || (includePartial && this.pendingSamples > 0)) {
      if (shouldRestartForBackpressure(ws.bufferedAmount)) {
        if (this.handoffDrainActive) {
          this.schedulePendingFlush(ws);
          return;
        }
        this.restartSocketImmediately(
          ws,
          `Netz überlastet (${Math.round(bufferedAudioDurationMs(ws.bufferedAmount))} ms Rückstau) · verbinde neu…`,
          'backpressure restart',
          4001,
          true
        );
        return;
      }
      const outgoing = this.takePendingSamples(Math.min(chunkSize, this.pendingSamples));
      try {
        this.sendAudioMessage(ws, outgoing);
        this.sentSamples += outgoing.length;
      } catch (error) {
        this.prependPendingSamples(outgoing);
        this.restartSocketImmediately(
          ws,
          'Audioübertragung unterbrochen · verbinde neu…',
          'audio send failed',
          4002
        );
        console.warn('[live-translate] Audio-Chunk konnte nicht gesendet werden:', error);
        return;
      }
    }
    this.finishHandoffDrain();
  }

  private async handleServerMessage(ws: WebSocket, data: string | Blob | ArrayBuffer): Promise<void> {
    if (this.stopped || !this.isKnownSocket(ws)) return;
    let text: string;
    if (typeof data === 'string') text = data;
    else if (data instanceof Blob) text = await data.text();
    else text = new TextDecoder().decode(data);
    if (this.stopped || !this.isKnownSocket(ws)) return;

    let msg: GeminiServerMessage;
    try {
      msg = JSON.parse(text) as GeminiServerMessage;
    } catch {
      return;
    }

    if (msg.error?.message) {
      if (ws === this.handoffWs) {
        const feature = rejectedSessionManagementFeature(1007, msg.error.message);
        const transcriptFallback = nextTranscriptionPlacement(
          this.transcriptionPlacement,
          1007,
          msg.error.message
        );
        if (feature && this.disableSessionManagementFeature(feature)) {
          this.retryHandoffWithUpdatedSetup(ws, 'Gemini passt den Sitzungswechsel an…');
          return;
        }
        if (
          transcriptFallback &&
          (transcriptFallback !== 'disabled' || this.opts.canContinueWithoutTranscript())
        ) {
          this.transcriptionPlacement = transcriptFallback;
          this.retryHandoffWithUpdatedSetup(ws, 'Gemini passt das Transkript-Protokoll an…');
          return;
        }
        console.warn('[live-translate] Gemini-Handover abgelehnt:', msg.error.message);
        try {
          if (ws.readyState === WS_OPEN_STATE) ws.close(4000, 'handoff rejected');
        } catch {
          this.abandonHandoff(ws);
        }
        return;
      }
      if (
        this.scheduleSessionManagementFallback(1007, msg.error.message, msg.error.message) ||
        this.scheduleTranscriptionFallback(1007, msg.error.message, msg.error.message)
      ) {
        // Der folgende Close-Event gehört noch zur verworfenen Verbindung und
        // darf keinen zweiten Reconnect auslösen.
        this.ws = null;
        if (ws.readyState === WS_OPEN_STATE) ws.close(1000, 'setup schema fallback');
        return;
      }
      this.fail(`Gemini-Fehler: ${msg.error.message}`);
      return;
    }
    const resumptionUpdate = msg.sessionResumptionUpdate;
    if (
      resumptionUpdate?.resumable === true &&
      typeof resumptionUpdate.newHandle === 'string' &&
      resumptionUpdate.newHandle.length > 0
    ) {
      // Nur ausdrücklich resumable Handles speichern.
      this.resumptionHandle = resumptionUpdate.newHandle;
      return;
    }
    if (resumptionUpdate?.resumable === false) {
      // Laut Live-API darf in diesem Zustand auch ein älterer Token nicht
      // weiterverwendet werden: Er könnte hinter der aktuellen Generierung
      // liegen und damit Ausgabe verlieren. Der nächste Socket startet frisch,
      // sofern nicht vorher wieder ein neuer resumable=true-Handle eintrifft.
      this.resumptionHandle = null;
      if (ws === this.ws && this.handoffWs !== null) {
        this.retryHandoffWithUpdatedSetup(
          this.handoffWs,
          'Gemini startet den Sitzungswechsel ohne veralteten Checkpoint neu…'
        );
      }
      return;
    }
    if (msg.goAway !== undefined) {
      // Ein geplanter Sitzungswechsel darf nicht durch den generischen
      // exponentiellen Backoff laufen. Der letzte ausdrücklich sichere
      // Resumption-Checkpoint wird im neuen Setup direkt weiterverwendet.
      const timeLeftMs = goAwayTimeLeftMs(msg.goAway);
      const timeLeft = timeLeftMs === null ? '' : ` · ${Math.ceil(timeLeftMs / 1_000)} s Restzeit`;
      if (ws === this.handoffWs) {
        // Ein Kandidat, der schon vor seiner Übernahme ausläuft, ist nicht
        // brauchbar. Der aktive Socket bleibt davon unberührt.
        try {
          if (ws.readyState === WS_OPEN_STATE) ws.close(4000, 'handoff goAway');
        } catch {
          this.abandonHandoff(ws);
        }
        return;
      }
      this.opts.onStatus(`Gemini wechselt die Sitzung${timeLeft} · Übersetzung läuft weiter…`);
      this.openHandoffSocket();
      return;
    }
    if (msg.setupComplete !== undefined) {
      if (ws === this.handoffWs) {
        this.promoteHandoff(ws);
        return;
      }
      this.connectionReady = true;
      if (this.handoffInputPaused) {
        this.handoffInputPaused = false;
        this.handoffDrainActive = this.pendingSamples > 0;
      }
      this.setReady(!this.handoffDrainActive);
      this.clearConnectTimer();
      // Eine flappende Verbindung darf ihr gesamtes Retry-Budget nicht durch
      // jedes kurzlebige setupComplete sofort zurückbekommen.
      this.armStableConnectionReset();
      this.opts.onStatus(
        this.handoffDrainActive
          ? 'Gemini-Sitzung verbunden · Audio wird aufgeholt…'
          : this.runningStatus()
      );
      this.flushPendingAudio(ws, this.captureClosed);
      this.trySendInputEnd();
      return;
    }

    // Vor setupComplete darf ein Kandidat keine zweite Ausgabequelle werden.
    if (ws !== this.ws) return;

    const content = msg.serverContent;
    if (!content) return;
    if (content.interrupted) {
      // Gemini verwirft bei Barge-in seine restliche Antwort. Bereits lokal
      // eingeplante Audioblöcke müssen ebenfalls weg, sonst spricht eine alte
      // Übersetzung über den nächsten Satz hinweg.
      this.fadeInterruptedPlayback();
      this.transcriptTurns.interrupt();
      return;
    }
    const audioParts = (content.modelTurn?.parts ?? [])
      .map((part) => part.inlineData?.data)
      .filter((audio): audio is string => typeof audio === 'string' && audio.length > 0);
    const startsTurn = this.playbackTurn === null;
    for (let index = 0; index < audioParts.length; index++) {
      this.playTranslatedAudio(audioParts[index]!, {
        fadeIn: startsTurn && index === 0,
        fadeOut:
          (content.generationComplete === true || content.turnComplete === true) &&
          index === audioParts.length - 1
      });
    }
    const transcript = content.outputTranscription?.text;
    if (transcript) this.transcriptTurns.push(transcript);
    if (content.generationComplete) {
      this.finishPlaybackTurn();
    }
    if (content.turnComplete) {
      this.finishPlaybackTurn();
      this.transcriptTurns.complete();
    }
    this.maybeResolveFinishInput();
  }

  private playTranslatedAudio(
    base64: string,
    edges: { fadeIn: boolean; fadeOut: boolean }
  ): void {
    try {
      const { ctx, outputNode } = this.opts;
      const samples = int16ToFloat(int16FromBase64(base64));
      if (samples.length === 0) return;
      applyCosineEdgeFades(
        samples,
        OUTPUT_SAMPLE_RATE,
        edges.fadeIn ? GEMINI_EDGE_DECLICK_S : 0,
        edges.fadeOut ? GEMINI_EDGE_DECLICK_S : 0
      );
      const buffer = ctx.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      const existingTurn = this.playbackTurn;
      // Nur der Turn-Anfang braucht einen 50-ms-Jitterpuffer. Innere Chunks
      // werden direkt an das geplante Ende gehängt; ein pauschaler neuer
      // 50-ms-Vorlauf erzeugte sonst künstliche Lücken trotz rechtzeitig
      // eingetroffener Daten.
      const safetyLead = existingTurn ? 0.005 : 0.05;
      const startAt = Math.max(ctx.currentTime + safetyLead, this.nextPlayTime);
      const turn = existingTurn ?? this.createPlaybackTurn(startAt, outputNode);
      node.connect(turn.gain);
      this.playingSources.add(node);
      turn.sources.add(node);
      node.onended = () => {
        this.playingSources.delete(node);
        this.sourceSchedule.delete(node);
        turn.sources.delete(node);
        // Zwischen zwei verspätet eintreffenden Netzwerk-Chunks kann die
        // Source-Menge kurz leer sein. Den Turn-Bus erst nach turnComplete
        // trennen, sonst wäre der nächste Chunk desselben Satzes stumm.
        if (turn.closed && turn.sources.size === 0) {
          turn.gain.disconnect();
          this.playbackTurns.delete(turn);
        }
        this.maybeResolveFinishInput();
      };
      node.start(startAt);
      this.nextPlayTime = startAt + buffer.duration;
      turn.endTime = this.nextPlayTime;
      this.sourceSchedule.set(node, {
        startTime: startAt,
        endTime: this.nextPlayTime,
        turn
      });
    } catch (err) {
      console.warn('[live-translate] Ungültigen Gemini-Audio-Chunk übersprungen:', err);
      // Fehlerhafte Audio-Chunks überspringen statt die Sitzung zu beenden.
    }
  }

  private createPlaybackTurn(startTime: number, outputNode: AudioNode): PlaybackTurn {
    const gain = this.opts.ctx.createGain();
    gain.gain.value = 0;
    gain.connect(outputNode);
    rampAudioParam(gain.gain, 1, startTime, GEMINI_FADE_IN_S);
    const turn: PlaybackTurn = {
      gain,
      sources: new Set(),
      startTime,
      endTime: startTime,
      closed: false
    };
    this.playbackTurn = turn;
    this.playbackTurns.add(turn);
    return turn;
  }

  private finishPlaybackTurn(): void {
    const turn = this.playbackTurn;
    if (!turn) return;
    this.playbackTurn = null;
    turn.closed = true;
    const now = this.opts.ctx.currentTime;
    const audibleDuration = Math.max(0, turn.endTime - turn.startTime);
    const duration = Math.min(GEMINI_FADE_OUT_S, audibleDuration / 3);
    const fadeStart = Math.max(now, turn.endTime - duration);
    if (turn.endTime > fadeStart && duration > 0) {
      fadeOutAudioParam(turn.gain.gain, fadeStart, turn.endTime);
    } else {
      turn.gain.gain.setValueAtTime(0, now);
    }
    if (turn.sources.size === 0) {
      turn.gain.disconnect();
      this.playbackTurns.delete(turn);
    }
  }

  private fadeInterruptedPlayback(): void {
    const now = this.opts.ctx.currentTime;
    const stopAt = now + GEMINI_INTERRUPT_FADE_S;
    for (const turn of this.playbackTurns) {
      turn.closed = true;
      fadeOutAudioParam(turn.gain.gain, now, stopAt);
      for (const source of turn.sources) {
        try {
          source.stop(stopAt);
        } catch {
          // Bereits beendet.
        }
      }
    }
    this.playbackTurn = null;
    this.nextPlayTime = 0;
  }

  private dropPendingSamples(count: number): void {
    let remaining = Math.min(Math.max(0, Math.floor(count)), this.pendingSamples);
    const requested = remaining;
    while (remaining > 0) {
      const head = this.pendingChunks[0];
      if (!head) break;
      if (remaining >= head.length) {
        remaining -= head.length;
        this.pendingSamples -= head.length;
        this.pendingChunks.shift();
      } else {
        this.pendingChunks[0] = head.slice(remaining);
        this.pendingSamples -= remaining;
        remaining = 0;
      }
    }
    this.droppedSamples += requested - remaining;
  }

  private takePendingSamples(count: number): Int16Array<ArrayBuffer> {
    const out = new Int16Array(count);
    let offset = 0;
    while (offset < count) {
      const head = this.pendingChunks[0];
      if (!head) break;
      const take = Math.min(head.length, count - offset);
      out.set(head.subarray(0, take), offset);
      offset += take;
      if (take === head.length) this.pendingChunks.shift();
      else this.pendingChunks[0] = head.slice(take);
    }
    this.pendingSamples -= offset;
    return out;
  }

  private prependPendingSamples(samples: Int16Array<ArrayBuffer>): void {
    if (samples.length === 0) return;
    this.pendingChunks.unshift(samples);
    this.pendingSamples += samples.length;
  }

  private sendAudioMessage(ws: WebSocket, samples: Int16Array<ArrayBuffer>): void {
    ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: base64FromInt16(samples),
            mimeType: `audio/pcm;rate=${this.sendRate}`
          }
        }
      })
    );
  }

  private handleWorkletMessage(data: unknown): void {
    if (
      data &&
      typeof data === 'object' &&
      'type' in data &&
      (data as { type?: unknown }).type === 'flushed'
    ) {
      const resolve = this.workletFlushResolver;
      this.workletFlushResolver = null;
      resolve?.();
      return;
    }
    if (data instanceof Float32Array) {
      this.handleCapturedAudio(data as Float32Array<ArrayBuffer>);
    }
  }

  private async beginFinishInput(): Promise<void> {
    const worklet = this.worklet;
    if (worklet) {
      await Promise.race([
        new Promise<void>((resolve) => {
          this.workletFlushResolver = resolve;
          worklet.port.postMessage({ type: 'flush' });
        }),
        new Promise<void>((resolve) => globalThis.setTimeout(resolve, WORKLET_FLUSH_TIMEOUT_MS))
      ]);
      this.workletFlushResolver = null;
    }
    if (this.stopped) return;
    this.captureClosed = true;
    this.trySendInputEnd();
  }

  private trySendInputEnd(): void {
    if (!this.captureClosed || this.inputEndSent || this.stopped) return;
    if (this.handoffInputPaused || this.handoffWs !== null) return;
    const ws = this.ws;
    if (!this.connectionReady || ws?.readyState !== WS_OPEN_STATE) return;
    this.flushPendingAudio(ws, true);
    if (
      this.pendingSamples > 0 ||
      this.ws !== ws ||
      !this.connectionReady ||
      ws.readyState !== WS_OPEN_STATE
    ) {
      return;
    }
    try {
      ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      this.inputEndSent = true;
    } catch (error) {
      console.warn('[live-translate] Audio-Ende konnte nicht gesendet werden:', error);
      this.restartSocketImmediately(
        ws,
        'Letzten Satz sichern · verbinde neu…',
        'audio end send failed',
        4002
      );
    }
  }

  private maybeResolveFinishInput(): void {
    if (
      !this.finishResolver ||
      !this.finishTimedOut ||
      this.playingSources.size > 0 ||
      this.playbackTurn !== null
    ) {
      return;
    }
    this.resolveFinishInput();
  }

  private resolveFinishInput(): void {
    if (this.finishTimer !== null) globalThis.clearTimeout(this.finishTimer);
    this.finishTimer = null;
    if (this.finishForceTimer !== null) globalThis.clearTimeout(this.finishForceTimer);
    this.finishForceTimer = null;
    this.finishTimedOut = false;
    const resolve = this.finishResolver;
    this.finishResolver = null;
    resolve?.();
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) globalThis.clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearHandoffConnectTimer(): void {
    if (this.handoffConnectTimer !== null) globalThis.clearTimeout(this.handoffConnectTimer);
    this.handoffConnectTimer = null;
  }

  private clearStableConnectionTimer(): void {
    if (this.stableConnectionTimer !== null) globalThis.clearTimeout(this.stableConnectionTimer);
    this.stableConnectionTimer = null;
  }

  private schedulePendingFlush(ws: WebSocket): void {
    if (this.pendingFlushTimer !== null || this.stopped) return;
    this.pendingFlushTimer = globalThis.setTimeout(() => {
      this.pendingFlushTimer = null;
      if (ws !== this.ws || !this.connectionReady || ws.readyState !== WS_OPEN_STATE) return;
      this.flushPendingAudio(ws, this.captureClosed);
      this.trySendInputEnd();
    }, HANDOFF_SEND_PUMP_MS);
  }

  private finishHandoffDrain(): void {
    if (!this.handoffDrainActive) return;
    const fullChunkSamples = samplesForDuration(this.sendRate, SEND_CHUNK_MS);
    if (this.pendingSamples >= fullChunkSamples || (this.captureClosed && this.pendingSamples > 0)) {
      return;
    }
    this.handoffDrainActive = false;
    if (this.pendingFlushTimer !== null) globalThis.clearTimeout(this.pendingFlushTimer);
    this.pendingFlushTimer = null;
    this.setReady(true);
    this.opts.onStatus(this.runningStatus());
  }

  private armStableConnectionReset(): void {
    this.clearStableConnectionTimer();
    this.stableConnectionTimer = globalThis.setTimeout(() => {
      this.stableConnectionTimer = null;
      this.reconnectAttempts = 0;
    }, RECONNECT_STABLE_RESET_MS);
  }

  private isKnownSocket(ws: WebSocket): boolean {
    return ws === this.ws || ws === this.handoffWs;
  }

  private abandonHandoff(candidate: WebSocket): void {
    if (this.handoffWs !== candidate) return;
    this.clearHandoffConnectTimer();
    this.handoffWs = null;
  }

  private retryHandoffWithUpdatedSetup(candidate: WebSocket, status: string): void {
    if (candidate !== this.handoffWs) return;
    this.abandonHandoff(candidate);
    this.opts.onStatus(status);
    try {
      if (
        candidate.readyState === WS_CONNECTING_STATE ||
        candidate.readyState === WS_OPEN_STATE
      ) {
        candidate.close(1000, 'handoff setup refresh');
      }
    } catch {
      // Der aktive Socket läuft weiter; der neue Kandidat startet unten.
    }
    this.handoffRetryTimer = globalThis.setTimeout(() => {
      this.handoffRetryTimer = null;
      this.openHandoffSocket();
    }, 0);
  }

  private promoteHandoff(candidate: WebSocket): void {
    if (this.stopped || candidate !== this.handoffWs) return;
    const old = this.ws;
    this.clearHandoffConnectTimer();
    if (this.handoffRetryTimer !== null) globalThis.clearTimeout(this.handoffRetryTimer);
    this.handoffRetryTimer = null;
    if (this.pendingFlushTimer !== null) globalThis.clearTimeout(this.pendingFlushTimer);
    this.pendingFlushTimer = null;
    if (this.reconnectTimer !== null) globalThis.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.handoffWs = null;
    this.ws = candidate;
    if (this.captureClosed) {
      // Der Nachfolger erhält ein eigenes Stream-Ende. Ein zuvor nur an den
      // alten Transport gesendetes Ende darf nicht vorausgesetzt werden.
      this.inputEndSent = false;
    }
    this.connectionReady = true;
    this.handoffInputPaused = false;
    this.handoffDrainActive = this.pendingSamples > 0;
    this.setReady(!this.handoffDrainActive);
    this.armStableConnectionReset();
    this.opts.onStatus(
      this.handoffDrainActive
        ? 'Gemini-Sitzung verbunden · Audio wird aufgeholt…'
        : this.runningStatus()
    );
    this.flushPendingAudio(candidate, this.captureClosed);
    this.trySendInputEnd();
    if (old && old !== candidate) {
      try {
        if (old.readyState === WS_CONNECTING_STATE || old.readyState === WS_OPEN_STATE) {
          old.close(1000, 'goAway handoff');
        }
      } catch (error) {
        console.warn('[live-translate] Alte Gemini-Sitzung konnte nicht geschlossen werden:', error);
      }
    }
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    this.opts.onReadyChange(ready);
  }

  private setConnectionReady(ready: boolean): void {
    this.connectionReady = ready;
    this.setReady(ready);
  }

  private runningStatus(): string {
    return this.transcriptionPlacement === 'disabled'
      ? 'Übersetzung läuft (Gemini, Untertitel-Transkript nicht verfügbar)'
      : 'Übersetzung läuft (Gemini)';
  }

  private scheduleTranscriptionFallback(
    closeCode: number,
    serverReason: string,
    logReason: string
  ): boolean {
    const fallback = nextTranscriptionPlacement(
      this.transcriptionPlacement,
      closeCode,
      serverReason
    );
    if (!fallback || (fallback === 'disabled' && !this.opts.canContinueWithoutTranscript())) {
      return false;
    }
    this.clearConnectTimer();
    this.prepareForReconnect();
    this.transcriptionPlacement = fallback;
    const status =
      fallback === 'disabled'
        ? 'Gemini verbindet ohne Untertitel-Transkript neu…'
        : 'Gemini passt das Transkript-Protokoll an…';
    console.warn(`[live-translate] ${status} (${logReason})`);
    this.opts.onStatus(status);
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, 250);
    return true;
  }

  private scheduleSessionManagementFallback(
    closeCode: number,
    serverReason: string,
    logReason: string
  ): boolean {
    const feature = rejectedSessionManagementFeature(closeCode, serverReason);
    if (!feature || !this.disableSessionManagementFeature(feature)) return false;
    this.clearTimers();
    this.prepareForReconnect();
    const status =
      feature === 'resumption'
        ? 'Gemini unterstützt die Sitzungsfortsetzung hier nicht · verbinde frisch neu…'
        : 'Gemini verbindet ohne Kontextkompression neu…';
    console.warn(`[live-translate] ${status} (${logReason})`);
    this.opts.onStatus(status);
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, 0);
    return true;
  }

  private disableSessionManagementFeature(feature: SessionManagementFeature): boolean {
    if (feature === 'resumption') {
      if (!this.sessionResumptionEnabled) return false;
      this.sessionResumptionEnabled = false;
      this.resumptionHandle = null;
      return true;
    }
    if (!this.contextCompressionEnabled) return false;
    this.contextCompressionEnabled = false;
    return true;
  }

  private clearTimers(): void {
    this.clearConnectTimer();
    this.clearHandoffConnectTimer();
    this.clearStableConnectionTimer();
    if (this.reconnectTimer !== null) globalThis.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.handoffRetryTimer !== null) globalThis.clearTimeout(this.handoffRetryTimer);
    this.handoffRetryTimer = null;
    if (this.pendingFlushTimer !== null) globalThis.clearTimeout(this.pendingFlushTimer);
    this.pendingFlushTimer = null;
  }

  private clearInputQueue(): void {
    this.dropPendingSamples(this.pendingSamples);
    this.pendingChunks = [];
  }

  private prepareForReconnect(): void {
    this.setConnectionReady(false);
    this.preprocessor.reset();
    if (this.captureClosed) {
      // audioStreamEnd ist nicht quittiert. Nach einer unerwarteten Trennung
      // muss die fortgesetzte Sitzung das Endsignal erneut erhalten.
      this.inputEndSent = false;
    }
    // Bereits empfangene Übersetzung bleibt gültig. Nur ein ausdrückliches
    // serverContent.interrupted darf sie verwerfen; ein Transportwechsel soll
    // kein halbes Wort hart abschneiden.
    this.trimReconnectPlaybackLead();
    this.transcriptTurns.finalizeNow();
  }

  private trimReconnectPlaybackLead(): void {
    const now = Number.isFinite(this.opts.ctx.currentTime) ? this.opts.ctx.currentTime : 0;
    const cutoff = now + MAX_RECONNECT_PLAYBACK_LEAD_S;
    if (this.nextPlayTime <= cutoff) return;
    const affectedTurns = new Set<PlaybackTurn>();
    for (const [source, schedule] of this.sourceSchedule) {
      if (schedule.endTime <= cutoff) continue;
      affectedTurns.add(schedule.turn);
      try {
        source.stop(schedule.startTime >= cutoff ? now : cutoff);
      } catch {
        // Bereits beendet oder schon mit einem früheren Stop-Zeitpunkt versehen.
      }
    }
    for (const turn of affectedTurns) {
      const fadeStart = Math.max(now, cutoff - GEMINI_INTERRUPT_FADE_S);
      fadeOutAudioParam(turn.gain.gain, fadeStart, cutoff);
      turn.endTime = Math.min(turn.endTime, cutoff);
      turn.closed = true;
      if (this.playbackTurn === turn) this.playbackTurn = null;
    }
    // Auch in synthetischen Tests oder nach bereits gelaufenen onended-Events
    // kann nextPlayTime noch weiter vorn liegen als die Schedule-Map.
    this.nextPlayTime = cutoff;
  }

  private restartSocketImmediately(
    ws: WebSocket,
    status: string,
    closeReason: string,
    closeCode: number,
    preserveSession = true
  ): void {
    if (this.stopped || ws !== this.ws) return;
    this.clearTimers();
    if (!preserveSession) this.resumptionHandle = null;
    this.ws = null;
    this.prepareForReconnect();
    console.warn(`[live-translate] ${status}`);
    this.opts.onStatus(status);
    try {
      if (ws.readyState === WS_CONNECTING_STATE || ws.readyState === WS_OPEN_STATE) {
        ws.close(closeCode, closeReason);
      }
    } catch (error) {
      console.warn('[live-translate] Alte Gemini-Verbindung konnte nicht geschlossen werden:', error);
    }
    // Nächster Event-Loop-Takt statt generischem 2-s-Backoff. Bis
    // setupComplete bleibt Ducking garantiert fail-open.
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, 0);
  }

  private clearPlaybackQueue(): void {
    for (const source of this.playingSources) {
      try {
        source.stop();
      } catch {
        // Bereits beendet.
      }
    }
    this.playingSources.clear();
    this.sourceSchedule.clear();
    for (const turn of this.playbackTurns) turn.gain.disconnect();
    this.playbackTurns.clear();
    this.playbackTurn = null;
    this.nextPlayTime = 0;
  }
}
