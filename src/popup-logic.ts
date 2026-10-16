import type { SessionSettings, SessionState } from './messages';
import { MAX_SERVER_TOKEN_LENGTH, normalizeServerUrl } from './settings';

export function configurationError(settings: SessionSettings, requireToken = true): string | null {
  if (!settings.liveServerUrl.trim()) return 'Bitte zuerst die GPT-Live-Server-URL eintragen.';
  if (!normalizeServerUrl(settings.liveServerUrl)) {
    return 'Bitte eine gültige HTTPS-Server-URL oder http://localhost eingeben, ohne Zugangsdaten, Suchparameter oder Fragment.';
  }
  const token = settings.liveServerToken.trim();
  if (!token && requireToken) return 'Bitte zuerst den Zugriffstoken des GPT-Live-Servers eintragen.';
  if (token.length > MAX_SERVER_TOKEN_LENGTH || /[^\x21-\x7e]/.test(token)) {
    return 'Der Server-Zugriffstoken ist ungültig. Bitte den vollständigen Token ohne Leerzeichen einfügen.';
  }
  return null;
}

export function isTranslatableUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) return false;
    if (parsed.hostname === 'chromewebstore.google.com') return false;
    return !(parsed.hostname === 'chrome.google.com' && /^\/webstore(?:\/|$)/.test(parsed.pathname));
  } catch {
    return false;
  }
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
