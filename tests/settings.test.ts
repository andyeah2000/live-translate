import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS, loadSettings, sanitizeSettings } from '../src/settings';

test('sanitizeSettings keeps only the canonical values', () => {
  assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(
    sanitizeSettings({
      settingsVersion: 9,
      liveServerUrl: 'http://127.0.0.1:8787/',
      liveServerToken: '  secret-token\n',
      subtitles: false,
      translationVolume: 0.2,
      unknownToggle: true,
      unknownMode: 'legacy'
    }),
    {
      settingsVersion: 11,
      liveServerUrl: 'http://127.0.0.1:8787',
      liveServerToken: 'secret-token',
      liveVoice: 'meridian',
      subtitles: false,
      subtitleMode: 'translation',
      translationVolume: 0.2
    }
  );
});

test('obsolete language options cannot change the fixed German translation', () => {
  assert.deepEqual(sanitizeSettings({ targetLanguage: 'fr', keyterms: 'unused', echoTargetLanguage: true }), DEFAULT_SETTINGS);
});

test('sanitizeSettings bounds voice, server and session options to known values', () => {
  const sanitized = sanitizeSettings({
    liveServerUrl: 'http://127.0.0.1:8787',
    liveServerToken: '  server-token  ',
    liveVoice: 'quartz',
    subtitleMode: 'dual',
  });
  assert.equal(sanitized.liveServerUrl, 'http://127.0.0.1:8787');
  assert.equal(sanitized.liveServerToken, 'server-token');
  assert.equal(sanitized.liveVoice, 'quartz');
  assert.equal(sanitized.subtitleMode, 'dual');

  const rejected = sanitizeSettings({
    liveServerUrl: 'ftp://example.com/audio',
    liveVoice: 'NotARealVoice<script>',
    subtitleMode: 'both'
  });
  assert.equal(rejected.liveServerUrl, DEFAULT_SETTINGS.liveServerUrl);
  assert.equal(rejected.liveVoice, DEFAULT_SETTINGS.liveVoice);
  assert.equal(rejected.subtitleMode, 'translation');
});

test('load preserves only canonical controls and removes every unknown key', async () => {
  const stored = {
    settingsVersion: 9,
    liveServerUrl: 'http://127.0.0.1:8787',
    liveServerToken: 'local-token',
    subtitles: false,
    translationVolume: 0.64,
    legacyToggle: true,
    // Die abgelösten Provider-Keys müssen den lokalen Speicher verlassen.
    grokKey: 'old-secret',
    geminiKey: 'old-secret',
    deeplKey: 'old-secret'
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
      settingsVersion: 11,
      liveServerUrl: 'http://127.0.0.1:8787',
      liveServerToken: 'local-token',
      liveVoice: 'meridian',
      subtitles: false,
      subtitleMode: 'translation',
      translationVolume: 0.64
    });
    assert.deepEqual(persisted, migrated);
    for (const key of ['legacyToggle', 'grokKey', 'geminiKey', 'deeplKey']) {
      assert.ok(removed.includes(key), `${key} was not removed`);
    }
  } finally {
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome;
    else (globalThis as { chrome?: unknown }).chrome = previousChrome;
  }
});
