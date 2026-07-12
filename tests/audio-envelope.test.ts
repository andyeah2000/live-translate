import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GEMINI_FADE_IN_S,
  GEMINI_INTERRUPT_FADE_S,
  GEMINI_FADE_OUT_S,
  SOURCE_DUCK_FADE_DOWN_S,
  SOURCE_DUCK_FADE_UP_S,
  applyCosineEdgeFades,
  cosineRamp,
  fadeOutAudioParam
} from '../src/offscreen/audio-envelope';

test('source ducking uses a gentle asymmetric studio-style envelope', () => {
  assert.ok(SOURCE_DUCK_FADE_DOWN_S >= 0.15);
  assert.ok(SOURCE_DUCK_FADE_UP_S >= 0.5);
  assert.ok(SOURCE_DUCK_FADE_UP_S > SOURCE_DUCK_FADE_DOWN_S);
});

test('cosine ramp is monotone, exact, and eases both endpoints', () => {
  const curve = cosineRamp(1, 0.1, 65);
  assert.equal(curve[0], 1);
  assert.ok(Math.abs(curve.at(-1)! - 0.1) < 1e-6);
  for (let index = 1; index < curve.length; index++) {
    assert.ok(curve[index] <= curve[index - 1]);
  }
  const firstStep = Math.abs(curve[1] - curve[0]);
  const middleStep = Math.abs(curve[33] - curve[32]);
  const lastStep = Math.abs(curve.at(-1)! - curve.at(-2)!);
  assert.ok(firstStep < middleStep / 10);
  assert.ok(lastStep < middleStep / 10);
});

test('Gemini edge fades remove one-sample jumps without touching the phrase middle', () => {
  assert.ok(GEMINI_FADE_IN_S >= 0.06);
  assert.ok(GEMINI_FADE_OUT_S >= 0.1);
  assert.ok(GEMINI_INTERRUPT_FADE_S >= 0.04);
  const samples = new Float32Array(1_000).fill(1);
  applyCosineEdgeFades(samples, 1_000, 0.1, 0.2);

  assert.equal(samples[0], 0);
  assert.equal(samples.at(-1), 0);
  assert.equal(samples[100], 1);
  assert.equal(samples[799], 1);
  for (let index = 1; index < 100; index++) assert.ok(samples[index] >= samples[index - 1]);
  for (let index = 801; index < samples.length; index++) {
    assert.ok(samples[index] <= samples[index - 1]);
  }
});

test('future Gemini fade-out ramps from the held scheduled value', () => {
  const calls: Array<{ method: string; time: number; value?: number }> = [];
  const param = {
    cancelAndHoldAtTime: (time: number) => calls.push({ method: 'hold', time }),
    linearRampToValueAtTime: (value: number, time: number) =>
      calls.push({ method: 'linear', time, value })
  } as unknown as AudioParam;

  fadeOutAudioParam(param, 10.5, 10.64);
  assert.deepEqual(calls, [
    { method: 'hold', time: 10.5 },
    { method: 'linear', time: 10.64, value: 0 }
  ]);
});
