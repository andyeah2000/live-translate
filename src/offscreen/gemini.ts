import { SpeechPreprocessor, base64FromInt16, floatToInt16, int16FromBase64, int16ToFloat } from './pcm';
import {
  GEMINI_FADE_IN_S,
  GEMINI_INTERRUPT_FADE_S,
  GEMINI_FADE_OUT_S,
  applyCosineEdgeFades,
  fadeOutAudioParam,
  rampAudioParam
} from './audio-envelope';

const WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const MODEL = 'models/gemini-3.5-live-translate-preview';
const OUTPUT_SAMPLE_RATE = 24000;
const WS_CONNECTING_STATE = 0;
const WS_OPEN_STATE = 1;
// Die Live-API erwartet Audio-Chunks von ~100 ms.
const SEND_CHUNK_MS = 100;
const MAX_RECONNECTS = 8;
const CONNECT_TIMEOUT_MS = 15_000;
const INPUT_PCM_BYTES_PER_SECOND = 16_000 * Int16Array.BYTES_PER_ELEMENT;
const BASE64_AUDIO_BYTES_PER_SECOND = (INPUT_PCM_BYTES_PER_SECOND * 4) / 3;
/** Maximal tolerierter lokaler WebSocket-Rückstau, bevor frisch neu verbunden wird. */
export const MAX_BUFFERED_AUDIO_MS = 750;
export const MAX_BUFFERED_BYTES = Math.floor(
  (BASE64_AUDIO_BYTES_PER_SECOND * MAX_BUFFERED_AUDIO_MS) / 1_000
);
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

interface GeminiServerMessage {
  setupComplete?: unknown;
  goAway?: { timeLeft?: unknown };
  sessionResumptionUpdate?: { newHandle?: unknown; resumable?: unknown };
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> };
    outputTranscription?: { text?: string };
    interrupted?: boolean;
    turnComplete?: boolean;
  };
  error?: { message?: string };
}

export type TranscriptionPlacement = 'setup' | 'generation' | 'disabled';

export interface GeminiSessionSetup {
  enabled?: boolean;
  resumptionHandle?: string | null;
}

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
  if (session.enabled !== false) {
    setup.sessionResumption = session.resumptionHandle
      ? { handle: session.resumptionHandle }
      : {};
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
  return (
    closeCode === 1007 &&
    /session.?resumption|context.?window.?compression/i.test(reason)
  );
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
  private worklet: AudioWorkletNode | null = null;
  private silentSink: GainNode | null = null;
  private ready = false;
  private connectionReady = false;
  private stopped = false;
  private reconnectAttempts = 0;
  private pendingChunks: Int16Array[] = [];
  private pendingSamples = 0;
  private nextPlayTime = 0;
  private reconnectTimer: number | null = null;
  private connectTimer: number | null = null;
  private transcriptionPlacement: TranscriptionPlacement = 'setup';
  private sessionManagementEnabled = true;
  private resumptionHandle: string | null = null;
  private readonly playingSources = new Set<AudioBufferSourceNode>();
  private readonly playbackTurns = new Set<PlaybackTurn>();
  private playbackTurn: PlaybackTurn | null = null;
  private readonly preprocessor: SpeechPreprocessor;
  private readonly transcriptTurns: TranscriptTurnCoordinator;
  private readonly sendRate = 16000;

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

    await ctx.audioWorklet.addModule(chrome.runtime.getURL('worklet.js'));
    if (this.stopped) return;
    this.worklet = new AudioWorkletNode(ctx, 'pcm-capture');
    // Der Worklet liefert nur Daten, wenn er mit dem Graphen verbunden ist;
    // der stumme Gain verhindert, dass das Original doppelt hörbar wird.
    this.silentSink = ctx.createGain();
    this.silentSink.gain.value = 0;
    modelSource.connect(this.worklet);
    this.worklet.connect(this.silentSink).connect(ctx.destination);
    this.worklet.port.onmessage = (event) =>
      this.handleCapturedAudio(event.data as Float32Array<ArrayBuffer>);

    this.openSocket();
  }

  stop(): void {
    this.stopped = true;
    this.setConnectionReady(false);
    this.clearTimers();
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
    if (ws?.readyState === WS_CONNECTING_STATE) {
      // close() wirft im CONNECTING-Zustand. Sobald der Handshake doch noch
      // fertig wird, sofort schließen und niemals mehr Setup-Daten senden.
      ws.onopen = () => ws.close(1000, 'client stop');
    } else if (ws?.readyState === WS_OPEN_STATE) {
      ws.close(1000, 'client stop');
    }
    this.ws = null;
  }

  private openSocket(): void {
    if (this.stopped) return;
    this.setConnectionReady(false);
    this.clearInputQueue();
    this.preprocessor.reset();
    this.clearPlaybackQueue();
    this.clearConnectTimer();

    const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(this.opts.apiKey)}`);
    this.ws = ws;
    this.connectTimer = globalThis.setTimeout(() => {
      if (this.ws !== ws || this.ready) return;
      if (ws.readyState === WS_CONNECTING_STATE) {
        ws.onopen = () => ws.close(4000, 'setup timeout');
      } else if (ws.readyState === WS_OPEN_STATE) {
        ws.close(4000, 'setup timeout');
      }
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      ws.send(
        JSON.stringify(
          createGeminiSetup(this.opts.targetLanguage, this.transcriptionPlacement, {
            enabled: this.sessionManagementEnabled,
            resumptionHandle: this.resumptionHandle
          })
        )
      );
    };
    ws.onmessage = (event) =>
      void this.handleServerMessage(ws, event.data as string | Blob | ArrayBuffer);
    ws.onclose = (event) => this.handleClose(ws, event);
  }

  private handleClose(ws: WebSocket, event: CloseEvent): void {
    if (this.stopped || ws !== this.ws) return;
    this.clearConnectTimer();
    this.ws = null;
    this.prepareForReconnect();
    const reason = `Code ${event.code}${event.reason ? `: ${event.reason}` : ''}`;
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
    const delayMs = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts);
    console.warn(
      `[live-translate] Gemini getrennt (${reason}) – Reconnect ${this.reconnectAttempts}/${MAX_RECONNECTS} in ${delayMs / 1000}s`
    );
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
    const ws = this.ws;
    if (!this.connectionReady || ws?.readyState !== WS_OPEN_STATE) return;
    // Bereits wenige hundert Millisekunden Rückstau zerstören die zeitliche
    // Zuordnung zwischen Video, Ducking und Übersetzung. Die alte Verbindung
    // wird deshalb verworfen, statt ihren Puffer später noch abzuspielen.
    if (shouldRestartForBackpressure(ws.bufferedAmount)) {
      this.restartSocketImmediately(
        ws,
        `Netz überlastet (${Math.round(bufferedAudioDurationMs(ws.bufferedAmount))} ms Rückstau) · verbinde neu…`,
        'backpressure restart',
        4001,
        false
      );
      return;
    }
    const samples = this.preprocessor.process(chunk);
    if (samples.length === 0) return;
    const pcm = floatToInt16(samples);
    this.pendingChunks.push(pcm);
    this.pendingSamples += pcm.length;
    const chunkSize = (this.sendRate * SEND_CHUNK_MS) / 1000;
    while (this.pendingSamples >= chunkSize) {
      if (shouldRestartForBackpressure(ws.bufferedAmount)) {
        this.restartSocketImmediately(
          ws,
          `Netz überlastet (${Math.round(bufferedAudioDurationMs(ws.bufferedAmount))} ms Rückstau) · verbinde neu…`,
          'backpressure restart',
          4001,
          false
        );
        return;
      }
      const outgoing = this.takePendingSamples(chunkSize);
      try {
        ws.send(
          JSON.stringify({
            realtimeInput: {
              audio: {
                data: base64FromInt16(outgoing),
                mimeType: `audio/pcm;rate=${this.sendRate}`
              }
            }
          })
        );
      } catch (error) {
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
  }

  private async handleServerMessage(ws: WebSocket, data: string | Blob | ArrayBuffer): Promise<void> {
    if (this.stopped || ws !== this.ws) return;
    let text: string;
    if (typeof data === 'string') text = data;
    else if (data instanceof Blob) text = await data.text();
    else text = new TextDecoder().decode(data);
    if (this.stopped || ws !== this.ws) return;

    let msg: GeminiServerMessage;
    try {
      msg = JSON.parse(text) as GeminiServerMessage;
    } catch {
      return;
    }

    if (msg.error?.message) {
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
      // Nur ausdrücklich resumable Handles speichern. Bei einem Update mit
      // resumable=false bleibt der letzte sichere Checkpoint verwendbar.
      this.resumptionHandle = resumptionUpdate.newHandle;
      return;
    }
    if (msg.goAway !== undefined) {
      // Ein geplanter Sitzungswechsel darf nicht durch den generischen
      // exponentiellen Backoff laufen. Der letzte ausdrücklich sichere
      // Resumption-Checkpoint wird im neuen Setup direkt weiterverwendet.
      const timeLeftMs = goAwayTimeLeftMs(msg.goAway);
      const timeLeft = timeLeftMs === null ? '' : ` · ${Math.ceil(timeLeftMs / 1_000)} s Restzeit`;
      this.restartSocketImmediately(
        ws,
        `Gemini wechselt die Sitzung${timeLeft} · verbinde neu…`,
        'goAway',
        1000
      );
      return;
    }
    if (msg.setupComplete !== undefined) {
      this.setConnectionReady(true);
      this.clearConnectTimer();
      // Erfolgreich verbunden – Reconnect-Budget zurücksetzen.
      this.reconnectAttempts = 0;
      this.opts.onStatus(this.runningStatus());
      return;
    }

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
        fadeOut: content.turnComplete === true && index === audioParts.length - 1
      });
    }
    const transcript = content.outputTranscription?.text;
    if (transcript) this.transcriptTurns.push(transcript);
    if (content.turnComplete) {
      this.finishPlaybackTurn();
      this.transcriptTurns.complete();
    }
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
        edges.fadeIn ? GEMINI_FADE_IN_S : 0,
        edges.fadeOut ? GEMINI_FADE_OUT_S : 0
      );
      const buffer = ctx.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      const startAt = Math.max(ctx.currentTime + 0.05, this.nextPlayTime);
      const turn = this.playbackTurn ?? this.createPlaybackTurn(startAt, outputNode);
      node.connect(turn.gain);
      this.playingSources.add(node);
      turn.sources.add(node);
      node.onended = () => {
        this.playingSources.delete(node);
        turn.sources.delete(node);
        // Zwischen zwei verspätet eintreffenden Netzwerk-Chunks kann die
        // Source-Menge kurz leer sein. Den Turn-Bus erst nach turnComplete
        // trennen, sonst wäre der nächste Chunk desselben Satzes stumm.
        if (turn.closed && turn.sources.size === 0) {
          turn.gain.disconnect();
          this.playbackTurns.delete(turn);
        }
      };
      node.start(startAt);
      this.nextPlayTime = startAt + buffer.duration;
      turn.endTime = this.nextPlayTime;
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

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) globalThis.clearTimeout(this.connectTimer);
    this.connectTimer = null;
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
    if (
      !this.sessionManagementEnabled ||
      !isSessionManagementSchemaError(closeCode, serverReason)
    ) {
      return false;
    }
    this.clearTimers();
    this.prepareForReconnect();
    this.sessionManagementEnabled = false;
    this.resumptionHandle = null;
    const status = 'Gemini unterstützt die Sitzungsfortsetzung hier nicht · verbinde frisch neu…';
    console.warn(`[live-translate] ${status} (${logReason})`);
    this.opts.onStatus(status);
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, 0);
    return true;
  }

  private clearTimers(): void {
    this.clearConnectTimer();
    if (this.reconnectTimer !== null) globalThis.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearInputQueue(): void {
    this.pendingChunks = [];
    this.pendingSamples = 0;
  }

  private prepareForReconnect(): void {
    this.setConnectionReady(false);
    this.clearInputQueue();
    this.preprocessor.reset();
    this.clearPlaybackQueue();
    this.transcriptTurns.finalizeNow();
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
      if (ws.readyState === WS_CONNECTING_STATE) {
        ws.onopen = () => ws.close(closeCode, closeReason);
      } else if (ws.readyState === WS_OPEN_STATE) {
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
    for (const turn of this.playbackTurns) turn.gain.disconnect();
    this.playbackTurns.clear();
    this.playbackTurn = null;
    this.nextPlayTime = 0;
  }
}
