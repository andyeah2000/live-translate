import assert from 'node:assert/strict';
import test from 'node:test';
import { resumeAudioContextWithTimeout } from '../src/offscreen/audio-context-state';

function fakeContext(
  state: AudioContextState,
  resume: () => Promise<void>
): AudioContext {
  return { state, resume } as unknown as AudioContext;
}

test('audio context resume succeeds only after the context is actually running', async () => {
  const running = fakeContext('running', async () => {});
  await resumeAudioContextWithTimeout(running, 50);

  const stillSuspended = fakeContext('suspended', async () => {});
  await assert.rejects(
    resumeAudioContextWithTimeout(stillSuspended, 50),
    /konnte nicht fortgesetzt werden.*suspended/
  );
});

test('audio context resume has a hard deadline', async () => {
  const stuck = fakeContext('suspended', () => new Promise<void>(() => {}));
  await assert.rejects(
    resumeAudioContextWithTimeout(stuck, 20),
    /reagiert nicht.*suspended/
  );
});
