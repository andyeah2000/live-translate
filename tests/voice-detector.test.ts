import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DUCKED_SOURCE_GAIN,
  SpeechProbabilityDetector,
  sourceDuckGain,
  sourcePathMix
} from '../src/offscreen/voice-detector';

test('no source speech always means exact 0 dB / 100% source audio', () => {
  assert.equal(
    sourceDuckGain({
      dubbing: true,
      fullOriginal: false,
      sourceSpeaking: false,
      translationReady: true
    }),
    1
  );
  assert.equal(
    sourceDuckGain({
      dubbing: false,
      fullOriginal: false,
      sourceSpeaking: true,
      translationReady: true
    }),
    1
  );
});

test('source speech always applies the fixed ten-percent full-mix level', () => {
  assert.equal(DUCKED_SOURCE_GAIN, 0.1);
  assert.equal(
    sourceDuckGain({
      dubbing: true,
      fullOriginal: false,
      sourceSpeaking: true,
      translationReady: true
    }),
    0.1
  );
});

test('Gemini setup and reconnect are fail-open at exact 100% source audio', () => {
  assert.equal(
    sourceDuckGain({
      dubbing: true,
      fullOriginal: false,
      sourceSpeaking: true,
      translationReady: false
    }),
    1
  );
});

test('full-original mode uses a literal dry-only bypass path', () => {
  assert.deepEqual(sourcePathMix({ dubbing: true, fullOriginal: true }), {
    dry: 1,
    dynamic: 0
  });
  assert.deepEqual(sourcePathMix({ dubbing: false, fullOriginal: false }), {
    dry: 1,
    dynamic: 0
  });
  assert.deepEqual(sourcePathMix({ dubbing: true, fullOriginal: false }), {
    dry: 0,
    dynamic: 1
  });
  assert.equal(
    sourceDuckGain({
      dubbing: true,
      fullOriginal: true,
      sourceSpeaking: true,
      translationReady: true
    }),
    1
  );
});

test('low Silero probabilities and invalid data never activate ducking', () => {
  const detector = new SpeechProbabilityDetector();
  for (const probability of [0, 0.1, 0.54, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(detector.update(probability).speaking, false);
  }
});

test('two positive neural frames within three activate source ducking', () => {
  const detector = new SpeechProbabilityDetector();
  assert.equal(detector.update(0.7).speaking, false);
  assert.equal(detector.update(0.1).speaking, false);
  assert.equal(detector.update(0.7).speaking, true);
});

test('a highly confident neural frame activates ducking immediately', () => {
  const detector = new SpeechProbabilityDetector();
  assert.equal(detector.update(0.9).speaking, true);
});

test('320ms hangover bridges word pauses and then releases deterministically', () => {
  const detector = new SpeechProbabilityDetector();
  detector.update(0.9);
  detector.update(0.9);
  for (let frame = 0; frame < 9; frame++) {
    assert.equal(detector.update(0.2).speaking, true, `negative frame ${frame + 1}`);
  }
  assert.equal(detector.update(0.2).speaking, false);
});

test('ambiguous Silero probabilities release after a bounded 640ms', () => {
  const detector = new SpeechProbabilityDetector();
  detector.update(0.9);
  for (let frame = 0; frame < 19; frame++) {
    assert.equal(detector.update(0.4).speaking, true, `ambiguous frame ${frame + 1}`);
  }
  assert.equal(detector.update(0.4).speaking, false);
});

test('a positive speech frame resets the accumulated release score', () => {
  const detector = new SpeechProbabilityDetector();
  detector.update(0.9);
  for (let frame = 0; frame < 9; frame++) detector.update(0.4);
  assert.equal(detector.update(0.55).speaking, true);
  for (let frame = 0; frame < 19; frame++) {
    assert.equal(detector.update(0.4).speaking, true);
  }
  assert.equal(detector.update(0.4).speaking, false);
});

test('a natural mid-sentence pause never pumps the source gain', () => {
  const detector = new SpeechProbabilityDetector();
  detector.update(0.9);
  for (let frame = 0; frame < 7; frame++) {
    assert.equal(detector.update(0.1).speaking, true);
  }
  assert.equal(detector.update(0.8).speaking, true);
});

test('reset is fail-open and immediately restores full source audio', () => {
  const detector = new SpeechProbabilityDetector();
  detector.update(0.9);
  detector.update(0.9);
  assert.equal(detector.update(0.5).speaking, true);
  detector.reset();
  assert.equal(detector.update(0.5).speaking, false);
});
