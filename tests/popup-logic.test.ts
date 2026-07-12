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
  status: 'Übersetzung läuft (Gemini)',
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

test('start validation requires a Gemini key', () => {
  assert.match(configurationError(DEFAULT_SETTINGS) ?? '', /API-Key/);
  assert.equal(configurationError({ ...DEFAULT_SETTINGS, geminiKey: 'AIza-test' }), null);
});

test('URL validation blocks privileged and store pages', () => {
  assert.equal(isTranslatableUrl('https://example.com/video'), true);
  assert.equal(isTranslatableUrl('http://localhost:3000/video'), true);
  assert.equal(isTranslatableUrl('chrome://extensions'), false);
  assert.equal(isTranslatableUrl('https://chromewebstore.google.com/detail/example'), false);
  assert.equal(isTranslatableUrl(undefined), false);
});

test('popup exposes live status text instead of silently discarding it', () => {
  assert.deepEqual(popupStatusPresentation(runningState()), {
    text: 'Übersetzung läuft (Gemini)',
    error: false
  });
  assert.deepEqual(
    popupStatusPresentation(runningState({ status: 'Fehlerstatus', error: 'Gemini abgelehnt' })),
    { text: 'Gemini abgelehnt', error: true }
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
  assert.deepEqual(popupMonitorPresentation(state), { text: 'Ducking aus', state: 'error' });
});
