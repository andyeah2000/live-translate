import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/settings';

test('sanitizeSettings falls back safely for corrupt storage', () => {
  assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(
    sanitizeSettings({
      settingsVersion: 4,
      subtitles: 'yes',
      dubbing: 1,
      originalVolume: Number.NaN,
      translationVolume: Number.POSITIVE_INFINITY,
      geminiKey: 42,
      targetLanguage: '../../invalid',
      audioMode: 'broken'
    }),
    DEFAULT_SETTINGS
  );
});

test('sanitizeSettings clamps volumes and trims the Gemini key', () => {
  const settings = sanitizeSettings({
    ...DEFAULT_SETTINGS,
    originalVolume: -4,
    translationVolume: 8,
    geminiKey: '  AIza-test\n'
  });
  assert.equal(settings.originalVolume, 0);
  assert.equal(settings.translationVolume, 1);
  assert.equal(settings.geminiKey, 'AIza-test');
});

test('legacy settings migrate once to Gemini-only 10-percent dynamic ducking', () => {
  const migrated = sanitizeSettings({
    geminiKey: 'legacy-key',
    originalVolume: 0.15,
    germanVolume: 0.8,
    fullOriginal: true,
    subtitles: true,
    dubbing: true,
    targetLanguage: 'de',
    audioMode: 'filtered',
    calloutBoost: false
  });
  assert.equal(migrated.settingsVersion, 4);
  assert.equal(migrated.originalVolume, 0.1);
  assert.equal(migrated.translationVolume, 0.8);
  assert.equal(migrated.fullOriginal, false);
  assert.equal(migrated.geminiKey, 'legacy-key');
});

test('sanitizeSettings migrates legacy language codes', () => {
  assert.equal(sanitizeSettings({ ...DEFAULT_SETTINGS, targetLanguage: 'pt' }).targetLanguage, 'pt-BR');
  assert.equal(sanitizeSettings({ ...DEFAULT_SETTINGS, targetLanguage: 'zh' }).targetLanguage, 'zh-Hans');
});
