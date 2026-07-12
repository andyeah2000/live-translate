import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SOFT_LIMIT_CEILING,
  SOFT_LIMIT_KNEE,
  createSoftLimiterCurve,
  softLimitInPlace,
  softLimitSample
} from '../src/offscreen/soft-limiter';

test('soft limiter is transparent below its knee and bounded above it', () => {
  for (const sample of [-0.8, -0.5, 0, 0.5, 0.8]) {
    assert.equal(softLimitSample(sample), sample);
  }
  assert.ok(Math.abs(softLimitSample(100)) <= SOFT_LIMIT_CEILING);
  assert.ok(Math.abs(softLimitSample(-100)) <= SOFT_LIMIT_CEILING);
  assert.equal(softLimitSample(Number.NaN), 0);
});

test('soft limiter is continuous, monotonic and symmetric at the knee', () => {
  const epsilon = 1e-6;
  const below = softLimitSample(SOFT_LIMIT_KNEE - epsilon);
  const above = softLimitSample(SOFT_LIMIT_KNEE + epsilon);
  assert.ok(above >= below);
  assert.ok(above - below < epsilon * 3);
  let previous = softLimitSample(0);
  for (let value = 0.001; value <= 3; value += 0.001) {
    const current = softLimitSample(value);
    assert.ok(current >= previous);
    assert.ok(Math.abs(current + softLimitSample(-value)) < 1e-6);
    previous = current;
  }
});

test('in-place limiter and WaveShaper curve never exceed the ceiling', () => {
  const samples = new Float32Array([-2, -0.8, -0.25, 0.25, 0.8, 2]);
  softLimitInPlace(samples);
  assert.equal(samples[2], -0.25);
  assert.equal(samples[3], 0.25);
  assert.ok(samples.every((sample) => Math.abs(sample) < SOFT_LIMIT_CEILING));

  const curve = createSoftLimiterCurve();
  assert.equal(curve.length, 65_537);
  assert.ok(curve.every((sample) => Math.abs(sample) <= SOFT_LIMIT_CEILING));
  assert.ok(Math.abs(curve[32_768] ?? 1) < 1e-7);
});
