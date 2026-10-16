import assert from 'node:assert/strict';
import test from 'node:test';
import { installMediaInput } from '../src/media-input';

test('direct input acknowledges negotiation and cleans failures without stopping a replacement session', async () => {
  const names = ['chrome', 'document', 'window', 'HTMLMediaElement', 'RTCPeerConnection', 'setInterval', 'clearInterval'] as const;
  const previous = Object.fromEntries(names.map(name => [name, (globalThis as Record<string, unknown>)[name]]));
  const tracks: Array<{ kind: string; stopped: boolean; onended?: () => void; stop(): void }> = [];
  let listener!: (message: Record<string, unknown>, sender: { id: string }, respond: (value: unknown) => void) => unknown;
  let pagehide!: () => void;
  let health!: () => void;
  let answer: () => Promise<void> = async () => {};
  const peers: PeerMock[] = [];
  class MediaMock {
    paused = false;
    ended = false;
    readyState = 4;
    clientWidth = 640;
    clientHeight = 360;
    captureStream() {
      const captured = ['audio', 'video'].map(kind => ({ kind, stopped: false, stop() { this.stopped = true; } }));
      tracks.push(...captured);
      return {
        getTracks: () => captured,
        getAudioTracks: () => captured.filter(track => track.kind === 'audio'),
        getVideoTracks: () => captured.filter(track => track.kind === 'video'),
        removeTrack: (track: typeof captured[number]) => captured.splice(captured.indexOf(track), 1)
      };
    }
  }
  class PeerMock {
    closed = false;
    iceGatheringState = 'complete';
    localDescription = { sdp: 'v=0\r\n' };
    constructor() { peers.push(this); }
    addTrack() {}
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
    clearInterval: () => {}
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
    tracks.filter(track => track.kind === 'audio').at(-1)!.onended!();
    assert.equal(peers.at(-1)!.closed, true, 'ending the media source closes the direct bridge');
    await request({ type: 'media-input-offer', sessionId: 'd' });
    assert.deepEqual(await request({ type: 'media-input-stop', sessionId: 'old' }), { ok: true });
    assert.equal(peers.at(-1)!.closed, false, 'late scoped cleanup preserves the replacement bridge');
    assert.deepEqual(await request({ type: 'media-input-stop', sessionId: 'd' }), { ok: true });
    assert.equal(peers.at(-1)!.closed, true);
    await request({ type: 'media-input-offer', sessionId: 'e' });
    pagehide();
    assert.equal(peers.at(-1)!.closed, true);
    assert.equal(tracks.every(track => track.stopped), true);
    runtime.id = '';
    health();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete (globalThis as Record<string, unknown>)[name];
      else (globalThis as Record<string, unknown>)[name] = previous[name];
    }
  }
});
