import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS, loadSettings, sanitizeSettings } from '../src/settings';

test('sanitizeSettings falls back safely for corrupt storage', () => {
  assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(
    sanitizeSettings({
      settingsVersion: 5,
      subtitles: 'yes',
      dubbing: 1,
      translationVolume: Number.POSITIVE_INFINITY,
      geminiKey: 42,
      targetLanguage: '../../invalid',
      audioMode: 'broken'
    }),
    DEFAULT_SETTINGS
  );
});

test('sanitizeSettings clamps translation volume and trims the Gemini key', () => {
  const settings = sanitizeSettings({
    ...DEFAULT_SETTINGS,
    translationVolume: 8,
    geminiKey: '  AIza-test\n'
  });
  assert.equal(settings.translationVolume, 1);
  assert.equal(settings.geminiKey, 'AIza-test');
});

test('legacy settings cannot override fixed ten-percent dynamic ducking', () => {
  const migrated = sanitizeSettings({
    settingsVersion: 4,
    geminiKey: 'legacy-key',
    originalVolume: 1,
    translationVolume: 0.37,
    germanVolume: 0.8,
    fullOriginal: true,
    subtitles: true,
    dubbing: true,
    targetLanguage: 'de',
    audioMode: 'filtered',
    calloutBoost: false
  });
  assert.equal(migrated.settingsVersion, 5);
  assert.equal('originalVolume' in migrated, false);
  assert.equal(migrated.translationVolume, 0.37);
  assert.equal(migrated.fullOriginal, false);
  assert.equal(migrated.geminiKey, 'legacy-key');
});

test('pre-v4 settings still migrate the legacy German volume', () => {
  const migrated = sanitizeSettings({ settingsVersion: 3, germanVolume: 0.42 });
  assert.equal(migrated.translationVolume, 0.42);
});

test('v5 storage migration persists v4 translation volume and removes original volume', async () => {
  const stored = {
    settingsVersion: 4,
    translationVolume: 0.64,
    originalVolume: 0.91,
    fullOriginal: true
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
    assert.equal(migrated.translationVolume, 0.64);
    assert.equal(migrated.fullOriginal, false);
    assert.equal('originalVolume' in migrated, false);
    assert.deepEqual(persisted, migrated);
    assert.ok(removed.includes('originalVolume'));
  } finally {
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome;
    else (globalThis as { chrome?: unknown }).chrome = previousChrome;
  }
});

test('sanitizeSettings migrates legacy language codes', () => {
  assert.equal(sanitizeSettings({ ...DEFAULT_SETTINGS, targetLanguage: 'pt' }).targetLanguage, 'pt-BR');
  assert.equal(sanitizeSettings({ ...DEFAULT_SETTINGS, targetLanguage: 'zh' }).targetLanguage, 'zh-Hans');
});
