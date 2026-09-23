// Local validation only: never sends a valid SDP to OpenAI.
// node --env-file=.env.local tests/probe-auth.mjs
import assert from 'node:assert/strict';

const base = process.env.LIVE_TRANSLATE_BASE_URL || 'http://127.0.0.1:8787';
const token = process.env.LIVE_TRANSLATE_SERVER_TOKEN;
if (!token) throw new Error('LIVE_TRANSLATE_SERVER_TOKEN fehlt.');
const origin = process.env.LIVE_TRANSLATE_ALLOWED_ORIGIN || 'chrome-extension://pabimabnjfgjelfjpedgnlnmhibkpmbl';
for (const [label, headers, expected] of [
  ['ohne Token', { Origin: origin }, 401],
  ['falsches Token', { Origin: origin, 'X-Live-Translate-Token': 'invalid' }, 401],
  ['fremde Origin', { Origin: 'https://attacker.example', 'X-Live-Translate-Token': token }, 403],
  ['ungültiges SDP', { Origin: origin, 'X-Live-Translate-Token': token }, 400]
]) {
  const response = await fetch(`${base}/api/live/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ sdp: '' }),
    signal: AbortSignal.timeout(5000)
  });
  await response.arrayBuffer();
  assert.equal(response.status, expected, label);
  console.log(`${label}: ${response.status} OK`);
}
