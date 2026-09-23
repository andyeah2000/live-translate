import assert from 'node:assert/strict';
import test from 'node:test';
import { GptLiveTranslator } from '../src/offscreen/live';

for (const failure of ['missing-audio', 'server-rejection', 'cancel-ice'] as const) {
  test(`startup releases its peer after ${failure}`, async () => {
    let closed = false;
    let cancel: (() => void) | undefined;
    let fetchCount = 0;
    class Peer extends EventTarget {
      iceGatheringState = failure === 'cancel-ice' ? 'gathering' : 'complete';
      localDescription = { sdp: 'offer' };
      addTrack() {}
      createDataChannel() { return Object.assign(new EventTarget(), { close() {} }); }
      async createOffer() { return this.localDescription; }
      async setLocalDescription() {
        if (failure === 'cancel-ice') setTimeout(() => cancel?.(), 0);
      }
      close() { closed = true; }
    }
    const originals = new Map(['window', 'fetch', 'RTCPeerConnection'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: globalThis },
      RTCPeerConnection: { configurable: true, value: Peer },
      fetch: { configurable: true, value: async () => { fetchCount++; return new Response('{}', { status: 502 }); } }
    });
    const client = new GptLiveTranslator({
      ctx: {} as AudioContext,
      inputStream: { getAudioTracks: () => failure === 'missing-audio' ? [] : [{}] } as unknown as MediaStream,
      outputNode: {} as AudioNode, serverUrl: 'http://localhost:8787', serverToken: 'test',
      inputTranscriptionEnabled: true, onTranscript() {}, onStatus() {}, onReadyChange() {}, onError() {}
    });
    cancel = () => client.stop();
    try {
      await assert.rejects(client.start(), failure === 'missing-audio' ? /keine Audiospur/ : failure === 'cancel-ice' ? /beendet/ : /502/);
      assert.equal(closed, true);
      if (failure === 'cancel-ice') assert.equal(fetchCount, 0, 'cancelled startup must not create a paid session');
    } finally {
      client.stop();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
}

test('WebRTC waits for started, sends close once, and retains transport until final event', async () => {
  class Channel extends EventTarget {
    readyState = 'open';
    sent: string[] = [];
    send(value: string) { this.sent.push(value); }
    close() { this.readyState = 'closed'; }
    emit(type: string) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type, session: { id: 'opaque-id' } }) })); }
  }
  const channel = new Channel();
  let closed = false;
  class Peer extends EventTarget {
    iceGatheringState = 'complete';
    localDescription = { sdp: 'offer' };
    addTrack() {}
    createDataChannel() { return channel; }
    async createOffer() { return this.localDescription; }
    async setLocalDescription() {}
    async setRemoteDescription() { setTimeout(() => channel.emit('session.started'), 5); }
    getReceivers() { return []; }
    close() { closed = true; }
  }
  const originals = new Map(['window', 'fetch', 'RTCPeerConnection'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: globalThis },
    RTCPeerConnection: { configurable: true, value: Peer },
    fetch: { configurable: true, value: async () => new Response(JSON.stringify({ session: { id: 'opaque-id' }, transport: { sdp: 'answer' } })) }
  });
  const client = new GptLiveTranslator({
    ctx: {} as AudioContext, inputStream: { getAudioTracks: () => [{}] } as unknown as MediaStream,
    outputNode: {} as AudioNode, serverUrl: 'http://localhost:8787', serverToken: 'test',
    inputTranscriptionEnabled: true, onTranscript() {}, onStatus() {}, onReadyChange() {}, onError() {}
  });
  try {
    await client.start();
    assert.deepEqual(channel.sent, []);
    const finishing = client.finishInput(250);
    assert.equal(client.finishInput(250), finishing, 'concurrent close callers must await the same finalization');
    assert.equal(closed, false);
    assert.deepEqual(channel.sent.map(value => JSON.parse(value).type), ['session.close']);
    channel.emit('session.closed');
    await finishing;
    client.stop();
    assert.equal(closed, true);
  } finally {
    client.stop();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
