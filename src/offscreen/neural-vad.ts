import { SpeechProbabilityDetector } from './voice-detector';

const READY_TIMEOUT_MS = 20_000;
const STALE_FAIL_OPEN_SECONDS = 0.25;
const STALE_FAIL_OPEN_MS = STALE_FAIL_OPEN_SECONDS * 1_000;
const STALE_ERROR_MS = 3_000;

export function isFreshCapture(frameEndTime: number, currentTime: number): boolean {
  const age = currentTime - frameEndTime;
  return Number.isFinite(age) && age >= 0 && age <= STALE_FAIL_OPEN_SECONDS;
}

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'probability'; value: number; sequence: number; frameEndTime: number }
  | { type: 'discontinuity'; sequence: number }
  | { type: 'error'; detail: string };

export interface NeuralVoiceDetectorOptions {
  ctx: AudioContext;
  source: AudioNode;
  onSpeechChange(speaking: boolean, probability: number): void;
  onError(detail: string): void;
}

/** Kontinuierliche lokale Silero-v6.2-VAD auf 32-ms-/16-kHz-Frames. */
export class NeuralVoiceDetector {
  private worker: Worker | null = null;
  private worklet: AudioWorkletNode | null = null;
  private silentSink: GainNode | null = null;
  private readonly detector = new SpeechProbabilityDetector();
  private speaking = false;
  private stopped = false;
  private lastProbabilityAt = 0;
  private lastSequence: number | null = null;
  private watchdog: number | null = null;
  private abortStart: ((error: Error) => void) | null = null;
  private terminalError: Error | null = null;

  constructor(private readonly opts: NeuralVoiceDetectorOptions) {}

  async start(): Promise<void> {
    this.assertRunning();
    try {
      const worker = new Worker(chrome.runtime.getURL('vad-worker.js'));
      this.worker = worker;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer: number | null = null;
        const settle = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (timer !== null) window.clearTimeout(timer);
          this.abortStart = null;
          if (error) reject(error);
          else resolve();
        };
        this.abortStart = (error) => settle(error);
        timer = window.setTimeout(() => {
          settle(new Error('Zeitüberschreitung beim Laden der lokalen Silero-VAD.'));
        }, READY_TIMEOUT_MS);
        worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
          const message = event.data;
          if (message.type === 'ready') settle();
          else if (message.type === 'error') settle(new Error(message.detail));
        };
        worker.onerror = (event) =>
          settle(new Error(event.message || 'Lokale VAD ist abgestürzt.'));
        worker.postMessage({
          type: 'init',
          modelUrl: chrome.runtime.getURL('vad/silero_vad_16k_op15.onnx'),
          wasmBaseUrl: chrome.runtime.getURL('ort/'),
          inputSampleRate: this.opts.ctx.sampleRate
        });
      });

      this.assertRunning();
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;
        if (message.type === 'probability') {
          this.handleProbability(message.value, message.sequence, message.frameEndTime);
        } else if (message.type === 'discontinuity') {
          this.handleDiscontinuity(message.sequence);
        } else if (message.type === 'error') {
          this.fail(message.detail);
        }
      };
      worker.onerror = (event) => this.fail(event.message || 'Lokale VAD ist abgestürzt.');
      await this.opts.ctx.audioWorklet.addModule(
        chrome.runtime.getURL('vad-capture-worklet.js')
      );
      // Ein Workerfehler oder stop() während addModule darf niemals als
      // erfolgreicher Start bis zum Aufrufer durchsickern.
      this.assertRunning();
      const worklet = new AudioWorkletNode(this.opts.ctx, 'vad-pcm-capture');
      const silentSink = this.opts.ctx.createGain();
      silentSink.gain.value = 0;
      this.opts.source.connect(worklet).connect(silentSink).connect(this.opts.ctx.destination);
      worklet.port.onmessage = (event) => {
        const { samples, sequence, captureEndTime } = event.data as {
          samples: Float32Array<ArrayBuffer>;
          sequence: number;
          captureEndTime: number;
        };
        this.worker?.postMessage(
          { type: 'audio', samples: samples.buffer, sequence, captureEndTime },
          [samples.buffer]
        );
      };
      this.worklet = worklet;
      this.silentSink = silentSink;
      this.lastProbabilityAt = performance.now();
      this.watchdog = window.setInterval(() => {
        if (this.stopped) return;
        const staleFor = performance.now() - this.lastProbabilityAt;
        if (staleFor > STALE_FAIL_OPEN_MS) this.resetFailOpen();
        if (staleFor > STALE_ERROR_MS) this.fail('Lokale VAD liefert keine Audiodaten mehr.');
      }, STALE_FAIL_OPEN_MS / 2);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      const terminal = this.terminalError ?? normalized;
      this.terminalError = terminal;
      if (!this.stopped) this.stop();
      throw terminal;
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.terminalError ??= new Error('Lokale VAD wurde gestoppt.');
    const abortStart = this.abortStart;
    this.abortStart = null;
    abortStart?.(this.terminalError);
    if (this.watchdog !== null) window.clearInterval(this.watchdog);
    this.watchdog = null;
    try {
      if (this.worklet) this.opts.source.disconnect(this.worklet);
    } catch {
      // Der AudioContext kann während des Fehlerpfads bereits geschlossen sein.
    }
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.disconnect();
    }
    this.silentSink?.disconnect();
    this.worklet = null;
    this.silentSink = null;
    this.worker?.terminate();
    this.worker = null;
    this.lastSequence = null;
    this.resetFailOpen();
  }

  private handleProbability(value: number, sequence: number, frameEndTime: number): void {
    if (this.stopped) return;
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      (this.lastSequence !== null && sequence < this.lastSequence)
    ) {
      this.lastSequence = null;
      this.resetFailOpen();
      return;
    }
    this.lastSequence = sequence;
    if (!isFreshCapture(frameEndTime, this.opts.ctx.currentTime)) {
      this.resetFailOpen();
      return;
    }
    this.lastProbabilityAt = performance.now();
    const decision = this.detector.update(value);
    this.setSpeaking(decision.speaking, decision.probability);
  }

  private handleDiscontinuity(sequence: number): void {
    if (this.stopped) return;
    this.lastSequence = Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
    this.lastProbabilityAt = performance.now();
    this.resetFailOpen();
  }

  private resetFailOpen(): void {
    this.detector.reset();
    this.setSpeaking(false, 0);
  }

  private setSpeaking(speaking: boolean, probability: number): void {
    if (speaking === this.speaking) return;
    this.speaking = speaking;
    this.opts.onSpeechChange(speaking, probability);
  }

  private fail(detail: string): void {
    if (this.stopped) return;
    this.terminalError = new Error(detail);
    this.resetFailOpen();
    this.stop();
    this.opts.onError(detail);
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw this.terminalError ?? new Error('Lokale VAD wurde vor dem Start gestoppt.');
    }
  }
}
