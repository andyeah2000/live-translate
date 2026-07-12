import assert from 'node:assert/strict';
import test from 'node:test';
import { NeuralVoiceDetector, isFreshCapture } from '../src/offscreen/neural-vad';

test('stale, invalid and future VAD results are rejected fail-open', () => {
  assert.equal(isFreshCapture(10, 10), true);
  assert.equal(isFreshCapture(10, 10.25), true);
  assert.equal(isFreshCapture(10, 10.251), false);
  assert.equal(isFreshCapture(10.001, 10), false);
  assert.equal(isFreshCapture(Number.NaN, 10), false);
});

type MockWorkerMessage =
  | { type: 'ready' }
  | { type: 'error'; detail: string };

class LifecycleWorker {
  static latest: LifecycleWorker | null = null;
  static onInit: ((worker: LifecycleWorker) => void) | null = null;

  onmessage: ((event: MessageEvent<MockWorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;

  constructor(_url: string) {
    LifecycleWorker.latest = this;
  }

  postMessage(message: { type?: string }): void {
    if (message.type === 'init') LifecycleWorker.onInit?.(this);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: MockWorkerMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<MockWorkerMessage>);
  }
}

function installLifecycleGlobals(): () => void {
  const names = ['window', 'chrome', 'Worker', 'AudioWorkletNode'] as const;
  const descriptors = new Map(
    names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  );
  Object.defineProperties(globalThis, {
    window: {
      configurable: true,
      value: {
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        setInterval: globalThis.setInterval.bind(globalThis),
        clearInterval: globalThis.clearInterval.bind(globalThis)
      }
    },
    chrome: {
      configurable: true,
      value: { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } }
    },
    Worker: { configurable: true, value: LifecycleWorker },
    AudioWorkletNode: {
      configurable: true,
      value: class {
        constructor() {
          throw new Error('AudioWorkletNode darf nach terminalem Startfehler nicht entstehen.');
        }
      }
    }
  });
  return () => {
    for (const name of names) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    LifecycleWorker.latest = null;
    LifecycleWorker.onInit = null;
  };
}

function createLifecycleDetector(
  addModule: () => Promise<void>,
  errors: string[]
): NeuralVoiceDetector {
  const ctx = {
    sampleRate: 48_000,
    currentTime: 10,
    audioWorklet: { addModule },
    destination: {}
  } as unknown as AudioContext;
  return new NeuralVoiceDetector({
    ctx,
    source: {} as AudioNode,
    onSpeechChange: () => {},
    onError: (detail) => errors.push(detail)
  });
}

test('a worker error during addModule rejects start instead of reporting ready', async () => {
  const restore = installLifecycleGlobals();
  let releaseModule!: () => void;
  let markModuleStarted!: () => void;
  const moduleGate = new Promise<void>((resolve) => {
    releaseModule = resolve;
  });
  const moduleStarted = new Promise<void>((resolve) => {
    markModuleStarted = resolve;
  });
  const errors: string[] = [];
  try {
    LifecycleWorker.onInit = (worker) => queueMicrotask(() => worker.emit({ type: 'ready' }));
    const detector = createLifecycleDetector(() => {
      markModuleStarted();
      return moduleGate;
    }, errors);
    const starting = detector.start();
    await moduleStarted;
    LifecycleWorker.latest?.emit({ type: 'error', detail: 'VAD worker failed' });
    releaseModule();
    await assert.rejects(starting, /VAD worker failed/);
    assert.deepEqual(errors, ['VAD worker failed']);
    assert.equal(LifecycleWorker.latest?.terminated, true);
  } finally {
    releaseModule?.();
    restore();
  }
});

test('stop during worker initialization rejects start immediately', async () => {
  const restore = installLifecycleGlobals();
  try {
    const detector = createLifecycleDetector(async () => {}, []);
    const starting = detector.start();
    detector.stop();
    await assert.rejects(starting, /gestoppt/);
    assert.equal(LifecycleWorker.latest?.terminated, true);
  } finally {
    restore();
  }
});
