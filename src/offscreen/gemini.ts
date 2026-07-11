import { SpeechPreprocessor, base64FromInt16, floatToInt16, int16FromBase64, int16ToFloat } from './pcm';

const WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const MODEL = 'models/gemini-3.5-live-translate-preview';
const OUTPUT_SAMPLE_RATE = 24000;
// Die Live-API erwartet Audio-Chunks von ~100 ms.
const SEND_CHUNK_MS = 100;
const MAX_RECONNECTS = 8;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_BUFFERED_BYTES = 1_000_000;
const BACKPRESSURE_RECOVERY_BYTES = MAX_BUFFERED_BYTES / 2;
// Close-Codes, bei denen ein Reconnect sinnlos ist (Konfig-/Protokollfehler).
// 1008 gehört bewusst NICHT dazu: Gemini beendet damit auch reguläre
// Sitzungen nach Ablauf des Zeitlimits (goAway) – das ist reconnectbar.
const PERMANENT_CLOSE_CODES = new Set([1002, 1003, 1007]);

interface GeminiServerMessage {
  setupComplete?: unknown;
  goAway?: unknown;
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> };
    outputTranscription?: { text?: string };
    interrupted?: boolean;
    turnComplete?: boolean;
  };
  error?: { message?: string };
}

export type TranscriptionPlacement = 'setup' | 'generation' | 'disabled';

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

export function createGeminiSetup(
  targetLanguage: string,
  transcriptionPlacement: TranscriptionPlacement = 'setup'
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
  private backpressured = false;
  private stopped = false;
  private reconnectAttempts = 0;
  private pendingChunks: Int16Array[] = [];
  private pendingSamples = 0;
  private nextPlayTime = 0;
  private reconnectTimer: number | null = null;
  private connectTimer: number | null = null;
  private transcriptionPlacement: TranscriptionPlacement = 'setup';
  private readonly playingSources = new Set<AudioBufferSourceNode>();
  private readonly preprocessor: SpeechPreprocessor;
  private readonly sendRate = 16000;

  constructor(private readonly opts: GeminiTranslatorOptions) {
    // Gemini Live Translate akzeptiert ausschließlich PCM16/16 kHz. Der
    // optionale Highpass sitzt bereits im Audio-Graphen;
    // hier folgen nur Anti-Aliasing und Resampling.
    this.preprocessor = new SpeechPreprocessor(opts.ctx.sampleRate, { highpass: false });
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
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.disconnect();
      this.worklet = null;
    }
    this.silentSink?.disconnect();
    this.silentSink = null;
    const ws = this.ws;
    if (ws?.readyState === WebSocket.CONNECTING) {
      // close() wirft im CONNECTING-Zustand. Sobald der Handshake doch noch
      // fertig wird, sofort schließen und niemals mehr Setup-Daten senden.
      ws.onopen = () => ws.close(1000, 'client stop');
    } else if (ws?.readyState === WebSocket.OPEN) {
      ws.close(1000, 'client stop');
    }
    this.ws = null;
  }

  private openSocket(): void {
    if (this.stopped) return;
    this.setConnectionReady(false);
    this.pendingChunks = [];
    this.pendingSamples = 0;
    this.preprocessor.reset();
    this.clearConnectTimer();

    const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(this.opts.apiKey)}`);
    this.ws = ws;
    this.connectTimer = window.setTimeout(() => {
      if (this.ws !== ws || this.ready) return;
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.onopen = () => ws.close(4000, 'setup timeout');
      } else if (ws.readyState === WebSocket.OPEN) {
        ws.close(4000, 'setup timeout');
      }
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      ws.send(
        JSON.stringify(createGeminiSetup(this.opts.targetLanguage, this.transcriptionPlacement))
      );
    };
    ws.onmessage = (event) =>
      void this.handleServerMessage(ws, event.data as string | Blob | ArrayBuffer);
    ws.onclose = (event) => this.handleClose(ws, event);
  }

  private handleClose(ws: WebSocket, event: CloseEvent): void {
    if (this.stopped || ws !== this.ws) return;
    this.clearConnectTimer();
    this.setConnectionReady(false);
    const reason = `Code ${event.code}${event.reason ? `: ${event.reason}` : ''}`;
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
    this.reconnectTimer = window.setTimeout(() => {
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
    if (!this.connectionReady || this.ws?.readyState !== WebSocket.OPEN) return;
    // Bei einem langsamen Netz keine Sprache leise stellen, die Gemini nicht
    // erhält. Hysterese verhindert Flattern an der Puffergrenze.
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.enterBackpressure();
      return;
    }
    if (this.backpressured) {
      if (this.ws.bufferedAmount > BACKPRESSURE_RECOVERY_BYTES) return;
      this.setBackpressured(false);
      this.opts.onStatus(this.runningStatus());
    }
    const samples = this.preprocessor.process(chunk);
    if (samples.length === 0) return;
    const pcm = floatToInt16(samples);
    this.pendingChunks.push(pcm);
    this.pendingSamples += pcm.length;
    const chunkSize = (this.sendRate * SEND_CHUNK_MS) / 1000;
    while (this.pendingSamples >= chunkSize) {
      if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        this.enterBackpressure();
        break;
      }
      const outgoing = this.takePendingSamples(chunkSize);
      this.ws.send(
        JSON.stringify({
          realtimeInput: {
            audio: {
              data: base64FromInt16(outgoing),
              mimeType: `audio/pcm;rate=${this.sendRate}`
            }
          }
        })
      );
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
      if (this.scheduleTranscriptionFallback(1007, msg.error.message, msg.error.message)) {
        // Der folgende Close-Event gehört noch zur verworfenen Verbindung und
        // darf keinen zweiten Reconnect auslösen.
        this.ws = null;
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'transcription schema fallback');
        return;
      }
      this.fail(`Gemini-Fehler: ${msg.error.message}`);
      return;
    }
    if (msg.goAway !== undefined) {
      // Server kündigt das Sitzungsende an. Er erwartet, dass WIR sauber
      // schließen – sonst wirft er uns mit Code 1008 raus. Danach normal
      // neu verbinden (handleClose übernimmt).
      console.warn('[live-translate] Gemini goAway – schließe und verbinde neu.');
      this.ws?.close(1000, 'goAway');
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
      this.clearPlaybackQueue();
      this.opts.onTranscript('', true);
    }
    for (const part of content.modelTurn?.parts ?? []) {
      const audio = part.inlineData?.data;
      if (audio) this.playTranslatedAudio(audio);
    }
    const transcript = content.outputTranscription?.text;
    if (transcript) this.opts.onTranscript(transcript, false);
    if (content.turnComplete) this.opts.onTranscript('', true);
  }

  private playTranslatedAudio(base64: string): void {
    try {
      const { ctx, outputNode } = this.opts;
      const samples = int16ToFloat(int16FromBase64(base64));
      if (samples.length === 0) return;
      const buffer = ctx.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(outputNode);
      this.playingSources.add(node);
      node.onended = () => this.playingSources.delete(node);
      const startAt = Math.max(ctx.currentTime + 0.05, this.nextPlayTime);
      node.start(startAt);
      this.nextPlayTime = startAt + buffer.duration;
    } catch (err) {
      console.warn('[live-translate] Ungültigen Gemini-Audio-Chunk übersprungen:', err);
      // Fehlerhafte Audio-Chunks überspringen statt die Sitzung zu beenden.
    }
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
    if (this.connectTimer !== null) window.clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    this.opts.onReadyChange(ready);
  }

  private setConnectionReady(ready: boolean): void {
    this.connectionReady = ready;
    if (!ready) this.backpressured = false;
    this.setReady(ready && !this.backpressured);
  }

  private setBackpressured(backpressured: boolean): void {
    this.backpressured = backpressured;
    this.setReady(this.connectionReady && !backpressured);
  }

  private enterBackpressure(): void {
    if (this.backpressured) return;
    this.pendingChunks = [];
    this.pendingSamples = 0;
    this.preprocessor.reset();
    this.setBackpressured(true);
    this.opts.onStatus('Netz überlastet · Original bleibt bei 100 %');
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
    this.setConnectionReady(false);
    this.transcriptionPlacement = fallback;
    const status =
      fallback === 'disabled'
        ? 'Gemini verbindet ohne Untertitel-Transkript neu…'
        : 'Gemini passt das Transkript-Protokoll an…';
    console.warn(`[live-translate] ${status} (${logReason})`);
    this.opts.onStatus(status);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, 250);
    return true;
  }

  private clearTimers(): void {
    this.clearConnectTimer();
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
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
    this.nextPlayTime = 0;
  }
}
