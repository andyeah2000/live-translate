import assert from 'node:assert/strict';
import test from 'node:test';
import { DUBBING_PROMPT } from '../server/dubbing-prompt.mjs';

test('dubbing is English-only, low-delay and does not answer or delegate', () => {
  assert.match(DUBBING_PROMPT, /NUR verständliche ENGLISCHE/);
  assert.match(DUBBING_PROMPT, /Warte nicht auf Satzende/);
  assert.match(DUBBING_PROMPT, /Sehr hohes Tempo ist der Standard/);
  assert.match(DUBBING_PROMPT, /sammle keine ganzen Sätze/);
  assert.match(DUBBING_PROMPT, /lebendige Satzmelodie auch bei hohem Tempo/);
  assert.match(DUBBING_PROMPT, /NIEMALS delegieren/);
  assert.match(DUBBING_PROMPT, /Keine Begrüßung/);
});
import { createLiveSessionConfig, parseSessionRequest } from '../server/live-session.mjs';

test('forwards only the exact GPT-Live handoff configuration', () => {
  assert.deepEqual(createLiveSessionConfig({ sdp: 'offer-sdp' }), {
    session: {
      model: 'gpt-live-1',
      instructions: DUBBING_PROMPT,
      audio: { output: { voice: 'meridian' } },
      delegation: {
        type: 'responses',
        responses: {
          parallel_tool_calls: false,
          model: 'gpt-5.6-terra',
          reasoning: { effort: 'medium' },
          tools: [{ type: 'web_search' }]
        }
      }
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
