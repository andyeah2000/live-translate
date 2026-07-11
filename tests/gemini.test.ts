import assert from 'node:assert/strict';
import test from 'node:test';
import { createGeminiSetup } from '../src/offscreen/gemini';

test('Gemini setup matches the current Live Translate WebSocket schema', () => {
  const message = createGeminiSetup('de') as {
    setup: {
      generationConfig: Record<string, unknown>;
    };
  };
  assert.deepEqual(message.setup.generationConfig.outputAudioTranscription, {});
  assert.equal(message.setup.generationConfig.inputAudioTranscription, undefined);
  assert.deepEqual(message.setup.generationConfig.translationConfig, {
    targetLanguageCode: 'de',
    echoTargetLanguage: false
  });
});
