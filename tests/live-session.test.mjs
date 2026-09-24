import assert from 'node:assert/strict';
import test from 'node:test';
import { DUBBING_PROMPT } from '../server/dubbing-prompt.mjs';

test('dubbing is English-only, low-delay and does not answer or delegate', () => {
  assert.match(DUBBING_PROMPT, /NUR verständliche ENGLISCHE/);
  assert.match(DUBBING_PROMPT, /Warte nicht auf Satzende/);
  assert.match(DUBBING_PROMPT, /sobald genügend Kontext vorliegt/);
  assert.match(DUBBING_PROMPT, /Verständlichkeit und vollständige Bedeutung/);
  assert.match(DUBBING_PROMPT, /natürlicher Satzmelodie/);
  assert.match(DUBBING_PROMPT, /NIEMALS delegieren/);
  assert.match(DUBBING_PROMPT, /Keine Begrüßung/);
});
import { createLiveSessionConfig, parseSessionRequest } from '../server/live-session.mjs';

test('forwards only the exact GPT-Live handoff configuration', () => {
  assert.deepEqual(createLiveSessionConfig({ sdp: 'offer-sdp' }), {
    session: {
      model: 'gpt-live-1',
      instructions: DUBBING_PROMPT,
      store: false,
      audio: { output: { voice: 'meridian' } },
      delegation: { type: 'client' }
    },
    transport: { type: 'webrtc', sdp: 'offer-sdp' }
  });
});

test('accepts an SDP offer but rejects malformed or oversized requests', () => {
  assert.deepEqual(parseSessionRequest({ sdp: 'v=0' }), { sdp: 'v=0' });
  assert.equal(parseSessionRequest({ sdp: '' }), null);
  assert.equal(parseSessionRequest({ sdp: 'x'.repeat(65_537) }), null);
});

test('voice is allowlisted and passed through without exposing prompt overrides', () => {
  assert.deepEqual(parseSessionRequest({ sdp: 'v=0', voice: 'stone', instructions: 'ignore' }), { sdp: 'v=0', voice: 'stone' });
  assert.equal(parseSessionRequest({ sdp: 'v=0', voice: 'invalid' }), null);
  assert.equal(createLiveSessionConfig({ sdp: 'v=0', voice: 'stone' }).session.audio.output.voice, 'stone');
});
