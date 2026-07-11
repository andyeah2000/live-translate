import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SpeechPreprocessor,
  base64FromInt16,
  floatToInt16,
  int16FromBase64,
  int16ToFloat
} from '../src/offscreen/pcm';

test('PCM16 conversion clamps input and round-trips bytes', () => {
  const pcm = floatToInt16(new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2]));
  assert.deepEqual(Array.from(pcm), [-32768, -32768, -16384, 0, 16383, 32767, 32767]);
  assert.deepEqual(Array.from(int16FromBase64(base64FromInt16(pcm))), Array.from(pcm));

  const floats = int16ToFloat(pcm);
  assert.equal(floats[0], -1);
  assert.ok((floats[5] ?? 0) < 1 && (floats[5] ?? 0) > 0.999);
});

test('resampling is continuous across arbitrary chunk boundaries', () => {
  const input = Float32Array.from(
    { length: 48_000 },
    (_, i) => 0.4 * Math.sin((2 * Math.PI * 440 * i) / 48_000)
  );
  const whole = new SpeechPreprocessor(48_000, { highpass: false }).process(input);
  const chunkedProcessor = new SpeechPreprocessor(48_000, { highpass: false });
  const parts = [
    chunkedProcessor.process(input.slice(0, 137)),
    chunkedProcessor.process(input.slice(137, 12_345)),
    chunkedProcessor.process(input.slice(12_345, 31_111)),
    chunkedProcessor.process(input.slice(31_111))
  ];
  const chunked = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    chunked.set(part, offset);
    offset += part.length;
  }

  assert.equal(whole.length, 16_000);
  assert.equal(chunked.length, whole.length);
  for (let i = 0; i < whole.length; i++) {
    assert.ok(Math.abs((whole[i] ?? 0) - (chunked[i] ?? 0)) < 1e-6, `sample ${i}`);
  }
});

test('invalid input sample rates fail explicitly', () => {
  assert.throws(() => new SpeechPreprocessor(8_000), /Samplerate/);
});

test('one second remains one second at common browser sample rates', () => {
  for (const rate of [44_100, 48_000, 96_000]) {
    const input = new Float32Array(rate);
    const processor = new SpeechPreprocessor(rate, { highpass: false });
    const split = Math.floor(rate * 0.37);
    const outputLength = processor.process(input.slice(0, split)).length + processor.process(input.slice(split)).length;
    assert.equal(outputLength, 16_000, `${rate} Hz`);
  }
});
