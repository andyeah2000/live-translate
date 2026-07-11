import assert from 'node:assert/strict';
import test from 'node:test';
import { isFreshCapture } from '../src/offscreen/neural-vad';

test('stale, invalid and future VAD results are rejected fail-open', () => {
  assert.equal(isFreshCapture(1_000, 1_000), true);
  assert.equal(isFreshCapture(1_000, 1_250), true);
  assert.equal(isFreshCapture(1_000, 1_251), false);
  assert.equal(isFreshCapture(1_001, 1_000), false);
  assert.equal(isFreshCapture(Number.NaN, 1_000), false);
});
