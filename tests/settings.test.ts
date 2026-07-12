import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS, loadSettings, sanitizeSettings } from '../src/settings';

test('sanitizeSettings keeps only the two user decisions', () => {
  assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(
    sanitizeSettings({
      settingsVersion: 5,
      geminiKey: '  AIza-test\n',
      targetLanguage: 'fr',
      subtitles: false,
      dubbing: false,
      translationVolume: 0.2,
      fullOriginal: true,
      audioMode: 'native',
      calloutBoost: false
    }),
    { settingsVersion: 6, geminiKey: 'AIza-test', targetLanguage: 'fr' }
  );
});

test('sanitizeSettings rejects corrupt values and migrates legacy language codes', () => {
  assert.deepEqual(
    sanitizeSettings({ settingsVersion: 6, geminiKey: 42, targetLanguage: '../../invalid' }),
    DEFAULT_SETTINGS
  );
  assert.equal(sanitizeSettings({ targetLanguage: 'pt' }).targetLanguage, 'pt-BR');
  assert.equal(sanitizeSettings({ targetLanguage: 'zh' }).targetLanguage, 'zh-Hans');
});

test('v6 load removes every obsolete provider and audio option idempotently', async () => {
  const stored = {
    settingsVersion: 6,
    geminiKey: 'legacy-key',
    targetLanguage: 'de',
    subtitles: false,
    dubbing: false,
    translationVolume: 0.64,
    fullOriginal: true,
    audioMode: 'native',
    calloutBoost: true,
    openaiKey: 'old-secret',
    xaiKey: 'old-secret'
  };
  let persisted: unknown;
  let removed: string[] = [];
  const previousChrome = (globalThis as { chrome?: unknown }).chrome;
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: async () => stored,
        set: async (value: unknown) => {
          persisted = value;
        },
        remove: async (keys: string[]) => {
          removed = keys;
        }
      }
    }
  };
  try {
    const migrated = await loadSettings();
    assert.deepEqual(migrated, {
      settingsVersion: 6,
      geminiKey: 'legacy-key',
      targetLanguage: 'de'
    });
    assert.deepEqual(persisted, migrated);
    for (const key of [
      'subtitles',
      'dubbing',
      'translationVolume',
      'fullOriginal',
      'audioMode',
      'calloutBoost',
      'openaiKey',
      'xaiKey'
    ]) {
      assert.ok(removed.includes(key), `${key} was not removed`);
    }
  } finally {
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome;
    else (globalThis as { chrome?: unknown }).chrome = previousChrome;
  }
});
