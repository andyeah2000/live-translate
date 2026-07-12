import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAPTURE_BATCH_MS,
  MAX_PREROLL_AUDIO_MS,
  SEND_CHUNK_MS,
  reconnectDelayMs,
  samplesForDuration
} from '../src/offscreen/stream-timing';

test('capture is fine-grained while model uplink follows its documented chunk size', () => {
  assert.equal(CAPTURE_BATCH_MS, 20);
  assert.equal(SEND_CHUNK_MS, 100);
  assert.ok(MAX_PREROLL_AUDIO_MS <= 500);
  assert.equal(samplesForDuration(44_100, CAPTURE_BATCH_MS), 882);
  assert.equal(samplesForDuration(48_000, CAPTURE_BATCH_MS), 960);
  assert.equal(samplesForDuration(96_000, CAPTURE_BATCH_MS), 1_920);
});

test('network recovery starts quickly and remains bounded', () => {
  assert.deepEqual(
    Array.from({ length: 9 }, (_, index) => reconnectDelayMs(index + 1)),
    [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
  );
});
