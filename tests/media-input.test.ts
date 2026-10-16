import assert from 'node:assert/strict';
import test from 'node:test';
import { installMediaInput } from '../src/media-input';

test('direct input acknowledges negotiation and cleans failures without stopping a replacement session', async () => {
  const names = ['chrome', 'document', 'window', 'HTMLMediaElement', 'RTCPeerConnection', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] as const;
  const previous = Object.fromEntries(names.map(name => [name, (globalThis as Record<string, unknown>)[name]]));
  type CapturedTrack = { kind: string; readyState: string; stopped: boolean; onended?: (() => void) | null; stop(): void };
  const tracks: CapturedTrack[] = [];
  const streams: Array<{ onaddtrack?: ((event: { track: CapturedTrack }) => void) | null; add(track: CapturedTrack): void }> = [];
  const replacements: CapturedTrack[] = [];
  let replacement: () => Promise<void> = async () => {};
  let recovery: (() => void) | null = null;
  let listener!: (message: Record<string, unknown>, sender: { id: string }, respond: (value: unknown) => void) => unknown;
  let pagehide!: () => void;
  let health!: () => void;
  let answer: () => Promise<void> = async () => {};
  const peers: PeerMock[] = [];
  const newTrack = (kind: string): CapturedTrack => ({
    kind, readyState: 'live', stopped: false,
    stop() { this.stopped = true; this.readyState = 'ended'; }
  });
  class MediaMock {
    paused = false;
    ended = false;
    readyState = 4;
    clientWidth = 640;
    clientHeight = 360;
    captureStream() {
      const captured = ['audio', 'video'].map(newTrack);
      tracks.push(...captured);
      const stream = {
        onaddtrack: null as ((event: { track: CapturedTrack }) => void) | null,
        getTracks: () => captured,
        getAudioTracks: () => captured.filter(track => track.kind === 'audio'),
        getVideoTracks: () => captured.filter(track => track.kind === 'video'),
        removeTrack: (track: CapturedTrack) => captured.splice(captured.indexOf(track), 1),
        add(track: CapturedTrack) { captured.push(track); tracks.push(track); this.onaddtrack?.({ track }); }
      };
      streams.push(stream);
      return stream;
    }
  }
  class PeerMock {
    closed = false;
    iceGatheringState = 'complete';
    localDescription = { sdp: 'v=0\r\n' };
    constructor() { peers.push(this); }
    addTrack() { return { replaceTrack(track: CapturedTrack) { replacements.push(track); return replacement(); } }; }
    createOffer = async () => this.localDescription;
    setLocalDescription = async () => {};
    setRemoteDescription = () => answer();
    close() { this.closed = true; }
  }
  const runtime = { id: 'test', onMessage: { addListener: (handler: typeof listener) => { listener = handler; } } };
  Object.assign(globalThis, {
    chrome: { runtime },
    document: { querySelectorAll: () => [new MediaMock()] },
    window: { addEventListener: (event: string, handler: () => void) => { if (event === 'pagehide') pagehide = handler; } },
    HTMLMediaElement: MediaMock,
    RTCPeerConnection: PeerMock,
    setInterval: (handler: () => void) => { health = handler; return 1; },
    clearInterval: () => {},
    setTimeout: (handler: () => void) => { recovery = handler; return 1; },
    clearTimeout: () => { recovery = null; }
  });
  const request = (message: Record<string, unknown>) => new Promise<unknown>(resolve => {
    const result = listener(message, { id: 'test' }, resolve);
    if (result !== true) resolve(undefined);
  });
  try {
    installMediaInput();
    assert.equal(listener({ type: 'media-input-offer', sessionId: 'foreign' }, { id: 'other-extension' }, () => assert.fail()), undefined);
    assert.deepEqual(await request({ type: 'media-input-offer', sessionId: 'a' }), { sdp: 'v=0\r\n' });
    assert.equal(tracks.find(track => track.kind === 'video')!.stopped, true);
    assert.deepEqual(await request({ type: 'media-input-answer', sessionId: 'a', sdp: 'v=0\r\n' }), { ok: true });
    assert.equal((await request({ type: 'media-input-answer', sessionId: 'old', sdp: 'v=0\r\n' }) as { ok: boolean }).ok, false);
    assert.equal(peers[0]!.closed, false, 'a stale answer must not stop the active capture');

    answer = async () => { throw new Error('rejected'); };
    const rejected = await request({ type: 'media-input-answer', sessionId: 'a', sdp: 'v=0\r\n' }) as { ok: boolean; error: string };
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /Audioverbindung/);
    assert.equal(peers[0]!.closed, true);
    assert.equal(tracks.every(track => track.stopped), true);

    await request({ type: 'media-input-offer', sessionId: 'b' });
    let rejectOld!: (error: Error) => void;
    answer = () => new Promise((_resolve, reject) => { rejectOld = reject; });
    const pending = request({ type: 'media-input-answer', sessionId: 'b', sdp: 'v=0\r\n' });
    await request({ type: 'media-input-offer', sessionId: 'c' });
    rejectOld(new Error('late failure'));
    assert.equal((await pending as { ok: boolean }).ok, false);
    assert.equal(peers.at(-1)!.closed, false, 'a late negotiation failure must not stop a replacement capture');
    tracks[0]!.onended!();
    assert.equal(peers.at(-1)!.closed, false, 'an old ended track must not stop a replacement capture');
    const oldAudio = tracks.filter(track => track.kind === 'audio').at(-1)!;
    oldAudio.readyState = 'ended'; oldAudio.onended!();
    assert.equal(peers.at(-1)!.closed, false, 'source replacement gets a bounded recovery window');
    const replacementAudio = newTrack('audio');
    streams.at(-1)!.add(replacementAudio);
    const replacementVideo = newTrack('video');
    streams.at(-1)!.add(replacementVideo);
    await Promise.resolve();
    assert.deepEqual(replacements, [replacementAudio]);
    assert.equal(recovery, null, 'successful track replacement cancels the no-audio deadline');
    assert.equal(replacementVideo.stopped, true, 'later video tracks must also be discarded');
    assert.equal(peers.at(-1)!.closed, false, 'source replacement retains the existing peer and paid session');
    replacementAudio.readyState = 'ended'; replacementAudio.onended!();
    (recovery as (() => void) | null)?.();
    assert.equal(peers.at(-1)!.closed, true, 'a permanently ended source eventually closes the bridge');
    await request({ type: 'media-input-offer', sessionId: 'd' });
    assert.deepEqual(await request({ type: 'media-input-stop', sessionId: 'old' }), { ok: true });
    assert.equal(peers.at(-1)!.closed, false, 'late scoped cleanup preserves the replacement bridge');
    assert.deepEqual(await request({ type: 'media-input-stop', sessionId: 'd' }), { ok: true });
    assert.equal(peers.at(-1)!.closed, true);
    await request({ type: 'media-input-offer', sessionId: 'e' });
    pagehide();
    assert.equal(peers.at(-1)!.closed, true);
    assert.equal(tracks.every(track => track.stopped), true);
    await request({ type: 'media-input-offer', sessionId: 'f' });
    const failedAudio = tracks.filter(track => track.kind === 'audio').at(-1)!;
    failedAudio.readyState = 'ended'; failedAudio.onended!();
    let rejectReplacement!: (error: Error) => void;
    replacement = () => new Promise((_resolve, reject) => { rejectReplacement = reject; });
    streams.at(-1)!.add(newTrack('audio'));
    await request({ type: 'media-input-offer', sessionId: 'g' });
    rejectReplacement(new Error('late replacement failure'));
    await Promise.resolve();
    assert.equal(peers.at(-1)!.closed, false, 'a stale replacement failure cannot stop the new capture');
    const currentAudio = tracks.filter(track => track.kind === 'audio').at(-1)!;
    currentAudio.readyState = 'ended'; currentAudio.onended!();
    replacement = async () => { throw new Error('replacement rejected'); };
    streams.at(-1)!.add(newTrack('audio'));
    await Promise.resolve();
    assert.equal(peers.at(-1)!.closed, true, 'a rejected current replacement closes the failed bridge');
    runtime.id = '';
    health();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete (globalThis as Record<string, unknown>)[name];
      else (globalThis as Record<string, unknown>)[name] = previous[name];
    }
  }
});
