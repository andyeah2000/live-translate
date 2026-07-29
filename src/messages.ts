/** Untertitel-Darstellung: nur Übersetzung oder Original + Übersetzung. */
export type SubtitleMode = 'translation' | 'dual';

/** VAD-Preset: satzstabil für Vorträge/Doku oder latenzarm für schnelle Dialoge. */
export type SpeechMode = 'lecture' | 'dialog';

/** Herkunft eines Transkript-Chunks: Quellsprache oder Übersetzung. */
export type TranscriptLane = 'source' | 'target';

export interface SessionSettings {
  /** Version der persistierten Einstellungen für kontrollierte Migrationen. */
  settingsVersion: 8;
  geminiKey: string;
  /** BCP-47-Code der Zielsprache (z. B. "de"). */
  targetLanguage: string;
  subtitles: boolean;
  subtitleMode: SubtitleMode;
  /** Lautstärke der Gemini-Stimme (0–1). */
  translationVolume: number;
  /** Eingaben, die bereits in der Zielsprache sind, nachsprechen statt schweigen. */
  echoTargetLanguage: boolean;
  speechMode: SpeechMode;
  /** Gewünschte Gemini-Stimme; leer = automatische Modellstimme. */
  voiceName: string;
  /**
   * Experiment: Gemini erhält das nur hochpassgefilterte Originalsignal statt
   * der komprimierten Sprachpipeline. Bewusst ohne Popup-Oberfläche; per
   * DevTools-Storage umschaltbar, Wirkung ab dem nächsten Start.
   */
  rawModelAudio: boolean;
}

export interface OutputSettings {
  subtitles: boolean;
  subtitleMode: SubtitleMode;
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
  | { type: 'get-state' }
  | { type: 'update-output-settings'; settings: OutputSettings }
  | { type: 'offscreen-start'; sessionId: string; streamId: string; settings: SessionSettings }
  | { type: 'offscreen-update-output'; sessionId: string; settings: OutputSettings }
  | { type: 'offscreen-stop' }
  | { type: 'offscreen-status'; sessionId: string; status: string }
  | { type: 'offscreen-error'; sessionId: string; detail: string }
  | { type: 'ducking-telemetry'; sessionId: string; telemetry: DuckingTelemetry }
  | { type: 'transcript'; sessionId: string; text: string; final: boolean; lane: TranscriptLane }
  | { type: 'subtitle'; text: string; final: boolean; lane: TranscriptLane }
  | { type: 'subtitle-clear' }
  | { type: 'session-state'; state: SessionState };
