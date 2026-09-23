import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionState } from '../src/messages';
import {
  configurationError,
  isTranslatableUrl,
  popupMonitorPresentation,
  popupStatusPresentation
} from '../src/popup-logic';
import { DEFAULT_SETTINGS } from '../src/settings';

const runningState = (overrides: Partial<SessionState> = {}): SessionState => ({
  running: true,
  tabId: 7,
  sessionId: 'session-a',
  status: 'Übersetzung läuft (GPT-Live)',
  error: null,
  ducking: {
    ready: true,
    speaking: false,
    sourceGain: 1,
    probability: 0,
    error: null,
    translationReady: true
  },
  ...overrides
});

test('start validation requires the GPT-Live server token', () => {
  assert.match(configurationError(DEFAULT_SETTINGS) ?? '', /Zugriffstoken/);
  assert.match(
    configurationError({ ...DEFAULT_SETTINGS, liveServerUrl: '' }) ?? '',
    /Server-URL/
  );
  assert.equal(
    configurationError({ ...DEFAULT_SETTINGS, liveServerToken: 'local-token' }),
    null
  );
});

test('URL validation blocks privileged and store pages', () => {
  assert.equal(isTranslatableUrl('https://example.com/video'), true);
  assert.equal(isTranslatableUrl('http://localhost:3000/video'), true);
  assert.equal(isTranslatableUrl('chrome://extensions'), false);
  assert.equal(isTranslatableUrl('chrome-untrusted://media-app'), false);
  assert.equal(isTranslatableUrl('chrome-search://local-ntp/local-ntp.html'), false);
  assert.equal(isTranslatableUrl('data:text/html,<video></video>'), false);
  assert.equal(isTranslatableUrl('blob:https://example.com/2f7a0b'), false);
  assert.equal(isTranslatableUrl('https://chromewebstore.google.com/detail/example'), false);
  assert.equal(isTranslatableUrl(undefined), false);
});

test('popup exposes live status text instead of silently discarding it', () => {
  assert.deepEqual(popupStatusPresentation(runningState()), {
    text: 'Übersetzung läuft (GPT-Live)',
    error: false
  });
  assert.deepEqual(
    popupStatusPresentation(runningState({ status: 'Fehlerstatus', error: 'GPT-Live abgelehnt' })),
    { text: 'GPT-Live abgelehnt', error: true }
  );
});

test('popup prioritizes a local ducking failure over the loading state', () => {
  const state = runningState({
    status: 'Ducking nicht verfügbar · Original bleibt bei 100 %',
    ducking: {
      ready: false,
      speaking: false,
      sourceGain: 1,
      probability: 0,
      error: 'Silero worker failed',
      translationReady: true
    }
  });
  assert.deepEqual(popupMonitorPresentation(state), { text: 'Mix vereinfacht', state: 'active' });
});
