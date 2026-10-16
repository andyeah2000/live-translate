import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { GptLiveTranslator, type GptLiveTranslatorOptions } from '../src/offscreen/live';
import { NeuralVoiceDetector, type NeuralVoiceDetectorOptions } from '../src/offscreen/neural-vad';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class Track {
  kind = 'audio';
  readyState = 'live';
  onended: (() => void) | null = null;
  stopped = false;
  stop() { this.stopped = true; this.readyState = 'ended'; }
}

class Stream {
  constructor(readonly tracks = [new Track()]) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
}

class Param {
  value = 1;
  cancelAndHoldAtTime() {}
  setValueAtTime(value: number) { this.value = value; }
  linearRampToValueAtTime(value: number) { this.value = value; }
}

class Node {
  connections: Node[] = [];
  gain = new Param();
  connect(node: Node) { this.connections.push(node); return node; }
}

let initialContextState = 'running';
let resumeError: Error | null = null;
const contexts: Context[] = [];
class Context {
  state = initialContextState;
  currentTime = 0;
  destination = new Node();
  gains: Node[] = [];
  sources: Node[] = [];
  constructor() { contexts.push(this); }
  async resume() { if (resumeError) throw resumeError; this.state = 'running'; }
  async close() { this.state = 'closed'; }
  createMediaStreamSource() { const node = new Node(); this.sources.push(node); return node; }
  createGain() { const node = new Node(); this.gains.push(node); return node; }
  createWaveShaper() { return new Node(); }
  createDynamicsCompressor() {
    return Object.assign(new Node(), {
      threshold: new Param(), knee: new Param(), ratio: new Param(), attack: new Param(), release: new Param()
    });
  }
}

const peers: Peer[] = [];
class Peer extends EventTarget {
  connectionState = 'new';
  iceGatheringState = 'complete';
  localDescription = { sdp: 'v=0\r\nm=audio' };
  ontrack: ((event: { track: Track }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor() { super(); peers.push(this); }
  async setRemoteDescription() { this.ontrack?.({ track: new Track() }); }
  async createAnswer() { return this.localDescription; }
  async setLocalDescription() {}
  close() { this.change('closed'); }
  change(state: string) {
    this.connectionState = state;
    this.dispatchEvent(new Event('connectionstatechange'));
    this.onconnectionstatechange?.();
  }
}

let capture = async () => new Stream();
let captureCalls = 0;
let clientError: Error | null = null;
let vadError: Error | null = null;
let finishError: Error | null = null;
let finishGate: Promise<void> | null = null;
let clientStops = 0;
let vadStops = 0;
let health = { attached: true, live: true, muted: false, signal: false };
const clients: GptLiveTranslatorOptions[] = [];
const detectors: NeuralVoiceDetectorOptions[] = [];
const messages: Array<Record<string, unknown>> = [];
let listener!: (message: Record<string, unknown>, sender: unknown, respond: (value: unknown) => void) => unknown;

Object.defineProperties(globalThis, {
  window: { configurable: true, value: new EventTarget() },
  navigator: { configurable: true, value: { mediaDevices: { getUserMedia: () => { captureCalls++; return capture(); } } } },
  AudioContext: { configurable: true, value: Context },
  RTCPeerConnection: { configurable: true, value: Peer },
  MediaStream: { configurable: true, value: Stream },
  chrome: { configurable: true, value: { runtime: {
    getURL: (path: string) => `chrome-extension://test/${path}`,
    sendMessage: async (message: Record<string, unknown>) => { messages.push(message); },
    onMessage: { addListener: (fn: typeof listener) => { listener = fn; } }
  } } }
});

GptLiveTranslator.prototype.start = async function () {
  const options = (this as unknown as { opts: GptLiveTranslatorOptions }).opts;
  clients.push(options);
  if (clientError) throw clientError;
  options.onReadyChange(true);
  options.onStatus('Verbunden');
};
GptLiveTranslator.prototype.finishInput = async () => {
  if (finishGate) await finishGate;
  if (finishError) throw finishError;
};
GptLiveTranslator.prototype.stop = () => { clientStops++; };
GptLiveTranslator.prototype.audioHealth = () => health;
NeuralVoiceDetector.prototype.start = async function () {
  detectors.push((this as unknown as { opts: NeuralVoiceDetectorOptions }).opts);
  if (vadError) throw vadError;
};
NeuralVoiceDetector.prototype.stop = () => { vadStops++; };

await import('../src/offscreen/main');

const trustedSender = { origin: 'chrome-extension://test' };
function emit(message: Record<string, unknown>) {
  return new Promise<unknown>(resolve => { listener(message, trustedSender, resolve); });
}
function start(sessionId = 'test-session', extra: Record<string, unknown> = {}) {
  return emit({ type: 'offscreen-start', sessionId, streamId: 'capture-id', settings: {
    liveServerUrl: 'http://127.0.0.1:8787', liveServerToken: 'test', liveVoice: 'meridian', translationVolume: 1
  }, ...extra });
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Offscreen fixture timed out');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
async function ready() {
  await waitFor(() => messages.some(message => message.type === 'ducking-telemetry' &&
    (message.telemetry as { ready: boolean }).ready));
}

afterEach(async () => {
  finishGate = null;
  await emit({ type: 'offscreen-stop' });
  await new Promise(resolve => setTimeout(resolve, 0));
  contexts.length = 0; peers.length = 0; clients.length = 0; detectors.length = 0; messages.length = 0;
  capture = async () => new Stream();
  captureCalls = 0; clientStops = 0; vadStops = 0;
  initialContextState = 'running'; resumeError = null; clientError = null; vadError = null; finishError = null;
  health = { attached: true, live: true, muted: false, signal: false };
});

test('mute received during pending capture is retained and duplicate starts cannot consume capture twice', async () => {
  const pending = deferred<Stream>();
  capture = () => pending.promise;
  assert.deepEqual(await start(), { ok: true });
  await start();
  await emit({ type: 'offscreen-update-output', sessionId: 'test-session', settings: { translationVolume: 0 } });
  await emit({ type: 'offscreen-update-output', sessionId: 'stale', settings: { translationVolume: 1 } });
  assert.equal(captureCalls, 1);
  pending.resolve(new Stream());
  await ready();
  assert.equal(contexts[0]?.gains[2]?.gain.value, 0, 'pending mute must apply before any translated playback');
  health.signal = true;
  detectors[0]?.onSpeechChange(true, 0.95);
  assert.equal(contexts[0]?.gains[0]?.gain.value, 1, 'muted output never suppresses the original');
  await emit({ type: 'offscreen-update-output', sessionId: 'test-session', settings: { translationVolume: 0.4 } });
  assert.equal(contexts[0]?.gains[2]?.gain.value, 0.4);
  assert.equal(contexts[0]?.gains[0]?.gain.value, 0.28);
  clients[0]?.onTranscript({ kind: 'chunk', lane: 'target', text: 'Hallo' });
  assert.ok(messages.some(message => message.type === 'transcript'));
});

test('stop while capture is pending disposes the late stream without starting a provider', async () => {
  const pending = deferred<Stream>();
  capture = () => pending.promise;
  await start();
  assert.deepEqual(await emit({ type: 'offscreen-stop' }), { ok: true, finalizationError: null });
  const media = new Stream();
  pending.resolve(media);
  await waitFor(() => media.tracks[0]!.stopped);
  assert.equal(contexts.length, 0);
  assert.equal(clients.length, 0);
});

test('stale callbacks from an old session cannot alter replacement playback', async () => {
  await start('old'); await ready();
  const oldClient = clients[0]!;
  const oldDetector = detectors[0]!;
  await start('new');
  await waitFor(() => clients.length === 2);
  const before = messages.length;
  oldClient.onError('stale failure'); oldClient.onReadyChange(false); oldClient.onStatus('old');
  oldClient.onTranscript({ kind: 'complete', lane: 'target' });
  oldDetector.onError('old VAD'); oldDetector.onSpeechChange(true, 1);
  assert.equal(messages.length, before);
  assert.equal(contexts[1]?.state, 'running');
});

test('an unexpectedly closed audio context terminates provider and capture visibly', async () => {
  await start(); await ready();
  const media = clients[0]!.inputStream as unknown as Stream;
  contexts[0]!.state = 'closed';
  await waitFor(() => messages.some(message => message.type === 'offscreen-error'));
  assert.equal(clientStops, 1); assert.equal(vadStops, 1);
  assert.equal(media.tracks[0]?.stopped, true);
});

test('the audio control loop resumes suspension and reports a failed recovery', async () => {
  initialContextState = 'suspended';
  await start(); await ready();
  assert.equal(contexts[0]?.state, 'running');
  contexts[0]!.state = 'suspended';
  await waitFor(() => contexts[0]?.state === 'running');
  resumeError = new Error('device lost');
  contexts[0]!.state = 'suspended';
  await waitFor(() => messages.some(message => message.type === 'offscreen-error'));
  assert.match(String(messages.find(message => message.type === 'offscreen-error')?.detail), /device lost/);
});

test('capture, missing-track, resume and provider startup failures release acquired resources', async () => {
  for (const failure of ['capture', 'track', 'resume', 'provider']) {
    const media = new Stream(failure === 'track' ? [] : [new Track()]);
    capture = async () => { if (failure === 'capture') throw new Error('capture denied'); return media; };
    initialContextState = failure === 'resume' ? 'suspended' : 'running';
    resumeError = failure === 'resume' ? new Error('resume denied') : null;
    clientError = failure === 'provider' ? new Error('provider failed') : null;
    messages.length = 0;
    await start(failure);
    await waitFor(() => messages.some(message => message.type === 'offscreen-error'));
    assert.ok(contexts.every(context => context.state === 'closed'));
    if (failure !== 'capture') assert.ok(media.tracks.every(track => track.stopped));
  }
});

test('VAD failure preserves translation with the simplified mix and visible telemetry', async () => {
  vadError = new Error('VAD unavailable'); health.signal = true;
  await start();
  await waitFor(() => messages.some(message => message.type === 'ducking-telemetry' &&
    (message.telemetry as { error: string | null }).error === 'VAD unavailable'));
  assert.equal(contexts[0]?.state, 'running');
  assert.equal(contexts[0]?.gains[0]?.gain.value, 0.6);
  clients[0]?.onStatus('Verbunden');
  assert.match(String(messages.at(-1)?.status), /vereinfachter Audiomix/);
  detectors[0]?.onError('second error');
});

test('local bridge must connect before provider startup while original playback is already restored', async () => {
  await start('bridge', { inputOffer: 'v=0\r\nm=audio' });
  await waitFor(() => messages.some(message => message.type === 'offscreen-input-answer'));
  assert.equal(clients.length, 0);
  assert.equal(contexts[0]?.sources[0]?.connections[0], contexts[0]?.gains[0]);
  await emit({ type: 'offscreen-update-output', sessionId: 'bridge', settings: { translationVolume: 0 } });
  peers[0]?.change('connected'); await ready();
  assert.equal(contexts[0]?.gains[2]?.gain.value, 0);
  assert.ok(messages.some(message => message.type === 'ducking-telemetry' &&
    (message.telemetry as { inputIndependent: boolean }).inputIndependent));
  peers[0]?.change('disconnected');
  assert.ok(messages.some(message => message.type === 'offscreen-error'));
  assert.equal(contexts[0]?.state, 'closed');
});

test('failed local bridge connection never opens a paid provider session', async () => {
  await start('bridge-failed', { inputOffer: 'v=0\r\nm=audio' });
  await waitFor(() => messages.some(message => message.type === 'offscreen-input-answer'));
  peers[0]?.change('failed');
  await waitFor(() => messages.some(message => message.type === 'offscreen-error'));
  assert.equal(clients.length, 0);
  assert.equal(contexts[0]?.state, 'closed');
});

test('stop during local bridge negotiation immediately releases original playback and capture', async () => {
  const media = new Stream();
  capture = async () => media;
  await start('pending-bridge', { inputOffer: 'v=0\r\nm=audio' });
  await waitFor(() => messages.some(message => message.type === 'offscreen-input-answer'));
  await emit({ type: 'offscreen-stop' });
  assert.equal(contexts[0]?.state, 'closed');
  assert.equal(peers[0]?.connectionState, 'closed');
  assert.equal(media.tracks[0]?.stopped, true);
  assert.equal(clients.length, 0);
  await Promise.resolve();
  assert.equal(messages.some(message => message.type === 'offscreen-error'), false, 'intentional cancellation must not become a session failure');
});

test('graceful stop drains once, reports incomplete finalization, and filters late callbacks', async () => {
  await start(); await ready();
  const gate = deferred<void>(); finishGate = gate.promise;
  finishError = new Error('finalization timed out');
  const first = emit({ type: 'offscreen-stop' });
  const second = emit({ type: 'offscreen-stop' });
  assert.equal(clientStops, 0);
  gate.resolve();
  assert.deepEqual(await first, { ok: true, finalizationError: 'finalization timed out' });
  assert.deepEqual(await second, { ok: true, finalizationError: 'finalization timed out' });
  assert.equal(clientStops, 1);
  const before = messages.length;
  clients[0]?.onTranscript({ kind: 'complete', lane: 'target' });
  assert.equal(messages.length, before);
});
