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

async function setup(options: { response?: () => Promise<Response>; sourceCaptions?: boolean; failPlayback?: boolean } = {}) {
  const errors: string[] = [];
  const captions: TranscriptEvent[] = [];
  const statuses: string[] = [];
  const ready: boolean[] = [];
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
    async setRemoteDescription() { queueMicrotask(() => channel.emit({ type: 'session.started', session: { id: 'live-test' } })); }
    getReceivers() { return this.receivers; }
    close() { this.closed = true; }
    attach() { this.dispatchEvent(Object.assign(new Event('track'), { track, streams: [new Stream()] })); }
  }
  const peer = new Peer();
  let disconnected = 0;
  const output = {};
  const connections: unknown[] = [];
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
    window: { configurable: true, value: { setTimeout, clearTimeout, setInterval: (callback: () => void) => setInterval(callback, 10), clearInterval } },
    fetch: { configurable: true, value: options.response ?? (async () => new Response(JSON.stringify({ session: { id: 'live-test' }, transport: { sdp: 'answer' } }))) },
    RTCPeerConnection: { configurable: true, value: function () { return peer; } },
    MediaStream: { configurable: true, value: Stream },
    document: { configurable: true, value: { createElement: () => audio, body: { append() { audio.isConnected = true; } } } }
  });
  const client = new GptLiveTranslator({
    ctx: { createMediaStreamSource: () => source, createAnalyser: () => meter } as unknown as AudioContext,
    inputStream: new Stream() as unknown as MediaStream, outputNode: output as AudioNode,
    serverUrl: 'http://localhost:8787', serverToken: 'local-test', voice: 'meridian',
    inputTranscriptionEnabled: options.sourceCaptions ?? true,
    onTranscript: event => captions.push(event), onStatus: status => statuses.push(status),
    onReadyChange: value => ready.push(value), onError: detail => errors.push(detail)
  });
  return { client, peer, channel, track, audio, output, connections, captions, errors, statuses, ready,
    resources: () => ({ disconnected, played, removed }) };
}

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
