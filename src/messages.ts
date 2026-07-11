/**
 * Audio-Weg zur KI: 'filtered' = Highpass + FIR-Anti-Aliasing; 'native' =
 * möglichst naturbelassen. Provider-seitig erforderliches Resampling bleibt
 * in beiden Modi aktiv (Gemini erwartet zwingend 16 kHz).
 */
export type AudioMode = 'filtered' | 'native';

export interface SessionSettings {
  /** Version der persistierten Einstellungen für kontrollierte Migrationen. */
  settingsVersion: 4;
  subtitles: boolean;
  dubbing: boolean;
  /** Pegel des kompletten Originals (0–1), solange Quellsprache erkannt wird. */
  originalVolume: number;
  /** Lautstärke der übersetzten Gemini-Stimme (0–1). */
  translationVolume: number;
  /** Originalton über einen unverarbeiteten Unity-Pfad ausgeben (Ducking aus). */
  fullOriginal: boolean;
  geminiKey: string;
  /** BCP-47-Code der Zielsprache (z. B. "de"). */
  targetLanguage: string;
  audioMode: AudioMode;
  /** Leise Stimmen (z. B. Funk-Callouts) nur im KI-Feed anheben. */
  calloutBoost: boolean;
}

export interface AudioSettings {
  subtitles: boolean;
  dubbing: boolean;
  originalVolume: number;
  translationVolume: number;
  fullOriginal: boolean;
  calloutBoost: boolean;
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
  | { type: 'start-session'; tabId: number; streamId: string; settings: SessionSettings }
  | { type: 'stop-session' }
  | { type: 'get-state' }
  | { type: 'update-audio-settings'; settings: AudioSettings }
  | { type: 'offscreen-start'; sessionId: string; streamId: string; settings: SessionSettings }
  | { type: 'offscreen-stop' }
  | { type: 'offscreen-status'; sessionId: string; status: string }
  | { type: 'offscreen-error'; sessionId: string; detail: string }
  | { type: 'ducking-telemetry'; sessionId: string; telemetry: DuckingTelemetry }
  | { type: 'transcript'; sessionId: string; text: string; final: boolean }
  | { type: 'subtitle'; text: string; final: boolean }
  | { type: 'subtitle-clear' }
  | { type: 'session-state'; state: SessionState };
