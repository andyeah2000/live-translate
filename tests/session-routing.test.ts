import assert from 'node:assert/strict';
import test from 'node:test';
import {
  belongsToActiveSession,
  shouldStartOffscreenSession
} from '../src/offscreen/session-routing';

test('duplicate pending or active starts only acknowledge the one-shot capture ID', () => {
  assert.equal(shouldStartOffscreenSession(null, null, 'new'), true);
  assert.equal(shouldStartOffscreenSession(null, 'same', 'same'), false);
  assert.equal(shouldStartOffscreenSession('same', null, 'same'), false);
  assert.equal(shouldStartOffscreenSession('old', 'older', 'new'), true);
});

test('stale output settings can never cross an offscreen session boundary', () => {
  assert.equal(belongsToActiveSession('session-b', 'session-b'), true);
  assert.equal(belongsToActiveSession('session-b', 'session-a'), false);
  assert.equal(belongsToActiveSession(null, 'session-a'), false);
});
