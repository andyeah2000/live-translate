import assert from 'node:assert/strict';
import test from 'node:test';
import { SpeechProbabilityDetector } from '../src/offscreen/voice-detector';

test('low Silero probabilities and invalid data never activate ducking', () => {
  const detector = new SpeechProbabilityDetector();
  for (const probability of [0, 0.1, 0.54, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(detector.update(probability).speaking, false);
  }
});

test('two moderate positive neural frames within three activate source ducking', () => {
  const detector = new SpeechProbabilityDetector();
  assert.equal(detector.update(0.65).speaking, false);
  assert.equal(detector.update(0.1).speaking, false);
  assert.equal(detector.update(0.65).speaking, true);
});

test('a highly confident neural frame activates ducking immediately', () => {
  const detector = new SpeechProbabilityDetector();
  assert.equal(detector.update(0.9).speaking, true);
});

test('384ms strong-negative hangover bridges word pauses and then releases deterministically', () => {
  const detector = new SpeechProbabilityDetector();
  detector.update(0.9);
  detector.update(0.9);
  for (let frame = 0; frame < 11; frame++) {
    assert.equal(detector.update(0.2).speaking, true, `negative frame ${frame + 1}`);
  }
  assert.equal(detector.update(0.2).speaking, false);
});

test('ambiguous Silero probabilities release after a bounded 736ms', () => {
  const detector = new SpeechProbabilityDetector();
  detector.update(0.9);
  for (let frame = 0; frame < 22; frame++) {
    assert.equal(detector.update(0.5).speaking, true, `ambiguous frame ${frame + 1}`);
  }
  assert.equal(detector.update(0.5).speaking, false);
});

test('a positive speech frame resets the accumulated release score', () => {
  const detector = new SpeechProbabilityDetector();
  detector.update(0.9);
  for (let frame = 0; frame < 11; frame++) detector.update(0.5);
  assert.equal(detector.update(0.56).speaking, true);
  for (let frame = 0; frame < 22; frame++) {
    assert.equal(detector.update(0.5).speaking, true);
  }
  assert.equal(detector.update(0.5).speaking, false);
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
