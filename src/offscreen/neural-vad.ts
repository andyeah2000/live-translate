import { SpeechProbabilityDetector } from './voice-detector';

const READY_TIMEOUT_MS = 20_000;
const STALE_FAIL_OPEN_MS = 250;
const STALE_ERROR_MS = 3_000;

export function isFreshCapture(capturedAt: number, now: number): boolean {
  const age = now - capturedAt;
  return Number.isFinite(age) && age >= 0 && age <= STALE_FAIL_OPEN_MS;
}

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'probability'; value: number; capturedAt: number }
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
  private watchdog: number | null = null;

  constructor(private readonly opts: NeuralVoiceDetectorOptions) {}

  async start(): Promise<void> {
    const worker = new Worker(chrome.runtime.getURL('vad-worker.js'));
    this.worker = worker;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        settle(new Error('Zeitüberschreitung beim Laden der lokalen Silero-VAD.'));
      }, READY_TIMEOUT_MS);
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;
        if (message.type === 'ready') settle();
        else if (message.type === 'probability') {
          this.handleProbability(message.value, message.capturedAt);
        } else if (message.type === 'error') settle(new Error(message.detail));
      };
      worker.onerror = (event) => settle(new Error(event.message || 'Lokale VAD ist abgestürzt.'));
      worker.postMessage({
        type: 'init',
        modelUrl: chrome.runtime.getURL('vad/silero_vad_16k_op15.onnx'),
        wasmBaseUrl: chrome.runtime.getURL('ort/'),
        inputSampleRate: this.opts.ctx.sampleRate
      });
    });

    if (this.stopped) return;
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === 'probability') {
        this.handleProbability(message.value, message.capturedAt);
      } else if (message.type === 'error') this.fail(message.detail);
    };
    worker.onerror = (event) => this.fail(event.message || 'Lokale VAD ist abgestürzt.');
    await this.opts.ctx.audioWorklet.addModule(chrome.runtime.getURL('vad-capture-worklet.js'));
    if (this.stopped) return;
    const worklet = new AudioWorkletNode(this.opts.ctx, 'vad-pcm-capture');
    const silentSink = this.opts.ctx.createGain();
    silentSink.gain.value = 0;
    this.opts.source.connect(worklet).connect(silentSink).connect(this.opts.ctx.destination);
    worklet.port.onmessage = (event) => {
      const { samples, capturedAt } = event.data as {
        samples: Float32Array<ArrayBuffer>;
        capturedAt: number;
      };
      this.worker?.postMessage(
        { type: 'audio', samples: samples.buffer, capturedAt },
        [samples.buffer]
      );
    };
    this.worklet = worklet;
    this.silentSink = silentSink;
    this.lastProbabilityAt = performance.now();
    this.watchdog = window.setInterval(() => {
      if (this.stopped) return;
      const staleFor = performance.now() - this.lastProbabilityAt;
      if (staleFor > STALE_FAIL_OPEN_MS) {
        this.detector.reset();
        this.setSpeaking(false, 0);
      }
      if (staleFor > STALE_ERROR_MS) this.fail('Lokale VAD liefert keine Audiodaten mehr.');
    }, STALE_FAIL_OPEN_MS / 2);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
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
    this.detector.reset();
    this.setSpeaking(false, 0);
  }

  private handleProbability(value: number, capturedAt: number): void {
    if (this.stopped) return;
    if (!isFreshCapture(capturedAt, Date.now())) {
      this.detector.reset();
      this.setSpeaking(false, 0);
      return;
    }
    this.lastProbabilityAt = performance.now();
    const decision = this.detector.update(value);
    this.setSpeaking(decision.speaking, decision.probability);
  }

  private setSpeaking(speaking: boolean, probability: number): void {
    if (speaking === this.speaking) return;
    this.speaking = speaking;
    this.opts.onSpeechChange(speaking, probability);
  }

  private fail(detail: string): void {
    if (this.stopped) return;
    this.detector.reset();
    this.setSpeaking(false, 0);
    this.stop();
    this.opts.onError(detail);
  }
}
