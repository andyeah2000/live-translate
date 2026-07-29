import type { SessionSettings, SpeechMode, SubtitleMode } from './messages';

const TARGET_LANGUAGES = new Set([
  'de',
  'en',
  'es',
  'fr',
  'it',
  'pt-BR',
  'pt-PT',
  'nl',
  'pl',
  'tr',
  'ru',
  'uk',
  'ja',
  'ko',
  'zh-Hans',
  'zh-Hant',
  'hi',
  'ar'
]);
/**
 * Prebuilt-Stimmen der Live API. Ob das Translate-Modell sie akzeptiert,
 * entscheidet der Server; der Client fällt bei Ablehnung automatisch auf die
 * Standardstimme zurück.
 */
export const VOICE_NAMES = new Set([
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Aoede',
  'Leda',
  'Orus',
  'Zephyr'
]);

const SUBTITLE_MODES = new Set<SubtitleMode>(['translation', 'dual']);
const SPEECH_MODES = new Set<SpeechMode>(['lecture', 'dialog']);

export const DEFAULT_SETTINGS: SessionSettings = {
  settingsVersion: 8,
  geminiKey: '',
  targetLanguage: 'de',
  subtitles: true,
  subtitleMode: 'translation',
  translationVolume: 1,
  echoTargetLanguage: false,
  speechMode: 'lecture',
  voiceName: '',
  rawModelAudio: false
};

const CANONICAL_SETTING_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function volumeValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

function languageValue(value: unknown, allowed: Set<string>, fallback: string): string {
  // Migration der vor 0.3 gespeicherten, generischen Sprachcodes auf von
  // Gemini Live Translate explizit unterstützte BCP-47-Codes.
  const migrated = value === 'pt' ? 'pt-BR' : value === 'zh' ? 'zh-Hans' : value;
  return typeof migrated === 'string' && allowed.has(migrated) ? migrated : fallback;
}

function enumValue<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value as T) ? (value as T) : fallback;
}

function voiceValue(value: unknown): string {
  return typeof value === 'string' && VOICE_NAMES.has(value) ? value : '';
}

/**
 * Storage ist eine dauerhafte Versionsgrenze: alte Extension-Versionen,
 * manuelle DevTools-Änderungen oder Sync-Tools können beliebige Werte
 * hinterlassen. Deshalb wird jeder geladene Wert validiert und begrenzt.
 */
export function sanitizeSettings(value: unknown): SessionSettings {
  const candidate = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    settingsVersion: DEFAULT_SETTINGS.settingsVersion,
    geminiKey: stringValue(candidate.geminiKey, '').trim(),
    targetLanguage: languageValue(
      candidate.targetLanguage,
      TARGET_LANGUAGES,
      DEFAULT_SETTINGS.targetLanguage
    ),
    subtitles: booleanValue(candidate.subtitles, DEFAULT_SETTINGS.subtitles),
    subtitleMode: enumValue(candidate.subtitleMode, SUBTITLE_MODES, DEFAULT_SETTINGS.subtitleMode),
    translationVolume: volumeValue(
      candidate.translationVolume,
      DEFAULT_SETTINGS.translationVolume
    ),
    echoTargetLanguage: booleanValue(
      candidate.echoTargetLanguage,
      DEFAULT_SETTINGS.echoTargetLanguage
    ),
    speechMode: enumValue(candidate.speechMode, SPEECH_MODES, DEFAULT_SETTINGS.speechMode),
    voiceName: voiceValue(candidate.voiceName),
    rawModelAudio: booleanValue(candidate.rawModelAudio, DEFAULT_SETTINGS.rawModelAudio)
  };
}

export async function loadSettings(): Promise<SessionSettings> {
  // Ohne Default-Objekt laden, damit eine fehlende Versionsnummer zuverlässig
  // als Altbestand erkennbar bleibt.
  const stored = await chrome.storage.local.get(null);
  const settings = sanitizeSettings(stored);
  // Immer kanonisch zurückschreiben und ausnahmslos jeden unbekannten Schlüssel
  // entfernen. So existiert im Storage exakt eine Gemini-Pipeline und kein
  // historischer Konfigurations- oder Secret-Rest.
  await chrome.storage.local.set(settings);
  const unknownKeys = Object.keys(stored).filter((key) => !CANONICAL_SETTING_KEYS.has(key));
  if (unknownKeys.length > 0) await chrome.storage.local.remove(unknownKeys);
  return settings;
}

let saveQueue: Promise<void> = Promise.resolve();

export function saveSettings(settings: SessionSettings): Promise<void> {
  const sanitized = sanitizeSettings(settings);
  // Popup-Start und ein unmittelbar davor ausgelöstes Change-Event können
  // gleichzeitig speichern. Serialisierung hält die neueste Eingabe stabil.
  saveQueue = saveQueue.catch(() => {}).then(() => chrome.storage.local.set(sanitized));
  return saveQueue;
}
