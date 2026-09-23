import assert from 'node:assert/strict';
import test from 'node:test';
import { dubbingSourceGain, OutputActivity } from '../src/offscreen/dubbing-mix';

test('original remains full without actual audible translation, including muted output', () => {
  assert.equal(dubbingSourceGain(true, false, 1), 1);
  assert.equal(dubbingSourceGain(true, true, 0), 1);
  assert.equal(dubbingSourceGain(true, true, NaN), 1);
  assert.equal(dubbingSourceGain(false, true, 1), 0.6);
  assert.equal(dubbingSourceGain(true, true, 1), 0.28);
});

test('decoded output activity bridges syllables but releases promptly', () => {
  const activity = new OutputActivity();
  const silence = new Float32Array(2048);
  assert.equal(activity.update(silence, 0), false);
  assert.equal(activity.update(new Float32Array(2048).fill(0.05), 10), true);
  assert.equal(activity.update(silence, 200), true);
  assert.equal(activity.update(silence, 231), false);
  assert.equal(activity.update(new Float32Array(2048).fill(0.00001), 300), false);
});
