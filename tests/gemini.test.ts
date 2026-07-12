import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GeminiTranslator,
  MAX_BUFFERED_AUDIO_MS,
  MAX_BUFFERED_BYTES,
  TRANSCRIPT_SETTLE_MS,
  TranscriptTurnCoordinator,
  bufferedAudioDurationMs,
  createGeminiSetup,
  goAwayTimeLeftMs,
  isSessionManagementSchemaError,
  nextTranscriptionPlacement,
  shouldRestartForBackpressure,
  type GeminiTranslatorOptions,
  type TimerScheduler
} from '../src/offscreen/gemini';
import { base64FromInt16 } from '../src/offscreen/pcm';

test('Gemini raw WebSocket setup supports both observed transcription schemas', () => {
  const message = createGeminiSetup('de') as {
    setup: {
      outputAudioTranscription?: unknown;
      generationConfig: Record<string, unknown>;
      sessionResumption?: unknown;
      contextWindowCompression?: unknown;
    };
  };
  assert.deepEqual(message.setup.outputAudioTranscription, {});
  assert.equal(message.setup.generationConfig.outputAudioTranscription, undefined);
  assert.equal(message.setup.generationConfig.inputAudioTranscription, undefined);
  assert.deepEqual(message.setup.generationConfig.translationConfig, {
    targetLanguageCode: 'de',
    echoTargetLanguage: false
  });
  assert.deepEqual(message.setup.sessionResumption, {});
  assert.deepEqual(message.setup.contextWindowCompression, { slidingWindow: {} });

  const documented = createGeminiSetup('de', 'generation') as {
    setup: {
      outputAudioTranscription?: unknown;
      generationConfig: Record<string, unknown>;
    };
  };
  assert.equal(documented.setup.outputAudioTranscription, undefined);
  assert.deepEqual(documented.setup.generationConfig.outputAudioTranscription, {});

  const audioOnly = createGeminiSetup('de', 'disabled') as {
    setup: {
      outputAudioTranscription?: unknown;
      generationConfig: Record<string, unknown>;
    };
  };
  assert.equal(audioOnly.setup.outputAudioTranscription, undefined);
  assert.equal(audioOnly.setup.generationConfig.outputAudioTranscription, undefined);
});

test('Gemini setup resumes a safe session handle and can disable unsupported session fields', () => {
  const resumed = createGeminiSetup('de', 'setup', {
    resumptionHandle: 'safe-checkpoint'
  }) as { setup: Record<string, unknown> };
  assert.deepEqual(resumed.setup.sessionResumption, { handle: 'safe-checkpoint' });
  assert.deepEqual(resumed.setup.contextWindowCompression, { slidingWindow: {} });

  const fallback = createGeminiSetup('de', 'setup', {
    enabled: false,
    resumptionHandle: 'must-not-leak'
  }) as { setup: Record<string, unknown> };
  assert.equal(fallback.setup.sessionResumption, undefined);
  assert.equal(fallback.setup.contextWindowCompression, undefined);
});

test('Gemini code 1007 falls back instead of killing live translation', () => {
  const setupError =
    'Invalid JSON payload. Unknown name "outputAudioTranscription" at setup';
  const generationError =
    'Invalid JSON payload. Unknown name "outputAudioTranscription" at setup.generation_config';
  assert.equal(nextTranscriptionPlacement('setup', 1007, setupError), 'generation');
  assert.equal(nextTranscriptionPlacement('generation', 1007, generationError), 'disabled');
  assert.equal(nextTranscriptionPlacement('disabled', 1007, generationError), null);
  assert.equal(nextTranscriptionPlacement('setup', 1006, setupError), null);

  assert.equal(
    isSessionManagementSchemaError(
      1007,
      'Invalid JSON payload. Unknown name "sessionResumption" at setup'
    ),
    true
  );
  assert.equal(
    isSessionManagementSchemaError(
      1007,
      'Invalid JSON payload. Unknown name "context_window_compression" at setup'
    ),
    true
  );
  assert.equal(isSessionManagementSchemaError(1006, 'sessionResumption'), false);
});

test('live backpressure threshold is small and represents audio time', () => {
  assert.ok(MAX_BUFFERED_AUDIO_MS <= 1_000);
  assert.ok(Math.abs(bufferedAudioDurationMs(MAX_BUFFERED_BYTES) - MAX_BUFFERED_AUDIO_MS) < 1);
  assert.equal(shouldRestartForBackpressure(MAX_BUFFERED_BYTES - 1), false);
  assert.equal(shouldRestartForBackpressure(MAX_BUFFERED_BYTES), true);
  assert.equal(bufferedAudioDurationMs(Number.NaN), 0);
});

test('goAway protobuf durations are parsed without assuming one JSON representation', () => {
  assert.equal(goAwayTimeLeftMs({ timeLeft: '4.25s' }), 4_250);
  assert.equal(
    goAwayTimeLeftMs({ timeLeft: { seconds: '2', nanos: 500_000_000 } }),
    2_500
  );
  assert.equal(goAwayTimeLeftMs({ timeLeft: 'not-a-duration' }), null);
  assert.equal(goAwayTimeLeftMs({}), null);
});

class FakeTimerScheduler implements TimerScheduler {
  private now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.tasks.delete(handle);
  }

  advanceBy(milliseconds: number): void {
    const target = this.now + milliseconds;
    while (true) {
      let next: [number, { at: number; callback: () => void }] | undefined;
      for (const task of this.tasks) {
        if (task[1].at <= target && (!next || task[1].at < next[1].at)) next = task;
      }
      if (!next) break;
      this.tasks.delete(next[0]);
      this.now = next[1].at;
      next[1].callback();
    }
    this.now = target;
  }
}

test('late output transcription after turnComplete is included before finalization', () => {
  const scheduler = new FakeTimerScheduler();
  const events: Array<{ text: string; final: boolean }> = [];
  const turns = new TranscriptTurnCoordinator(
    (text, final) => events.push({ text, final }),
    scheduler
  );

  turns.complete();
  scheduler.advanceBy(100);
  turns.push('Verspäteter Text');
  scheduler.advanceBy(TRANSCRIPT_SETTLE_MS - 1);
  assert.deepEqual(events, [{ text: 'Verspäteter Text', final: false }]);
  scheduler.advanceBy(1);
  assert.deepEqual(events, [
    { text: 'Verspäteter Text', final: false },
    { text: '', final: true }
  ]);
});

test('interruption cancels pending transcript finalization exactly once', () => {
  const scheduler = new FakeTimerScheduler();
  const events: Array<{ text: string; final: boolean }> = [];
  const turns = new TranscriptTurnCoordinator(
    (text, final) => events.push({ text, final }),
    scheduler
  );

  turns.push('Alt');
  turns.complete();
  turns.interrupt();
  scheduler.advanceBy(TRANSCRIPT_SETTLE_MS * 2);
  assert.deepEqual(events, [
    { text: 'Alt', final: false },
    { text: '', final: true }
  ]);
});

interface TranslatorInternals {
  ws: WebSocket | null;
  ready: boolean;
  connectionReady: boolean;
  reconnectAttempts: number;
  pendingChunks: Int16Array[];
  pendingSamples: number;
  nextPlayTime: number;
  resumptionHandle: string | null;
  sessionManagementEnabled: boolean;
  playingSources: Set<AudioBufferSourceNode>;
  playbackTurn: {
    gain: GainNode;
    sources: Set<AudioBufferSourceNode>;
    closed: boolean;
  } | null;
  handleClose(ws: WebSocket, event: CloseEvent): void;
  handleCapturedAudio(chunk: Float32Array): void;
  handleServerMessage(ws: WebSocket, data: string): Promise<void>;
}

interface TranslatorHarness {
  translator: GeminiTranslator;
  internals: TranslatorInternals;
  statuses: string[];
  readyChanges: boolean[];
  errors: string[];
}

function createTranslatorHarness(
  ctx: AudioContext = { sampleRate: 48_000 } as AudioContext,
  outputNode: AudioNode = {} as AudioNode
): TranslatorHarness {
  const statuses: string[] = [];
  const readyChanges: boolean[] = [];
  const errors: string[] = [];
  const options: GeminiTranslatorOptions = {
    apiKey: 'test-key',
    ctx,
    modelSource: {} as AudioNode,
    outputNode,
    targetLanguage: 'de',
    onTranscript: () => {},
    onStatus: (status) => statuses.push(status),
    onReadyChange: (ready) => readyChanges.push(ready),
    canContinueWithoutTranscript: () => true,
    onError: (detail) => errors.push(detail)
  };
  const translator = new GeminiTranslator(options);
  return {
    translator,
    internals: translator as unknown as TranslatorInternals,
    statuses,
    readyChanges,
    errors
  };
}

test('Gemini uses one smooth envelope across all network chunks of a spoken turn', async () => {
  const gains: Array<{
    node: GainNode;
    disconnected: number;
    events: Array<{ method: string; start: number; end?: number }>;
  }> = [];
  const sources: Array<
    AudioBufferSourceNode & { onended: (() => void) | null; connectedTo?: AudioNode }
  > = [];
  const copied: Float32Array[] = [];
  const ctx = {
    currentTime: 5,
    sampleRate: 48_000,
    createGain: () => {
      const events: Array<{ method: string; start: number; end?: number }> = [];
      const param = {
        value: 0,
        cancelAndHoldAtTime(start: number) {
          events.push({ method: 'hold', start });
        },
        setValueCurveAtTime(curve: Float32Array, start: number, duration: number) {
          events.push({ method: 'curve', start, end: start + duration });
          this.value = curve.at(-1) ?? this.value;
        },
        linearRampToValueAtTime(value: number, end: number) {
          events.push({ method: 'linear', start: end });
          this.value = value;
        },
        setValueAtTime(value: number, start: number) {
          events.push({ method: 'set', start });
          this.value = value;
        }
      } as unknown as AudioParam;
      const record = {
        node: null as unknown as GainNode,
        disconnected: 0,
        events
      };
      const node = {
        gain: param,
        connect: () => node,
        disconnect: () => record.disconnected++
      } as unknown as GainNode;
      record.node = node;
      gains.push(record);
      return node;
    },
    createBuffer: (_channels: number, length: number, sampleRate: number) => ({
      duration: length / sampleRate,
      copyToChannel: (samples: Float32Array) => copied.push(samples.slice())
    }),
    createBufferSource: () => {
      const source = {
        buffer: null,
        onended: null,
        connect: (target: AudioNode) => {
          source.connectedTo = target;
          return target;
        },
        start: () => {},
        stop: () => {}
      } as unknown as AudioBufferSourceNode & {
        onended: (() => void) | null;
        connectedTo?: AudioNode;
      };
      sources.push(source);
      return source;
    }
  } as unknown as AudioContext;
  const harness = createTranslatorHarness(ctx, {} as AudioNode);
  const { ws } = createFakeSocket();
  harness.internals.ws = ws;
  const audio = base64FromInt16(new Int16Array(4_800).fill(1_200));

  await harness.internals.handleServerMessage(
    ws,
    JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: audio } }] } } })
  );
  assert.equal(gains.length, 1);
  assert.equal(copied[0]?.[0], 0);
  assert.equal(gains[0]?.events.some((event) => event.method === 'curve'), true);
  sources[0]?.onended?.();
  assert.equal(gains[0]?.disconnected, 0, 'a temporary chunk gap must keep the turn bus alive');

  await harness.internals.handleServerMessage(
    ws,
    JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: audio } }] } } })
  );
  assert.equal(gains.length, 1, 'later chunks of one phrase must reuse the same envelope');
  assert.ok((copied[1]?.[0] ?? 0) > 0, 'inner chunks must not receive another fade-in');

  await harness.internals.handleServerMessage(
    ws,
    JSON.stringify({ serverContent: { turnComplete: true } })
  );
  assert.equal(harness.internals.playbackTurn, null);
  assert.equal(gains[0]?.events.some((event) => event.method === 'linear'), true);
  sources[1]?.onended?.();
  assert.equal(gains[0]?.disconnected, 1);
  harness.translator.stop();
});

function createFakeSocket(bufferedAmount = 0): {
  ws: WebSocket;
  closeCalls: Array<{ code?: number; reason?: string }>;
} {
  const closeCalls: Array<{ code?: number; reason?: string }> = [];
  const ws = {
    readyState: 1,
    bufferedAmount,
    onopen: null,
    send: () => {},
    close: (code?: number, reason?: string) => closeCalls.push({ code, reason })
  } as unknown as WebSocket;
  return { ws, closeCalls };
}

function addQueuedPlayback(internals: TranslatorInternals): () => number {
  let stopCalls = 0;
  internals.playingSources.add({ stop: () => stopCalls++ } as AudioBufferSourceNode);
  internals.nextPlayTime = 42;
  return () => stopCalls;
}

test('unexpected disconnect clears queued dubbing but keeps a resumable checkpoint', () => {
  const harness = createTranslatorHarness();
  const { ws } = createFakeSocket();
  const stopCalls = addQueuedPlayback(harness.internals);
  harness.internals.ws = ws;
  harness.internals.ready = true;
  harness.internals.connectionReady = true;
  harness.internals.resumptionHandle = 'last-safe-handle';
  harness.internals.pendingChunks = [new Int16Array([1, 2])];
  harness.internals.pendingSamples = 2;

  harness.internals.handleClose(ws, { code: 1006, reason: 'network lost' } as CloseEvent);

  assert.equal(stopCalls(), 1);
  assert.equal(harness.internals.playingSources.size, 0);
  assert.equal(harness.internals.nextPlayTime, 0);
  assert.equal(harness.internals.pendingChunks.length, 0);
  assert.equal(harness.internals.pendingSamples, 0);
  assert.equal(harness.internals.resumptionHandle, 'last-safe-handle');
  assert.equal(harness.internals.ws, null);
  assert.deepEqual(harness.readyChanges, [false]);
  assert.deepEqual(harness.errors, []);
  harness.translator.stop();
});

test('backpressure fails open, clears stale queues, and deliberately discards resumption', () => {
  const harness = createTranslatorHarness();
  const { ws, closeCalls } = createFakeSocket(MAX_BUFFERED_BYTES);
  const stopCalls = addQueuedPlayback(harness.internals);
  harness.internals.ws = ws;
  harness.internals.ready = true;
  harness.internals.connectionReady = true;
  harness.internals.resumptionHandle = 'stale-after-overload';
  harness.internals.pendingChunks = [new Int16Array([1, 2])];
  harness.internals.pendingSamples = 2;

  harness.internals.handleCapturedAudio(new Float32Array(128));

  assert.deepEqual(closeCalls, [{ code: 4001, reason: 'backpressure restart' }]);
  assert.equal(stopCalls(), 1);
  assert.equal(harness.internals.nextPlayTime, 0);
  assert.equal(harness.internals.pendingChunks.length, 0);
  assert.equal(harness.internals.pendingSamples, 0);
  assert.equal(harness.internals.resumptionHandle, null);
  assert.equal(harness.internals.ws, null);
  assert.deepEqual(harness.readyChanges, [false]);
  assert.ok(harness.statuses.some((status) => status.includes('Netz überlastet')));
  harness.translator.stop();
});

test('goAway immediately reconnects from the latest safe resumable handle', async () => {
  const harness = createTranslatorHarness();
  const { ws, closeCalls } = createFakeSocket();
  const stopCalls = addQueuedPlayback(harness.internals);
  harness.internals.ws = ws;
  harness.internals.ready = true;
  harness.internals.connectionReady = true;

  await harness.internals.handleServerMessage(
    ws,
    JSON.stringify({
      sessionResumptionUpdate: { resumable: true, newHandle: 'checkpoint-2' }
    })
  );
  await harness.internals.handleServerMessage(
    ws,
    JSON.stringify({
      sessionResumptionUpdate: { resumable: false, newHandle: 'unsafe-checkpoint' }
    })
  );
  assert.equal(harness.internals.resumptionHandle, 'checkpoint-2');

  await harness.internals.handleServerMessage(
    ws,
    JSON.stringify({ goAway: { timeLeft: '5.2s' } })
  );

  assert.deepEqual(closeCalls, [{ code: 1000, reason: 'goAway' }]);
  assert.equal(stopCalls(), 1);
  assert.equal(harness.internals.nextPlayTime, 0);
  assert.equal(harness.internals.resumptionHandle, 'checkpoint-2');
  assert.equal(harness.internals.ws, null);
  assert.deepEqual(harness.readyChanges, [false]);
  assert.ok(harness.statuses.some((status) => status.includes('Restzeit')));
  harness.translator.stop();
});

test('session-management schema rejection reconnects fresh with the fields disabled', async () => {
  const harness = createTranslatorHarness();
  const { ws, closeCalls } = createFakeSocket();
  harness.internals.ws = ws;
  harness.internals.ready = true;
  harness.internals.connectionReady = true;
  harness.internals.resumptionHandle = 'unsupported-handle';

  await harness.internals.handleServerMessage(
    ws,
    JSON.stringify({
      error: {
        message:
          'Invalid JSON payload. Unknown name "contextWindowCompression" at setup'
      }
    })
  );

  assert.equal(harness.internals.sessionManagementEnabled, false);
  assert.equal(harness.internals.resumptionHandle, null);
  assert.equal(harness.internals.ws, null);
  assert.deepEqual(closeCalls, [{ code: 1000, reason: 'setup schema fallback' }]);
  assert.deepEqual(harness.readyChanges, [false]);
  assert.deepEqual(harness.errors, []);
  harness.translator.stop();
});
