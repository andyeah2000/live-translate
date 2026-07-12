import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS, loadSettings, sanitizeSettings } from '../src/settings';

test('sanitizeSettings keeps only the four user-facing values', () => {
  assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(
    sanitizeSettings({
      settingsVersion: 6,
      geminiKey: '  AIza-test\n',
      targetLanguage: 'fr',
      subtitles: false,
      dubbing: false,
      translationVolume: 0.2,
      fullOriginal: true,
      audioMode: 'native',
      calloutBoost: false
    }),
    {
      settingsVersion: 7,
      geminiKey: 'AIza-test',
      targetLanguage: 'fr',
      subtitles: false,
      translationVolume: 0.2
    }
  );
});

test('sanitizeSettings rejects corrupt values and migrates legacy language codes', () => {
  assert.deepEqual(
    sanitizeSettings({ settingsVersion: 7, geminiKey: 42, targetLanguage: '../../invalid' }),
    DEFAULT_SETTINGS
  );
  assert.equal(sanitizeSettings({ targetLanguage: 'pt' }).targetLanguage, 'pt-BR');
  assert.equal(sanitizeSettings({ targetLanguage: 'zh' }).targetLanguage, 'zh-Hans');
});

test('v7 load preserves output controls and removes obsolete pipeline options', async () => {
  const stored = {
    settingsVersion: 7,
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
      settingsVersion: 7,
      geminiKey: 'legacy-key',
      targetLanguage: 'de',
      subtitles: false,
      translationVolume: 0.64
    });
    assert.deepEqual(persisted, migrated);
    for (const key of [
      'dubbing',
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
