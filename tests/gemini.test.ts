import assert from 'node:assert/strict';
import test from 'node:test';
import { createGeminiSetup } from '../src/offscreen/gemini';

test('Gemini raw WebSocket setup keeps output transcription outside generationConfig', () => {
  const message = createGeminiSetup('de') as {
    setup: {
      outputAudioTranscription?: unknown;
      generationConfig: Record<string, unknown>;
    };
  };
  assert.deepEqual(message.setup.outputAudioTranscription, {});
  assert.equal(message.setup.generationConfig.outputAudioTranscription, undefined);
  assert.equal(message.setup.generationConfig.inputAudioTranscription, undefined);
  assert.deepEqual(message.setup.generationConfig.translationConfig, {
    targetLanguageCode: 'de',
    echoTargetLanguage: false
  });
});
