import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GeminiTranslator,
  MAX_RECONNECT_PLAYBACK_LEAD_S,
  MAX_BUFFERED_AUDIO_MS,
  MAX_BUFFERED_BYTES,
  TRANSCRIPT_SETTLE_MS,
  TranscriptTurnCoordinator,
  bufferedAudioDurationMs,
  createGeminiSetup,
  goAwayTimeLeftMs,
  isSessionManagementSchemaError,
  nextTranscriptionPlacement,
  rejectedSessionManagementFeature,
  shouldRestartForBackpressure,
  type GeminiTranslatorOptions,
  type TimerScheduler
} from '../src/offscreen/gemini';
import { base64FromInt16, int16FromBase64 } from '../src/offscreen/pcm';
import {
  MAX_PREROLL_AUDIO_MS,
  SEND_CHUNK_MS,
  samplesForDuration
} from '../src/offscreen/stream-timing';

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
    resumptionEnabled: false,
    compressionEnabled: false,
    resumptionHandle: 'must-not-leak'
  }) as { setup: Record<string, unknown> };
  assert.equal(fallback.setup.sessionResumption, undefined);
  assert.equal(fallback.setup.contextWindowCompression, undefined);

  const compressionOnly = createGeminiSetup('de', 'setup', {
    resumptionEnabled: false,
    compressionEnabled: true
  }) as { setup: Record<string, unknown> };
  assert.equal(compressionOnly.setup.sessionResumption, undefined);
  assert.deepEqual(compressionOnly.setup.contextWindowCompression, { slidingWindow: {} });
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
  assert.equal(
    rejectedSessionManagementFeature(1007, 'Unknown name "sessionResumption"'),
    'resumption'
  );
  assert.equal(
    rejectedSessionManagementFeature(1007, 'Unknown name "contextWindowCompression"'),
    'compression'
  );
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
  handoffWs: WebSocket | null;
  ready: boolean;
  connectionReady: boolean;
  reconnectAttempts: number;
  pendingChunks: Int16Array[];
  pendingSamples: number;
  nextPlayTime: number;
  resumptionHandle: string | null;
  sessionResumptionEnabled: boolean;
  contextCompressionEnabled: boolean;
  inputEndSent: boolean;
  playingSources: Set<AudioBufferSourceNode>;
  playbackTurn: {
    gain: GainNode;
    sources: Set<AudioBufferSourceNode>;
    closed: boolean;
  } | null;
  handleClose(ws: WebSocket, event: CloseEvent): void;
  handleCapturedAudio(chunk: Float32Array): void;
  handleServerMessage(ws: WebSocket, data: string): Promise<void>;
  maybeResolveFinishInput(): void;
  getAudioTransportStats(): {
    capturedSamples: number;
    sentSamples: number;
    droppedSamples: number;
    pendingSamples: number;
  };
}

interface TranslatorHarness {
  translator: GeminiTranslator;
  internals: TranslatorInternals;
  statuses: string[];
  readyChanges: boolean[];
  errors: string[];
}

function createTranslatorHarness(
  ctx: AudioContext = { sampleRate: 48_000, currentTime: 0 } as AudioContext,
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

function createPlaybackTestContext(): {
  ctx: AudioContext;
  sources: Array<AudioBufferSourceNode & { onended: (() => void) | null }>;
} {
  const sources: Array<AudioBufferSourceNode & { onended: (() => void) | null }> = [];
  const createParam = () =>
    ({
      value: 0,
      cancelAndHoldAtTime() {},
      setValueCurveAtTime(curve: Float32Array) {
        this.value = curve.at(-1) ?? this.value;
      },
      linearRampToValueAtTime(value: number) {
        this.value = value;
      },
      setValueAtTime(value: number) {
        this.value = value;
      }
    }) as unknown as AudioParam;
  const ctx = {
    sampleRate: 48_000,
    currentTime: 0,
    createBuffer: (_channels: number, length: number, sampleRate: number) => ({
      duration: length / sampleRate,
      copyToChannel() {}
    }),
    createGain: () => {
      const node = {
        gain: createParam(),
        connect: () => node,
        disconnect() {}
      };
      return node;
    },
    createBufferSource: () => {
      const source = {
        buffer: null,
        onended: null,
        connect: (target: AudioNode) => target,
        start() {},
        stop() {}
      } as unknown as AudioBufferSourceNode & { onended: (() => void) | null };
      sources.push(source);
      return source;
    }
  } as unknown as AudioContext;
  return { ctx, sources };
}

test('setup preroll is bounded and flushed in low-latency chunks after setupComplete', async () => {
  const harness = createTranslatorHarness();
  const { ws, sent } = createFakeSocket();
  harness.internals.ws = ws;
  harness.internals.connectionReady = false;

  for (let index = 0; index < 20; index++) {
    harness.internals.handleCapturedAudio(new Float32Array(2_048).fill(0.1));
  }
  assert.ok(
    harness.internals.pendingSamples <= samplesForDuration(16_000, MAX_PREROLL_AUDIO_MS)
  );
  assert.ok(harness.internals.pendingSamples >= samplesForDuration(16_000, 400));

  await harness.internals.handleServerMessage(ws, JSON.stringify({ setupComplete: {} }));
  assert.equal(harness.internals.connectionReady, true);
  assert.ok(sent.length >= Math.floor(MAX_PREROLL_AUDIO_MS / SEND_CHUNK_MS) - 1);
  assert.ok(harness.internals.pendingSamples < samplesForDuration(16_000, SEND_CHUNK_MS));
  harness.translator.stop();
});

test('finishInput sends the partial final PCM chunk before audioStreamEnd and drains cleanly', async () => {
  const playback = createPlaybackTestContext();
  const harness = createTranslatorHarness(playback.ctx, {} as AudioNode);
  const { ws, sent } = createFakeSocket();
  harness.internals.ws = ws;
  harness.internals.ready = true;
  harness.internals.connectionReady = true;

  // Deutlich kleiner als ein dokumentierter 100-ms-Uplink-Chunk.
  harness.internals.handleCapturedAudio(new Float32Array(2_400).fill(0.1));
  assert.ok(harness.internals.pendingSamples > 0);
  assert.ok(harness.internals.pendingSamples < samplesForDuration(16_000, SEND_CHUNK_MS));

  const finished = harness.translator.finishInput(900);
  const messages = sent.map((item) => JSON.parse(item) as {
    realtimeInput?: { audio?: { data?: string }; audioStreamEnd?: boolean };
  });
  const finalAudioIndex = messages.findIndex((message) => message.realtimeInput?.audio?.data);
  const endIndex = messages.findIndex(
    (message) => message.realtimeInput?.audioStreamEnd === true
  );
  assert.ok(finalAudioIndex >= 0);
  assert.ok(endIndex > finalAudioIndex, 'audioStreamEnd must follow the final PCM samples');
  const finalAudio = messages[finalAudioIndex]?.realtimeInput?.audio?.data;
  assert.ok(finalAudio);
  assert.ok(int16FromBase64(finalAudio).length < samplesForDuration(16_000, SEND_CHUNK_MS));

  await harness.internals.handleServerMessage(
    ws,
    JSON.stringify({ serverContent: { turnComplete: true } })
  );
  let settled = false;
  void finished.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(settled, false, 'an unrelated old completion must not close the final turn');

  await harness.internals.handleServerMessage(
    ws,
    JSON.stringify({ serverContent: { generationComplete: true } })
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(settled, false, 'a bare generationComplete is not an audioStreamEnd acknowledgement');

  const translatedAudio = base64FromInt16(new Int16Array(480).fill(1_200));
  await harness.internals.handleServerMessage(
    ws,
    JSON.stringify({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: translatedAudio } }] },
        turnComplete: true
      }
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(settled, false, 'post-end audio plus turnComplete still lacks generationComplete');

  await harness.internals.handleServerMessage(
    ws,
    JSON.stringify({ serverContent: { generationComplete: true } })
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(settled, false, 'server completion must never shortcut the fixed drain window');
  playback.sources[0]?.onended?.();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(settled, false, 'local playback drain alone must not impersonate a server ack');
  await finished;
  const stats = harness.translator.getAudioTransportStats();
  assert.deepEqual(stats, {
    capturedSamples: stats.sentSamples,
    sentSamples: stats.sentSamples,
    droppedSamples: 0,
    pendingSamples: 0
  });
  harness.translator.stop();
});

test('an interrupted graceful finish repeats audioStreamEnd after session resumption', async () => {
  const playback = createPlaybackTestContext();
  const harness = createTranslatorHarness(playback.ctx, {} as AudioNode);
  const first = createFakeSocket();
  harness.internals.ws = first.ws;
  harness.internals.ready = true;
  harness.internals.connectionReady = true;

  const finished = harness.translator.finishInput(500);
  assert.equal(
    first.sent.some((item) => JSON.parse(item).realtimeInput?.audioStreamEnd === true),
    true
  );
  harness.internals.handleClose(
    first.ws,
    { code: 1006, reason: 'lost after input end' } as CloseEvent
  );
  assert.equal(harness.internals.inputEndSent, false);

  const resumed = createFakeSocket();
  harness.internals.ws = resumed.ws;
  await harness.internals.handleServerMessage(
    resumed.ws,
    JSON.stringify({ setupComplete: {} })
  );
  assert.equal(
    resumed.sent.some((item) => JSON.parse(item).realtimeInput?.audioStreamEnd === true),
    true
  );
  await harness.internals.handleServerMessage(
    resumed.ws,
    JSON.stringify({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { data: base64FromInt16(new Int16Array(480).fill(800)) } }]
        },
        generationComplete: true
      }
    })
  );
  playback.sources[0]?.onended?.();
  await finished;
  harness.translator.stop();
});

test('graceful finish has a hard deadline even when an AudioContext source never ends', async () => {
  const harness = createTranslatorHarness();
  const { ws } = createFakeSocket();
  harness.internals.ws = ws;
  harness.internals.ready = true;
  harness.internals.connectionReady = true;
  harness.internals.playingSources.add({ stop() {} } as AudioBufferSourceNode);

  const startedAt = performance.now();
  await harness.translator.finishInput(250);
  const elapsed = performance.now() - startedAt;
  assert.ok(elapsed >= 450, `hard deadline fired too early after ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed < 1_000, `hard deadline failed to bound shutdown (${elapsed.toFixed(1)} ms)`);
  harness.translator.stop();
});

test('finishInput stops capture immediately even while Gemini is reconnecting', async () => {
  const harness = createTranslatorHarness();
  harness.internals.connectionReady = false;
  const finished = harness.translator.finishInput(250);
  harness.internals.handleCapturedAudio(new Float32Array(4_800).fill(0.2));
  assert.deepEqual(harness.translator.getAudioTransportStats(), {
    capturedSamples: 0,
    sentSamples: 0,
    droppedSamples: 0,
    pendingSamples: 0
  });
  await finished;
  harness.translator.stop();
});

test('Gemini uses one smooth envelope across all network chunks of a spoken turn', async () => {
  const gains: Array<{
    node: GainNode;
    disconnected: number;
    events: Array<{ method: string; start: number; end?: number }>;
  }> = [];
  const sources: Array<
    AudioBufferSourceNode & {
      onended: (() => void) | null;
      connectedTo?: AudioNode;
      startedAt?: number;
    }
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
        start: (at: number) => {
          source.startedAt = at;
        },
        stop: () => {}
      } as unknown as AudioBufferSourceNode & {
        onended: (() => void) | null;
        connectedTo?: AudioNode;
        startedAt?: number;
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

  (ctx as unknown as { currentTime: number }).currentTime = 5.22;
  await harness.internals.handleServerMessage(
    ws,
    JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: audio } }] } } })
  );
  assert.equal(gains.length, 1, 'later chunks of one phrase must reuse the same envelope');
  assert.ok((copied[1]?.[0] ?? 0) > 0, 'inner chunks must not receive another fade-in');
  assert.ok(Math.abs((sources[1]?.startedAt ?? 0) - 5.25) < 1e-6);

  await harness.internals.handleServerMessage(
    ws,
    JSON.stringify({ serverContent: { generationComplete: true } })
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
  sent: string[];
} {
  const closeCalls: Array<{ code?: number; reason?: string }> = [];
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    bufferedAmount,
    onopen: null,
    send: (data: string) => sent.push(data),
    close: (code?: number, reason?: string) => closeCalls.push({ code, reason })
  } as unknown as WebSocket;
  return { ws, closeCalls, sent };
}

function createTemporarilyBackpressuredSocket(): {
  ws: WebSocket;
  sent: string[];
  closeCalls: Array<{ code?: number; reason?: string }>;
  release(): void;
} {
  const sent: string[] = [];
  const closeCalls: Array<{ code?: number; reason?: string }> = [];
  let bufferedAmount = 0;
  let audioSends = 0;
  let shouldBlock = true;
  const ws = {
    readyState: 1,
    get bufferedAmount() {
      return bufferedAmount;
    },
    onopen: null,
    send(data: string) {
      sent.push(data);
      const parsed = JSON.parse(data) as { realtimeInput?: { audio?: unknown } };
      if (parsed.realtimeInput?.audio !== undefined) {
        audioSends++;
        if (shouldBlock && audioSends >= 2) bufferedAmount = MAX_BUFFERED_BYTES;
      }
    },
    close(code?: number, reason?: string) {
      closeCalls.push({ code, reason });
    }
  } as unknown as WebSocket;
  return {
    ws,
    sent,
    closeCalls,
    release() {
      shouldBlock = false;
      bufferedAmount = 0;
    }
  };
}

function countRealtimeAudio(messages: string[]): number {
  return messages.filter((item) => {
    try {
      const parsed = JSON.parse(item) as { realtimeInput?: { audio?: unknown } };
      return parsed.realtimeInput?.audio !== undefined;
    } catch {
      return false;
    }
  }).length;
}

function addQueuedPlayback(internals: TranslatorInternals): () => number {
  let stopCalls = 0;
  internals.playingSources.add({ stop: () => stopCalls++ } as AudioBufferSourceNode);
  internals.nextPlayTime = 42;
  return () => stopCalls;
}

test('unexpected disconnect keeps input, bounds translated playback and preserves a safe checkpoint', () => {
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

  assert.equal(stopCalls(), 0);
  assert.equal(harness.internals.playingSources.size, 1);
  assert.equal(harness.internals.nextPlayTime, MAX_RECONNECT_PLAYBACK_LEAD_S);
  assert.equal(harness.internals.pendingChunks.length, 1);
  assert.equal(harness.internals.pendingSamples, 2);
  assert.equal(harness.internals.resumptionHandle, 'last-safe-handle');
  assert.equal(harness.internals.ws, null);
  assert.deepEqual(harness.readyChanges, [false]);
  assert.deepEqual(harness.errors, []);
  harness.translator.stop();
});

test('backpressure fails open while retaining bounded unsent input and safe context', () => {
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
  assert.equal(stopCalls(), 0);
  assert.equal(harness.internals.nextPlayTime, MAX_RECONNECT_PLAYBACK_LEAD_S);
  assert.ok(harness.internals.pendingChunks.length >= 1);
  assert.ok(harness.internals.pendingSamples > 2);
  assert.equal(harness.internals.resumptionHandle, 'stale-after-overload');
  assert.equal(harness.internals.ws, null);
  assert.deepEqual(harness.readyChanges, [false]);
  assert.ok(harness.statuses.some((status) => status.includes('Netz überlastet')));
  harness.translator.stop();
});

test('goAway performs a sample-complete dual-socket handoff with exact audio routing', async () => {
  const harness = createTranslatorHarness();
  const { ws, closeCalls, sent: oldSent } = createFakeSocket();
  const { ws: candidate, closeCalls: candidateCloseCalls, sent: candidateSent } =
    createFakeSocket();
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
  assert.equal(
    harness.internals.resumptionHandle,
    null,
    'resumable=false must invalidate every older checkpoint'
  );

  const OriginalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = function MockWebSocket() {
    return candidate;
  } as unknown as typeof WebSocket;
  try {
    await harness.internals.handleServerMessage(
      ws,
      JSON.stringify({ goAway: { timeLeft: '5.2s' } })
    );

    assert.equal(harness.internals.ws, ws, 'old socket must remain active during setup');
    assert.equal(harness.internals.handoffWs, candidate);
    assert.deepEqual(closeCalls, []);
    assert.equal(stopCalls(), 0);
    assert.equal(harness.internals.nextPlayTime, 42);
    assert.deepEqual(harness.readyChanges, [false]);
    assert.ok(harness.statuses.some((status) => status.includes('Restzeit')));

    await harness.internals.handleServerMessage(
      ws,
      JSON.stringify({
        sessionResumptionUpdate: { resumable: true, newHandle: 'checkpoint-after-handoff-start' }
      })
    );
    candidate.onopen?.(new Event('open'));
    const setup = JSON.parse(candidateSent[0] ?? '{}') as {
      setup?: { sessionResumption?: { handle?: string } };
    };
    assert.equal(
      setup.setup?.sessionResumption?.handle,
      'checkpoint-after-handoff-start',
      'candidate setup must use the newest safe server checkpoint'
    );

    // Auch bei einem >750-ms-Setup bleibt jedes Sample in einer eindeutigen
    // lokalen FIFO. Es geht weder zum alten noch vor setupComplete zum neuen
    // Socket und kann deshalb nicht doppelt übersetzt werden.
    for (let chunk = 0; chunk < 10; chunk++) {
      harness.internals.handleCapturedAudio(new Float32Array(4_800).fill(0.1));
    }
    const oldAudioBeforeSwitch = countRealtimeAudio(oldSent);
    assert.equal(oldAudioBeforeSwitch, 0);
    assert.equal(countRealtimeAudio(candidateSent), 0);
    assert.ok(harness.internals.pendingSamples >= samplesForDuration(16_000, 900));

    await harness.internals.handleServerMessage(
      candidate,
      JSON.stringify({ setupComplete: {} })
    );
    assert.equal(harness.internals.ws, candidate);
    assert.equal(harness.internals.handoffWs, null);
    assert.deepEqual(closeCalls, [{ code: 1000, reason: 'goAway handoff' }]);
    assert.equal(stopCalls(), 0, 'valid translated audio must not be cut on handoff');
    assert.equal(harness.internals.nextPlayTime, 42);
    const candidateAudioAfterPromotion = countRealtimeAudio(candidateSent);
    assert.ok(candidateAudioAfterPromotion >= 10);
    assert.deepEqual(harness.readyChanges, [false, true]);

    harness.internals.handleCapturedAudio(new Float32Array(4_800).fill(0.1));
    assert.equal(
      countRealtimeAudio(oldSent),
      oldAudioBeforeSwitch,
      'old socket must receive nothing after promotion'
    );
    assert.ok(countRealtimeAudio(candidateSent) > candidateAudioAfterPromotion);
    assert.deepEqual(candidateCloseCalls, []);
    const stats = harness.internals.getAudioTransportStats();
    assert.equal(stats.droppedSamples, 0);
    assert.equal(
      stats.capturedSamples,
      stats.sentSamples + stats.pendingSamples,
      'normal GoAway handoff must account for every captured sample'
    );
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
    harness.translator.stop();
  }
});

test('goAway starts fresh when Gemini marks the latest session state unresumable', async () => {
  const harness = createTranslatorHarness();
  const { ws, sent: oldSent } = createFakeSocket();
  const { ws: candidate, sent: candidateSent } = createFakeSocket();
  harness.internals.ws = ws;
  harness.internals.ready = true;
  harness.internals.connectionReady = true;

  await harness.internals.handleServerMessage(
    ws,
    JSON.stringify({
      sessionResumptionUpdate: { resumable: true, newHandle: 'formerly-safe' }
    })
  );
  await harness.internals.handleServerMessage(
    ws,
    JSON.stringify({ sessionResumptionUpdate: { resumable: false } })
  );
  assert.equal(harness.internals.resumptionHandle, null);

  const OriginalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = function MockWebSocket() {
    return candidate;
  } as unknown as typeof WebSocket;
  try {
    await harness.internals.handleServerMessage(
      ws,
      JSON.stringify({ goAway: { timeLeft: '1.5s' } })
    );
    harness.internals.handleCapturedAudio(new Float32Array(4_800).fill(0.1));
    assert.equal(countRealtimeAudio(oldSent), 0);
    assert.ok(harness.internals.pendingSamples > 0);
    candidate.onopen?.(new Event('open'));
    const setup = JSON.parse(candidateSent[0] ?? '{}') as {
      setup?: { sessionResumption?: { handle?: string } };
    };
    assert.deepEqual(
      setup.setup?.sessionResumption,
      {},
      'an older token must not be reused after resumable=false'
    );
    await harness.internals.handleServerMessage(
      candidate,
      JSON.stringify({ setupComplete: {} })
    );
    assert.ok(
      countRealtimeAudio(candidateSent) >= 1,
      'fresh successor must receive every sample buffered during setup'
    );
    assert.equal(harness.internals.getAudioTransportStats().droppedSamples, 0);
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
    harness.translator.stop();
  }
});

test('resumable=false during handoff restarts the candidate fresh without losing buffered input', async () => {
  const harness = createTranslatorHarness();
  const { ws: old, sent: oldSent } = createFakeSocket();
  const first = createFakeSocket();
  const second = createFakeSocket();
  harness.internals.ws = old;
  harness.internals.ready = true;
  harness.internals.connectionReady = true;
  harness.internals.resumptionHandle = 'initial-safe-handle';

  const candidates = [first.ws, second.ws];
  const OriginalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = function MockWebSocket() {
    const candidate = candidates.shift();
    if (!candidate) throw new Error('unexpected extra handoff candidate');
    return candidate;
  } as unknown as typeof WebSocket;
  try {
    await harness.internals.handleServerMessage(
      old,
      JSON.stringify({ goAway: { timeLeft: '4s' } })
    );
    first.ws.onopen?.(new Event('open'));
    harness.internals.handleCapturedAudio(new Float32Array(4_800).fill(0.1));
    await harness.internals.handleServerMessage(
      old,
      JSON.stringify({ sessionResumptionUpdate: { resumable: false } })
    );
    assert.deepEqual(first.closeCalls, [
      { code: 1000, reason: 'handoff setup refresh' }
    ]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.internals.handoffWs, second.ws);
    second.ws.onopen?.(new Event('open'));
    const setup = JSON.parse(second.sent[0] ?? '{}') as {
      setup?: { sessionResumption?: { handle?: string } };
    };
    assert.deepEqual(setup.setup?.sessionResumption, {});
    await harness.internals.handleServerMessage(
      second.ws,
      JSON.stringify({ setupComplete: {} })
    );
    assert.equal(countRealtimeAudio(oldSent), 0);
    assert.ok(countRealtimeAudio(second.sent) >= 1);
    assert.equal(harness.internals.getAudioTransportStats().droppedSamples, 0);
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
    harness.translator.stop();
  }
});

test('handoff backlog drains through a paced pump instead of restarting for self-backpressure', async () => {
  const harness = createTranslatorHarness();
  const { ws: old } = createFakeSocket();
  const candidate = createTemporarilyBackpressuredSocket();
  harness.internals.ws = old;
  harness.internals.ready = true;
  harness.internals.connectionReady = true;

  const OriginalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = function MockWebSocket() {
    return candidate.ws;
  } as unknown as typeof WebSocket;
  try {
    await harness.internals.handleServerMessage(
      old,
      JSON.stringify({ goAway: { timeLeft: '3s' } })
    );
    candidate.ws.onopen?.(new Event('open'));
    for (let chunk = 0; chunk < 10; chunk++) {
      harness.internals.handleCapturedAudio(new Float32Array(4_800).fill(0.1));
    }
    await harness.internals.handleServerMessage(
      candidate.ws,
      JSON.stringify({ setupComplete: {} })
    );
    assert.equal(harness.internals.ws, candidate.ws);
    assert.ok(harness.internals.pendingSamples > 0);
    assert.deepEqual(candidate.closeCalls, []);

    candidate.release();
    const deadline = Date.now() + 1_000;
    while (harness.internals.pendingSamples >= samplesForDuration(16_000, SEND_CHUNK_MS)) {
      if (Date.now() >= deadline) throw new Error('paced handoff drain timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const stats = harness.internals.getAudioTransportStats();
    assert.equal(stats.capturedSamples, stats.sentSamples + stats.pendingSamples);
    assert.equal(stats.droppedSamples, 0);
    assert.deepEqual(candidate.closeCalls, []);
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
    harness.translator.stop();
  }
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

  assert.equal(harness.internals.contextCompressionEnabled, false);
  assert.equal(harness.internals.sessionResumptionEnabled, true);
  assert.equal(harness.internals.resumptionHandle, 'unsupported-handle');
  assert.equal(harness.internals.ws, null);
  assert.deepEqual(closeCalls, [{ code: 1000, reason: 'setup schema fallback' }]);
  assert.deepEqual(harness.readyChanges, [false]);
  assert.deepEqual(harness.errors, []);
  harness.translator.stop();
});
