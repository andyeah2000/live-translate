import type { SessionSettings, SessionState } from './messages';

const RESTRICTED_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'chrome-untrusted://',
  'chrome-search://',
  'edge://',
  'brave://',
  'opera://',
  'vivaldi://',
  'about:',
  'devtools://',
  'view-source:',
  'data:',
  'blob:',
  'https://chromewebstore.google.com',
  'https://chrome.google.com/webstore'
];

export function configurationError(settings: SessionSettings): string | null {
  if (!settings.liveServerUrl) return 'Bitte zuerst die GPT-Live-Server-URL eintragen.';
  if (!settings.liveServerToken) return 'Bitte zuerst den Zugriffstoken des GPT-Live-Servers eintragen.';
  return null;
}

export function isTranslatableUrl(url: string | undefined): boolean {
  return Boolean(url && !RESTRICTED_PREFIXES.some((prefix) => url.startsWith(prefix)));
}

export interface PopupStatusPresentation {
  text: string;
  error: boolean;
}

export interface PopupMonitorPresentation {
  text: string;
  state: 'idle' | 'loading' | 'active' | 'error';
}

/** Hält die DOM-Darstellung als reine, vollständig testbare Zustandsabbildung. */
export function popupStatusPresentation(state: SessionState): PopupStatusPresentation {
  return {
    text: state.error ?? state.status,
    error: state.error !== null
  };
}

export function popupMonitorPresentation(state: SessionState): PopupMonitorPresentation {
  if (state.error) return { text: 'Fehler', state: 'error' };
  if (!state.running) return { text: 'Bereit', state: 'idle' };
  // Ein lokaler VAD-Ausfall ist kein fataler Übersetzungsfehler, darf aber nie
  // als endloses „Verbindet“ verborgen werden.
  if (state.ducking?.error) return { text: 'Mix vereinfacht', state: 'active' };
  if (!state.ducking?.ready || !state.ducking.translationReady) {
    return { text: 'Verbindet', state: 'loading' };
  }
  return { text: `Original · ${Math.round(state.ducking.sourceGain * 100)}%`, state: 'active' };
}
