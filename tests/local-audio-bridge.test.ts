import assert from 'node:assert/strict';
import test from 'node:test';
import { gatherLocalDescription, validAudioSdp } from '../src/local-audio-bridge';

test('local bridge only accepts bounded SDP', () => {
  assert.equal(validAudioSdp('v=0\r\n'), true);
  assert.equal(validAudioSdp({ sdp: 'v=0' }), false);
  assert.equal(validAudioSdp('v=0' + 'x'.repeat(65_536)), false);
  assert.equal(validAudioSdp('https://example.com'), false);
});

test('completed local ICE returns SDP unchanged and rejects missing description', async () => {
  assert.equal(await gatherLocalDescription({ iceGatheringState: 'complete', localDescription: { sdp: 'v=0\r\n' } } as RTCPeerConnection), 'v=0\r\n');
  await assert.rejects(gatherLocalDescription({ iceGatheringState: 'complete', localDescription: null } as RTCPeerConnection), /ohne SDP/);
});

test('local ICE gathering waits for completion and removes its listener', async () => {
  const peer = Object.assign(new EventTarget(), { iceGatheringState: 'gathering', localDescription: { sdp: 'v=0\r\n' } });
  let removed = false;
  const remove = peer.removeEventListener.bind(peer);
  peer.removeEventListener = (...args) => { removed = true; remove(...args); };
  const pending = gatherLocalDescription(peer as unknown as RTCPeerConnection);
  peer.iceGatheringState = 'complete';
  peer.dispatchEvent(new Event('icegatheringstatechange'));
  assert.equal(await pending, 'v=0\r\n');
  assert.equal(removed, true);
});
