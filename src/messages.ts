export interface SessionSettings {
  /** Version der persistierten Einstellungen für kontrollierte Migrationen. */
  settingsVersion: 7;
  geminiKey: string;
  /** BCP-47-Code der Zielsprache (z. B. "de"). */
  targetLanguage: string;
  subtitles: boolean;
  /** Lautstärke der Gemini-Stimme (0–1). */
  translationVolume: number;
}

export interface OutputSettings {
  subtitles: boolean;
  translationVolume: number;
}

export interface SessionState {
  running: boolean;
  tabId: number | null;
  /** Eindeutige ID, damit verspätete Gemini-Events keine neue Sitzung beeinflussen. */
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
}

/** Nachrichten zwischen Popup, Background, Offscreen-Dokument und Content Script. */
export type Message =
  | { type: 'start-session'; tabId: number; settings: SessionSettings }
  | { type: 'stop-session' }
  | { type: 'get-state' }
  | { type: 'update-output-settings'; settings: OutputSettings }
  | { type: 'offscreen-start'; sessionId: string; streamId: string; settings: SessionSettings }
  | { type: 'offscreen-update-output'; sessionId: string; settings: OutputSettings }
  | { type: 'offscreen-stop' }
  | { type: 'offscreen-status'; sessionId: string; status: string }
  | { type: 'offscreen-error'; sessionId: string; detail: string }
  | { type: 'ducking-telemetry'; sessionId: string; telemetry: DuckingTelemetry }
  | { type: 'transcript'; sessionId: string; text: string; final: boolean }
  | { type: 'subtitle'; text: string; final: boolean }
  | { type: 'subtitle-clear' }
  | { type: 'session-state'; state: SessionState };
