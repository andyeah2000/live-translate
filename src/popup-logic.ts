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
  if (!state.ducking?.translationReady) return { text: 'Verbindet', state: 'loading' };
  // GPT-Live already speaks; the local voice detector may still be loading.
  if (!state.ducking.ready) return { text: 'Mix startet…', state: 'active' };
  return { text: `Original · ${Math.round(state.ducking.sourceGain * 100)}%`, state: 'active' };
}

/** GPT-Live voice price per minute (developers.openai.com/api/docs/models/gpt-live-1). */
export const GPT_LIVE_USD_PER_MINUTE = 0.05;

/** Delay, running time and cost of the active translation, or '' when idle. */
export function liveStatsPresentation(state: SessionState): string {
  const ducking = state.ducking;
  if (!state.running || !ducking) return '';
  const parts: string[] = [];
  if (typeof ducking.lagMs === 'number') {
    parts.push(`Verzögerung ${(ducking.lagMs / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`);
  }
  const seconds = Math.max(0, Math.floor(ducking.usageSeconds ?? 0));
  if (seconds > 0) {
    const cost = seconds / 60 * GPT_LIVE_USD_PER_MINUTE;
    parts.push(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} min`);
    parts.push(`≈ ${cost.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`);
  }
  if ((ducking.reconnects ?? 0) > 0) parts.push(`${ducking.reconnects}× erneuert`);
  return parts.join(' · ');
}
