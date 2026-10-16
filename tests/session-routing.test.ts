import assert from 'node:assert/strict';
import test from 'node:test';
import {
  belongsToActiveSession,
  shouldStartOffscreenSession,
  waitForLocalAudioConnection
} from '../src/offscreen/session-routing';

test('duplicate pending or active starts only acknowledge the one-shot capture ID', () => {
  assert.equal(shouldStartOffscreenSession(null, null, 'new'), true);
  assert.equal(shouldStartOffscreenSession(null, 'same', 'same'), false);
  assert.equal(shouldStartOffscreenSession('same', null, 'same'), false);
  assert.equal(shouldStartOffscreenSession('old', 'older', 'new'), true);
});

test('stale output settings can never cross an offscreen session boundary', () => {
  assert.equal(belongsToActiveSession('session-b', 'session-b'), true);
  assert.equal(belongsToActiveSession('session-b', 'session-a'), false);
  assert.equal(belongsToActiveSession(null, 'session-a'), false);
});

class LocalPeer extends EventTarget {
  connectionState = 'new';
  change(state: string) {
    this.connectionState = state;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}

test('local input must actually connect before the provider may start', async () => {
  const peer = new LocalPeer();
  let ready = false;
  const pending = waitForLocalAudioConnection(peer as unknown as RTCPeerConnection, 50).then(() => { ready = true; });
  peer.change('connecting');
  await Promise.resolve();
  assert.equal(ready, false);
  peer.change('connected');
  await pending;
  assert.equal(ready, true);
  await waitForLocalAudioConnection(peer as unknown as RTCPeerConnection, 50);
});

test('unreachable or closed local input fails instead of starting silent translation', async () => {
  for (const state of ['failed', 'disconnected', 'closed']) {
    const peer = new LocalPeer();
    const pending = waitForLocalAudioConnection(peer as unknown as RTCPeerConnection, 50);
    peer.change(state);
    await assert.rejects(pending, /Videoeingang wurde unterbrochen/);
    // A late connected event cannot resurrect the failed waiter.
    peer.change('connected');
  }
  await assert.rejects(waitForLocalAudioConnection(new LocalPeer() as unknown as RTCPeerConnection, 10), /nicht rechtzeitig/);
});
