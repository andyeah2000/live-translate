/** Untertitel-Darstellung: nur Übersetzung oder Original + Übersetzung. */
export type SubtitleMode = 'translation' | 'dual';

/** Herkunft eines Transkript-Chunks: Quellsprache oder Übersetzung. */
export type TranscriptLane = 'source' | 'target';

/** Geordnete interne Transkript-Ereignisse zwischen Offscreen, Worker und Overlay. */
export type TranscriptEvent =
  | {
      kind: 'chunk';
      lane: TranscriptLane;
      text: string;
      /** GPT-Live media timeline in milliseconds; optional for legacy messages/tests. */
      startMs?: number;
      endMs?: number;
    }
  | { kind: 'complete'; lane: TranscriptLane }
  | { kind: 'interrupt'; lane: TranscriptLane };

export interface SessionSettings {
  /** Version der persistierten Einstellungen für kontrollierte Migrationen. */
  settingsVersion: 11;
  /** Basis-URL des vertrauenswürdigen GPT-Live-Backends. */
  liveServerUrl: string;
  /** Zugriffstoken für das eigene Backend – niemals ein OpenAI-API-Key. */
  liveServerToken: string;
  /** Auswahl wird beim nächsten Start serverseitig gegen eine Allowlist geprüft. */
  liveVoice: string;
  subtitles: boolean;
  subtitleMode: SubtitleMode;
  /** Lautstärke der übersetzten Zielspur (0–1). */
  translationVolume: number;
}

export interface OutputSettings {
  subtitles: boolean;
  subtitleMode: SubtitleMode;
  translationVolume: number;
}

export interface SessionState {
  running: boolean;
  tabId: number | null;
  /** Eindeutige ID, damit verspätete Provider-Events keine neue Sitzung beeinflussen. */
  sessionId: string | null;
  status: string;
  error: string | null;
  ducking: DuckingTelemetry | null;
}

export interface DuckingTelemetry {
  ready: boolean;
  speaking: boolean;
  sourceGain: number;
  probability: number;
  error: string | null;
  translationReady: boolean;
  inputIndependent?: boolean;
}

/**
 * Nur Extension-eigene Kontexte (Popup, Service Worker, Offscreen-Dokument)
 * dürfen privilegierte Nachrichten senden. Das Content Script läuft im
 * Renderer beliebiger Webseiten und sendet nie – ein kompromittierter
 * Renderer könnte aber in seinem Namen Nachrichten fälschen. Deshalb wird der
 * Absender geprüft, bevor eine Nachricht Zustand verändern darf.
 */
export function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  const extensionBase = chrome.runtime.getURL('');
  if (sender.url?.startsWith(extensionBase) === true) return true;
  return sender.origin !== undefined && `${sender.origin}/` === extensionBase;
}

/** Nachrichten zwischen Popup, Background, Offscreen-Dokument und Content Script. */
export type Message =
  | { type: 'start-session'; tabId: number; settings: SessionSettings }
  | { type: 'stop-session' }
  | { type: 'change-voice'; settings: SessionSettings }
  | { type: 'get-state' }
  | { type: 'update-output-settings'; settings: OutputSettings }
  | { type: 'offscreen-start'; sessionId: string; streamId: string; settings: SessionSettings; inputOffer?: string }
  | { type: 'offscreen-input-answer'; sessionId: string; sdp: string }
  | { type: 'offscreen-update-output'; sessionId: string; settings: OutputSettings }
  | { type: 'offscreen-stop' }
  | { type: 'offscreen-status'; sessionId: string; status: string }
  | { type: 'offscreen-error'; sessionId: string; detail: string }
  | { type: 'ducking-telemetry'; sessionId: string; telemetry: DuckingTelemetry }
  | { type: 'transcript'; sessionId: string; event: TranscriptEvent }
  | { type: 'subtitle'; event: TranscriptEvent }
  | { type: 'subtitle-clear' }
  | { type: 'session-state'; state: SessionState };
