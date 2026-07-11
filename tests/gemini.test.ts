import assert from 'node:assert/strict';
import test from 'node:test';
import { createGeminiSetup, nextTranscriptionPlacement } from '../src/offscreen/gemini';

test('Gemini raw WebSocket setup supports both observed transcription schemas', () => {
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

  const documented = createGeminiSetup('de', 'generation') as {
    setup: {
      outputAudioTranscription?: unknown;
      generationConfig: Record<string, unknown>;
    };
  };
  assert.equal(documented.setup.outputAudioTranscription, undefined);
  assert.deepEqual(documented.setup.generationConfig.outputAudioTranscription, {});

  const audioOnly = createGeminiSetup('de', 'disabled') as {
    setup: {
      outputAudioTranscription?: unknown;
      generationConfig: Record<string, unknown>;
    };
  };
  assert.equal(audioOnly.setup.outputAudioTranscription, undefined);
  assert.equal(audioOnly.setup.generationConfig.outputAudioTranscription, undefined);
});

test('Gemini code 1007 falls back instead of killing live translation', () => {
  const setupError =
    'Invalid JSON payload. Unknown name "outputAudioTranscription" at setup';
  const generationError =
    'Invalid JSON payload. Unknown name "outputAudioTranscription" at setup.generation_config';
  assert.equal(nextTranscriptionPlacement('setup', 1007, setupError), 'generation');
  assert.equal(nextTranscriptionPlacement('generation', 1007, generationError), 'disabled');
  assert.equal(nextTranscriptionPlacement('disabled', 1007, generationError), null);
  assert.equal(nextTranscriptionPlacement('setup', 1006, setupError), null);
});
