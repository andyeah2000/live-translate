import assert from 'node:assert/strict';
import test from 'node:test';
import { GptLiveTranslator } from '../src/offscreen/live';
import type { TranscriptEvent } from '../src/messages';

async function harness(run: (state: Awaited<ReturnType<typeof setup>>) => Promise<void>, options: Parameters<typeof setup>[0] = {}) {
  const names = ['window', 'fetch', 'RTCPeerConnection', 'MediaStream', 'document'];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const state = await setup(options);
  try { await run(state); }
  finally {
    state.client.stop();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

async function setup(options: { response?: () => Promise<Response>; sourceCaptions?: boolean; failPlayback?: boolean; autoStart?: boolean } = {}) {
  const errors: string[] = [];
  const captions: TranscriptEvent[] = [];
  const statuses: string[] = [];
  const ready: boolean[] = [];
  const timeouts = new Map<ReturnType<typeof setTimeout>, { callback: () => void; delay: number }>();
  const track = { kind: 'audio', id: 'remote', readyState: 'live', muted: false, enabled: true, onunmute: null as (() => void) | null };
  class Channel extends EventTarget {
    readyState = 'open';
    sent: Record<string, unknown>[] = [];
    throws = false;
    send(text: string) { if (this.throws) throw new Error('send failed'); this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 'closed'; }
    emit(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' ? value : JSON.stringify(value) })); }
  }
  const channel = new Channel();
  class Stream {
    constructor(private readonly tracks = [track]) {}
    getAudioTracks() { return this.tracks; }
  }
  class Peer extends EventTarget {
    iceGatheringState = 'complete';
    localDescription = { sdp: 'offer' };
    connectionState = 'connected';
    closed = false;
    receivers: Array<{ track: typeof track }> = [];
    addTrack() {}
    createDataChannel() { return channel; }
    async createOffer() { return this.localDescription; }
    async setLocalDescription() {}
    async setRemoteDescription() {
      if (options.autoStart !== false) queueMicrotask(() => channel.emit({ type: 'session.started', session: { id: 'live-test' } }));
    }
    getReceivers() { return this.receivers; }
    close() { this.closed = true; }
    attach(remote = track, tracks = [remote]) {
      this.dispatchEvent(Object.assign(new Event('track'), { track: remote, streams: [new Stream(tracks)] }));
    }
  }
  const peer = new Peer();
  let disconnected = 0;
  const output = {};
  const connections: unknown[] = [];
  const sourceStreams: Stream[] = [];
  const meter = { fftSize: 0, connect(node: unknown) { connections.push(node); return node; }, disconnect() { disconnected++; }, getFloatTimeDomainData(data: Float32Array) { data.fill(0.1); } };
  const source = { connect(node: unknown) { connections.push(node); return meter; }, disconnect() { disconnected++; } };
  let played = 0;
  let removed = false;
  const audio = {
    autoplay: false, muted: false, srcObject: null, isConnected: false,
    play: async () => { played++; if (options.failPlayback) throw new Error('autoplay denied'); },
    pause() {}, remove() { removed = true; }, removeAttribute() {}
  };
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: {
      setTimeout(callback: () => void, delay: number) {
        const timer = setTimeout(() => { timeouts.delete(timer); callback(); }, delay);
        timeouts.set(timer, { callback, delay });
        return timer;
      },
      clearTimeout(timer: ReturnType<typeof setTimeout>) { timeouts.delete(timer); clearTimeout(timer); },
      setInterval: (callback: () => void) => setInterval(callback, 10), clearInterval
    } },
    fetch: { configurable: true, value: options.response ?? (async () => new Response(JSON.stringify({ session: { id: 'live-test' }, transport: { sdp: 'answer' } }))) },
    RTCPeerConnection: { configurable: true, value: function () { return peer; } },
    MediaStream: { configurable: true, value: Stream },
    document: { configurable: true, value: { createElement: () => audio, body: { append() { audio.isConnected = true; } } } }
  });
  const client = new GptLiveTranslator({
    ctx: { createMediaStreamSource: (stream: Stream) => { sourceStreams.push(stream); return source; }, createAnalyser: () => meter } as unknown as AudioContext,
    inputStream: new Stream() as unknown as MediaStream, outputNode: output as AudioNode,
    serverUrl: 'http://localhost:8787', serverToken: 'local-test', voice: 'meridian',
    inputTranscriptionEnabled: options.sourceCaptions ?? true,
    onTranscript: event => captions.push(event), onStatus: status => statuses.push(status),
    onReadyChange: value => ready.push(value), onError: detail => errors.push(detail)
  });
  return { client, peer, channel, track, audio, output, connections, sourceStreams, captions, errors, statuses, ready,
    fireTimeouts(delay: number) {
      for (const [timer, entry] of [...timeouts]) {
        if (entry.delay !== delay) continue;
        clearTimeout(timer); timeouts.delete(timer); entry.callback();
      }
    },
    resources: () => ({ disconnected, played, removed }) };
}

test('concurrent start calls share one connection and stopped clients cannot restart', async () => harness(async state => {
  const first = state.client.start();
  assert.equal(state.client.start(), first);
  await first;
  state.client.stop();
  await assert.rejects(state.client.start(), /beendet/);
}));

test('startup cancellation while decoding the answer cannot report success', async () => {
  let cancel = () => {};
  await harness(async state => {
    cancel = () => state.client.stop();
    await assert.rejects(state.client.start(), /beendet/);
    assert.equal(state.peer.closed, true);
    assert.deepEqual(state.ready, []);
  }, { response: async () => {
    const response = new Response('{}');
    response.json = async () => {
      queueMicrotask(cancel);
      return { session: { id: 'live-test' }, transport: { sdp: 'answer' } };
    };
    return response;
  } });
});

test('session errors during startup retain the provider error', async () => harness(async state => {
  const starting = state.client.start();
  const rejected = assert.rejects(starting, /quota exceeded/);
  state.channel.emit({ type: 'error', error: { message: 'quota exceeded' } });
  await rejected;
  assert.deepEqual(state.errors, ['quota exceeded']);
}, { autoStart: false }));

test('an unfinished stopped session cannot claim graceful finalization', async () => harness(async state => {
  await state.client.start();
  state.client.stop();
  await assert.rejects(state.client.finishInput(), /unvollständige Finalisierung/);
}));

test('cancelling before session.started settles startup without sending a premature close command', async () => harness(async state => {
  const starting = assert.rejects(state.client.start(), /beendet/);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(state.client.finishInput(), /vor session.started/);
  await starting;
  assert.deepEqual(state.channel.sent, []);
  assert.deepEqual(state.ready, []);
  assert.equal(state.peer.closed, true);
}, { autoStart: false }));

test('an immediate graceful close after session.started does not strand the startup waiter', async () => harness(async state => {
  const starting = state.client.start();
  await new Promise(resolve => setImmediate(resolve));
  state.channel.emit({ type: 'session.started', session: { id: 'live-test' } });
  const finishing = state.client.finishInput();
  state.channel.emit({ type: 'session.closed' });
  await Promise.all([starting, finishing]);
  assert.deepEqual(state.ready, [true, false]);
  assert.deepEqual(state.errors, []);
}, { autoStart: false }));

test('brief disconnects recover but a persistent disconnect terminates the session', async () => harness(async state => {
  await state.client.start();
  state.peer.connectionState = 'disconnected';
  state.peer.dispatchEvent(new Event('connectionstatechange'));
  assert.equal(state.peer.closed, false);
  state.peer.connectionState = 'connected';
  state.peer.dispatchEvent(new Event('connectionstatechange'));
  state.fireTimeouts(10_000);
  assert.equal(state.peer.closed, false);
  state.peer.connectionState = 'disconnected';
  state.peer.dispatchEvent(new Event('connectionstatechange'));
  state.fireTimeouts(10_000);
  assert.equal(state.peer.closed, true);
  assert.match(state.errors[0] ?? '', /Verbindung/);
  assert.deepEqual(state.ready, [true, false]);
}));

test('session.closed is terminal even when late transport events arrive', async () => harness(async state => {
  await state.client.start();
  const finishing = state.client.finishInput();
  state.channel.emit({ type: 'session.output_transcript.delta', delta: 'final' });
  state.channel.emit({ type: 'session.closed' });
  await finishing;
  state.channel.emit({ type: 'session.output_transcript.delta', delta: 'late' });
  state.channel.emit({ type: 'session.delegation.created', delegation: { id: 'late' } });
  state.channel.dispatchEvent(new Event('error'));
  state.peer.connectionState = 'failed';
  state.peer.dispatchEvent(new Event('connectionstatechange'));
  assert.equal(state.captions.length, 1);
  assert.deepEqual(state.errors, []);
  assert.deepEqual(state.channel.sent.map(event => event.type), ['session.close']);
}));

test('remote playback selects the event track and ignores a duplicate track event', async () => harness(async state => {
  await state.client.start();
  const otherTrack = { ...state.track, id: 'aaa-other' };
  state.peer.attach(state.track, [otherTrack, state.track]);
  state.peer.attach();
  await Promise.resolve();
  assert.deepEqual(state.sourceStreams[0]?.getAudioTracks(), [state.track]);
  assert.equal(state.resources().played, 1);
}));

test('an obsolete play rejection cannot kill a replacement audio track', async () => harness(async state => {
  await state.client.start();
  let rejectOld: (error: Error) => void = () => {};
  state.audio.play = () => new Promise((_resolve, reject) => { rejectOld = reject; });
  state.peer.attach();
  state.audio.play = async () => {};
  state.peer.attach({ ...state.track, id: 'replacement' });
  rejectOld(new Error('play interrupted by replacement srcObject'));
  await Promise.resolve();
  assert.equal(state.peer.closed, false);
  assert.deepEqual(state.errors, []);
  assert.equal(state.client.audioHealth().live, true);
}));

test('remote audio has one audible Web Audio path and releases every resource', async () => harness(async state => {
  await state.client.start();
  assert.equal(state.client.audioHealth().attached, false);
  state.peer.attach();
  await Promise.resolve();
  state.track.onunmute?.();
  assert.equal(state.audio.muted, true, 'HTML playback must not double the audible audio graph');
  assert.equal(state.connections.filter(node => node === state.output).length, 1);
  assert.deepEqual(state.client.audioHealth(), { attached: true, live: true, muted: false, signal: true });
  state.track.muted = true;
  assert.equal(state.client.audioHealth().signal, false);
  state.client.stop();
  assert.equal(state.peer.closed, true);
  assert.equal(state.resources().removed, true);
  assert.equal(state.resources().played, 1);
  assert.ok(state.resources().disconnected >= 2);
}));

test('receiver fallback recovers a lost track event without replaying captions', async () => harness(async state => {
  await state.client.start();
  state.peer.receivers = [{ track: state.track }];
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(state.client.audioHealth().attached, true);
  assert.equal(state.resources().played, 1);
  assert.deepEqual(state.captions, []);
}));

test('caption routing preserves deltas and hides the disabled source lane', async () => harness(async state => {
  await state.client.start();
  state.channel.emit('not-json');
  state.channel.emit({ type: 'unknown' });
  state.channel.emit({ type: 'session.input_transcript.delta', delta: 'source' });
  state.channel.emit({ type: 'session.output_transcript.delta', delta: ' Hallo ', start_ms: 10, end_ms: 100 });
  assert.equal(state.captions.length, 1);
  assert.equal(state.captions[0]?.kind === 'chunk' && state.captions[0].text, ' Hallo ');
  state.channel.emit({ type: 'session.closed' });
  assert.equal(state.peer.closed, true);
  assert.match(state.errors[0] ?? '', /Sitzung beendet/);
}, { sourceCaptions: false }));

for (const reason of ['channel-close', 'channel-error', 'peer-failed', 'api-error'] as const) {
  test(`an active ${reason} ends capture readiness and reports one error`, async () => harness(async state => {
    await state.client.start();
    if (reason === 'api-error') state.channel.emit({ type: 'error', error: { message: 'quota exceeded' } });
    else if (reason === 'peer-failed') {
      state.peer.connectionState = 'failed'; state.peer.dispatchEvent(new Event('connectionstatechange'));
    } else state.channel.dispatchEvent(new Event(reason === 'channel-close' ? 'close' : 'error'));
    assert.equal(state.peer.closed, true);
    assert.deepEqual(state.ready, [true, false]);
    assert.equal(state.errors.length, 1);
    state.channel.emit({ type: 'error', message: 'late error' });
    assert.equal(state.errors.length, 1);
  }));
}

test('delegation cannot launch Responses work and repeated deviation stops the session', async () => harness(async state => {
  await state.client.start();
  for (const id of ['first', 'second']) state.channel.emit({ type: 'session.delegation.created', delegation: { id } });
  assert.deepEqual(state.channel.sent.map(event => event.type), ['session.instructions.append', 'session.instructions.append']);
  assert.deepEqual(state.channel.sent.map(event => event.delegation_id), ['first', 'second']);
  state.channel.emit({ type: 'session.delegation.created', delegation: { id: 'third' } });
  assert.equal(state.peer.closed, true);
  assert.match(state.errors[0] ?? '', /Übersetzungsmodus/);
}));

for (const failure of ['closed-channel', 'send-failure', 'timeout'] as const) {
  test(`finalization rejects ${failure} without claiming session.closed`, async () => harness(async state => {
    await state.client.start();
    if (failure === 'closed-channel') state.channel.readyState = 'closed';
    if (failure === 'send-failure') state.channel.throws = true;
    await assert.rejects(state.client.finishInput(10), /unvollständige Finalisierung/);
  }));
}

test('audio playback failure ends the session instead of reporting working voice output', async () => harness(async state => {
  await state.client.start(); state.peer.attach();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(state.errors[0] ?? '', /Zielstimme nicht starten/);
  assert.equal(state.peer.closed, true);
}, { failPlayback: true }));

for (const failure of ['network', 'json', 'incomplete', 'upstream-text'] as const) {
  test(`a ${failure} session response never leaves a live peer`, async () => harness(async state => {
    await assert.rejects(state.client.start());
    assert.equal(state.peer.closed, true);
  }, { response: async () => {
    if (failure === 'network') throw new Error('offline');
    if (failure === 'json') return new Response('not-json');
    if (failure === 'upstream-text') return new Response('private upstream HTML', { status: 502 });
    return new Response('{}');
  } }));
}
