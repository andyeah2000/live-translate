import * as ort from 'onnxruntime-web/wasm';
import { SpeechPreprocessor } from './pcm';
import {
  hasCaptureDiscontinuity,
  outputFrameEndTime,
  pushBoundedFifo,
  type CaptureStamp
} from './vad-timing';

const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 512;
const CONTEXT_SAMPLES = 64;
const STATE_SIZE = 2 * 1 * 128;
const MAX_QUEUED_AUDIO_BLOCKS = 2;

type IncomingMessage =
  | { type: 'init'; modelUrl: string; wasmBaseUrl: string; inputSampleRate: number }
  | { type: 'audio'; samples: ArrayBuffer; sequence: number; captureEndTime: number };

type OutgoingMessage =
  | { type: 'ready' }
  | { type: 'probability'; value: number; sequence: number; frameEndTime: number }
  | { type: 'discontinuity'; sequence: number }
  | { type: 'error'; detail: string };

declare const self: {
  onmessage: ((event: MessageEvent<IncomingMessage>) => void) | null;
  postMessage(message: OutgoingMessage): void;
};

let session: ort.InferenceSession | null = null;
let state = emptyState();
let context = new Float32Array(CONTEXT_SAMPLES);
let inferenceQueue: Promise<void> = Promise.resolve();
let failed = false;
let preprocessor: SpeechPreprocessor | null = null;
let sourceSampleRate = 0;
let frame = new Float32Array(FRAME_SAMPLES);
let frameOffset = 0;
let audioProcessing = false;
const audioQueue: Array<{
  samples: ArrayBuffer;
  sequence: number;
  captureEndTime: number;
}> = [];
let lastCapture: CaptureStamp | null = null;

self.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'init') {
    inferenceQueue = inferenceQueue
      .then(() => initialize(message.modelUrl, message.wasmBaseUrl, message.inputSampleRate))
      .catch(reportError);
  } else if (message.type === 'audio') {
    enqueueAudio(message.samples, message.sequence, message.captureEndTime);
  }
};

async function initialize(
  modelUrl: string,
  wasmBaseUrl: string,
  inputRate: number
): Promise<void> {
  ort.env.logLevel = 'error';
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = wasmBaseUrl;
  session = await ort.InferenceSession.create(modelUrl, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  });
  // Erste Inferenz kompiliert/optimiert den Graphen. Vor dem echten Audiostrom
  // einmal aufwärmen und den rekurrenten Zustand danach deterministisch leeren.
  await infer(new Float32Array(FRAME_SAMPLES));
  sourceSampleRate = inputRate;
  lastCapture = null;
  resetPipeline();
  self.postMessage({ type: 'ready' });
}

function enqueueAudio(samples: ArrayBuffer, sequence: number, captureEndTime: number): void {
  if (failed) return;
  // Maximal zwei wartende Blöcke. Bei Überlast bleibt die Reihenfolge der
  // neuesten Daten erhalten; die entstehende Sequenzlücke wird beim Drain als
  // Discontinuity erkannt und setzt Modell sowie Hauptthread fail-open zurück.
  pushBoundedFifo(
    audioQueue,
    { samples, sequence, captureEndTime },
    MAX_QUEUED_AUDIO_BLOCKS
  );
  if (!audioProcessing) void drainAudio();
}

async function drainAudio(): Promise<void> {
  if (audioProcessing || failed) return;
  audioProcessing = true;
  try {
    while (audioQueue.length > 0 && !failed) {
      const next = audioQueue.shift();
      if (!next) continue;
      const capture: CaptureStamp = {
        sequence: next.sequence,
        captureEndTime: next.captureEndTime,
        sampleCount: next.samples.byteLength / Float32Array.BYTES_PER_ELEMENT
      };
      if (hasCaptureDiscontinuity(lastCapture, capture, sourceSampleRate)) {
        resetPipeline();
        self.postMessage({ type: 'discontinuity', sequence: next.sequence });
      }
      lastCapture = capture;
      await processAudio(next.samples, next.sequence, next.captureEndTime);
    }
  } catch (error) {
    reportError(error);
  } finally {
    audioProcessing = false;
    if (audioQueue.length > 0 && !failed) void drainAudio();
  }
}

async function processAudio(
  buffer: ArrayBuffer,
  sequence: number,
  captureEndTime: number
): Promise<void> {
  if (!session || !preprocessor || failed) return;
  const samples = preprocessor.process(new Float32Array(buffer));
  let offset = 0;
  while (offset < samples.length) {
    const count = Math.min(samples.length - offset, FRAME_SAMPLES - frameOffset);
    frame.set(samples.subarray(offset, offset + count), frameOffset);
    frameOffset += count;
    offset += count;
    if (frameOffset === FRAME_SAMPLES) {
      const value = await infer(frame);
      const frameEndTime = outputFrameEndTime(
        captureEndTime,
        samples.length,
        offset,
        SAMPLE_RATE
      );
      self.postMessage({ type: 'probability', value, sequence, frameEndTime });
      frame = new Float32Array(FRAME_SAMPLES);
      frameOffset = 0;
    }
  }
}

async function infer(samples: Float32Array): Promise<number> {
  if (!session) return 0;
  const input = new Float32Array(CONTEXT_SAMPLES + FRAME_SAMPLES);
  input.set(context, 0);
  input.set(samples, CONTEXT_SAMPLES);
  const results = await session.run({
    input: new ort.Tensor('float32', input, [1, input.length]),
    state,
    sr: new ort.Tensor('int64', BigInt64Array.of(BigInt(SAMPLE_RATE)), [])
  });
  const output = results.output;
  const nextState = results.stateN;
  if (!output || !nextState) throw new Error('Silero VAD lieferte unvollständige Ausgaben.');
  state = nextState;
  context = samples.slice(FRAME_SAMPLES - CONTEXT_SAMPLES);
  const value = Number(output.data[0] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function emptyState(): ort.Tensor {
  return new ort.Tensor('float32', new Float32Array(STATE_SIZE), [2, 1, 128]);
}

function resetModelState(): void {
  state = emptyState();
  context = new Float32Array(CONTEXT_SAMPLES);
  frame = new Float32Array(FRAME_SAMPLES);
  frameOffset = 0;
}

function resetPipeline(): void {
  resetModelState();
  // Kein aggressiver Sprach-Bandpass: Auch tiefe Stimmen bleiben für Silero
  // vollständig erhalten. Der hörbare Originalpfad wird ohnehin nie berührt.
  preprocessor = new SpeechPreprocessor(sourceSampleRate, { highpass: false });
}

function reportError(error: unknown): void {
  if (failed) return;
  failed = true;
  audioQueue.length = 0;
  self.postMessage({
    type: 'error',
    detail: error instanceof Error ? error.message : String(error)
  });
}
