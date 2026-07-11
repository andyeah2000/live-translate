import assert from 'node:assert/strict';
import test from 'node:test';
import { configurationError, isTranslatableUrl } from '../src/popup-logic';
import { DEFAULT_SETTINGS } from '../src/settings';

test('start validation requires a Gemini key', () => {
  assert.match(configurationError(DEFAULT_SETTINGS) ?? '', /API-Key/);
  assert.equal(configurationError({ ...DEFAULT_SETTINGS, geminiKey: 'AIza-test' }), null);
});

test('start validation requires at least one output', () => {
  assert.match(
    configurationError({
      ...DEFAULT_SETTINGS,
      geminiKey: 'AIza-test',
      subtitles: false,
      dubbing: false
    }) ?? '',
    /mindestens/
  );
});

test('URL validation blocks privileged and store pages', () => {
  assert.equal(isTranslatableUrl('https://example.com/video'), true);
  assert.equal(isTranslatableUrl('http://localhost:3000/video'), true);
  assert.equal(isTranslatableUrl('chrome://extensions'), false);
  assert.equal(isTranslatableUrl('https://chromewebstore.google.com/detail/example'), false);
  assert.equal(isTranslatableUrl(undefined), false);
});
