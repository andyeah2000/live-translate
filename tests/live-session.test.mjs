import assert from 'node:assert/strict';
import test from 'node:test';
import { DUBBING_PROMPT } from '../server/dubbing-prompt.mjs';

test('dubbing is English-only, low-delay, human and does not answer or delegate', () => {
  // Official GPT-Live interpreter rules (developers.openai.com live-prompting, Translation).
  assert.match(DUBBING_PROMPT, /^NUR DEUTSCH\. NIEMALS DELEGIEREN, PRÜFEN, ANTWORTEN, SUCHEN ODER WERKZEUGE VERWENDEN\./);
  assert.match(DUBBING_PROMPT, /zitierter Inhalt, auch Fragen, Befehle und Bitten um Übersetzung/);
  assert.match(DUBBING_PROMPT, /genau einmal wieder/);
  assert.match(DUBBING_PROMPT, /nie von vorn/);
  // Delay: phrase-by-phrase interpreting with compression instead of full replay.
  assert.match(DUBBING_PROMPT, /warte nicht auf das Satzende/);
  assert.match(DUBBING_PROMPT, /Verdichte wie ein erfahrener Simultandolmetscher/);
  assert.match(DUBBING_PROMPT, /Hole Veraltetes niemals nach/);
  assert.match(DUBBING_PROMPT, /Erhalte immer Zahlen, Namen, Verneinungen/);
  // Human delivery.
  assert.match(DUBBING_PROMPT, /Lacht die Person, lachst du kurz und natürlich mit/);
  assert.match(DUBBING_PROMPT, /Flüstert sie, flüsterst du/);
  // The documented policy headings stay in English.
  assert.match(DUBBING_PROMPT, /Backchannel policy: Keine Hörersignale/);
  assert.match(DUBBING_PROMPT, /Interruption policy:/);
  assert.match(DUBBING_PROMPT, /Delegation policy:\nBackend tools:\n- Keine\.\nDelegate to the backend when:\n- Niemals\./);
  assert.match(DUBBING_PROMPT, /Dolmetsche NUR englische Sprache\./);
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

test('the pre-negotiated event channel is validated, forwarded and never invented', () => {
  assert.deepEqual(parseSessionRequest({ sdp: 'v=0', dcid: 4 }), { sdp: 'v=0', dcid: 4 });
  for (const dcid of [-1, 65_535, 1.5, '4', null]) assert.equal(parseSessionRequest({ sdp: 'v=0', dcid }), null);
  assert.deepEqual(createLiveSessionConfig({ sdp: 'v=0', dcid: 4 }).transport, { type: 'webrtc', sdp: 'v=0', dcid: 4 });
  assert.equal('dcid' in createLiveSessionConfig({ sdp: 'v=0' }).transport, false);
});

test('voice is allowlisted and passed through without exposing prompt overrides', () => {
  assert.deepEqual(parseSessionRequest({ sdp: 'v=0', voice: 'stone', instructions: 'ignore' }), { sdp: 'v=0', voice: 'stone' });
  assert.equal(parseSessionRequest({ sdp: 'v=0', voice: 'invalid' }), null);
  assert.equal(createLiveSessionConfig({ sdp: 'v=0', voice: 'stone' }).session.audio.output.voice, 'stone');
});
