import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceVoiceDetector, sourceDuckGain, sourcePathMix } from '../src/offscreen/voice-detector';

test('no source speech always means exact 0 dB / 100% source audio', () => {
  for (const backgroundVolume of [0, 0.15, 0.5, 1, Number.NaN]) {
    assert.equal(
      sourceDuckGain({ dubbing: true, fullOriginal: false, sourceSpeaking: false, backgroundVolume }),
      1
    );
  }
  assert.equal(
    sourceDuckGain({ dubbing: false, fullOriginal: false, sourceSpeaking: true, backgroundVolume: 0 }),
    1
  );
});

test('source speech applies the exact configured full-mix level', () => {
  assert.equal(sourceDuckGain({ dubbing: true, fullOriginal: false, sourceSpeaking: true, backgroundVolume: 1 }), 1);
  assert.equal(sourceDuckGain({ dubbing: true, fullOriginal: false, sourceSpeaking: true, backgroundVolume: 0 }), 0);
  assert.equal(sourceDuckGain({ dubbing: true, fullOriginal: false, sourceSpeaking: true, backgroundVolume: 0.1 }), 0.1);
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
    sourceDuckGain({ dubbing: true, fullOriginal: true, sourceSpeaking: true, backgroundVolume: 0 }),
    1
  );
});

test('silence and non-speech ambience never activate source ducking', () => {
  const detector = new SourceVoiceDetector();
  assert.equal(detector.update({ bandRms: 0, totalRms: 0, nowMs: 0 }).speaking, false);
  assert.equal(detector.update({ bandRms: 0.003, totalRms: 0.05, nowMs: 50 }).speaking, false);
  assert.equal(detector.update({ bandRms: 0.02, totalRms: 0.06, nowMs: 100 }).speaking, false);
  assert.equal(detector.update({ bandRms: Number.NaN, totalRms: 1, nowMs: 150 }).speaking, false);
});

test('source speech activates ducking and short syllable gaps do not pump', () => {
  const detector = new SourceVoiceDetector();
  assert.equal(detector.update({ bandRms: 0.025, totalRms: 0.035, nowMs: 0 }).speaking, true);
  assert.equal(detector.update({ bandRms: 0.004, totalRms: 0.03, nowMs: 50 }).speaking, true);
  assert.equal(detector.update({ bandRms: 0.01, totalRms: 0.02, nowMs: 70 }).speaking, true);
});

test('source silence releases ducking promptly back to full audio', () => {
  const detector = new SourceVoiceDetector();
  detector.update({ bandRms: 0.025, totalRms: 0.035, nowMs: 0 });
  assert.equal(detector.update({ bandRms: 0, totalRms: 0.02, nowMs: 79 }).speaking, true);
  assert.equal(detector.update({ bandRms: 0, totalRms: 0.02, nowMs: 80 }).speaking, false);
  assert.equal(detector.update({ bandRms: 0, totalRms: 0.02, nowMs: 500 }).speaking, false);
});
