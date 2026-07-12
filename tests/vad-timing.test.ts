import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasCaptureDiscontinuity,
  outputFrameEndTime,
  pushBoundedFifo,
  type CaptureStamp
} from '../src/offscreen/vad-timing';

const stamp = (
  sequence: number,
  captureEndTime: number,
  sampleCount = 2_048
): CaptureStamp => ({ sequence, captureEndTime, sampleCount });

test('capture continuity requires consecutive sequence and monotone AudioContext time', () => {
  const rate = 48_000;
  const first = stamp(7, 12);
  assert.equal(hasCaptureDiscontinuity(null, first, rate), false);
  assert.equal(
    hasCaptureDiscontinuity(first, stamp(8, 12 + 2_048 / rate), rate),
    false
  );
  assert.equal(hasCaptureDiscontinuity(first, stamp(9, 12 + 2_048 / rate), rate), true);
  assert.equal(hasCaptureDiscontinuity(first, stamp(8, 12), rate), true);
  assert.equal(hasCaptureDiscontinuity(first, stamp(8, 13), rate), true);
  assert.equal(hasCaptureDiscontinuity(first, stamp(-1, 12.1), rate), true);
});

test('frame timestamps identify the exact end inside a resampled block', () => {
  assert.equal(outputFrameEndTime(10, 683, 171, 16_000), 9.968);
  assert.equal(outputFrameEndTime(10, 683, 683, 16_000), 10);
  assert.equal(Number.isNaN(outputFrameEndTime(10, 100, 101, 16_000)), true);
});

test('bounded FIFO retains the newest two items in processing order', () => {
  const queue: number[] = [];
  assert.equal(pushBoundedFifo(queue, 1, 2), false);
  assert.equal(pushBoundedFifo(queue, 2, 2), false);
  assert.equal(pushBoundedFifo(queue, 3, 2), true);
  assert.deepEqual(queue, [2, 3]);
  assert.equal(queue.shift(), 2);
  assert.equal(queue.shift(), 3);
  assert.throws(() => pushBoundedFifo(queue, 4, 0), /FIFO/);
});
