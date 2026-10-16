import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS, loadSettings, normalizeServerUrl, sanitizeSettings, saveSettings } from '../src/settings';

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
      settingsVersion: 12,
      liveServerUrl: 'http://127.0.0.1:8787',
      liveServerToken: 'secret-token',
      liveVoice: 'meridian',
      sourceLanguage: 'en',
      subtitles: false,
      subtitleMode: 'translation',
      translationVolume: 0.2,
      originalVolume: 1
    }
  );
});

test('obsolete language options cannot change the fixed German translation', () => {
  assert.deepEqual(sanitizeSettings({ targetLanguage: 'fr', keyterms: 'unused', echoTargetLanguage: true }), DEFAULT_SETTINGS);
});

test('source language and original volume accept only known, bounded values', () => {
  assert.equal(sanitizeSettings({ sourceLanguage: 'auto' }).sourceLanguage, 'auto');
  assert.equal(sanitizeSettings({ sourceLanguage: 'fr' }).sourceLanguage, 'en');
  assert.equal(sanitizeSettings({ originalVolume: 0.3 }).originalVolume, 0.3);
  assert.equal(sanitizeSettings({ originalVolume: 4 }).originalVolume, 1);
  assert.equal(sanitizeSettings({ originalVolume: Number.NaN }).originalVolume, 1);
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
      settingsVersion: 12,
      liveServerUrl: 'http://127.0.0.1:8787',
      liveServerToken: 'local-token',
      liveVoice: 'meridian',
      sourceLanguage: 'en',
      subtitles: false,
      subtitleMode: 'translation',
      translationVolume: 0.64,
      originalVolume: 1
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

test('backend URL normalization rejects ambiguous and insecure addresses', () => {
  assert.equal(normalizeServerUrl(' HTTPS://BACKEND.EXAMPLE/base/// '), 'https://backend.example/base');
  assert.equal(normalizeServerUrl('http://localhost:8787/'), 'http://localhost:8787');
  for (const url of ['', 'not a URL', 'http://remote.example', 'https://user:pass@example.com',
    'https://example.com?token=secret', 'https://example.com/#fragment', null]) {
    assert.equal(normalizeServerUrl(url), null, `must reject ${url}`);
  }
});

test('settings migration waits for pending writes and failed saves do not block later saves', async () => {
  const previousChrome = (globalThis as { chrome?: unknown }).chrome;
  let stored = { ...DEFAULT_SETTINGS };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  let fail = false;
  Object.assign(globalThis, { chrome: { storage: { local: {
    get: async () => ({ ...stored }),
    set: async (settings: typeof stored) => {
      if (++writes === 1) await gate;
      if (fail) throw new Error('storage unavailable');
      stored = { ...settings };
    },
    remove: async () => {}
  } } } });
  try {
    const save = saveSettings({ ...DEFAULT_SETTINGS, liveVoice: 'stone' });
    const load = loadSettings();
    release();
    await save;
    assert.equal((await load).liveVoice, 'stone');
    assert.equal(stored.liveVoice, 'stone');
    fail = true;
    await assert.rejects(saveSettings(DEFAULT_SETTINGS), /storage unavailable/);
    fail = false;
    await saveSettings({ ...DEFAULT_SETTINGS, liveVoice: 'quartz' });
    assert.equal(stored.liveVoice, 'quartz');
  } finally {
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome;
    else (globalThis as { chrome?: unknown }).chrome = previousChrome;
  }
});
