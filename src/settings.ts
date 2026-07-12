import type { SessionSettings } from './messages';

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
export const DEFAULT_SETTINGS: SessionSettings = {
  settingsVersion: 7,
  geminiKey: '',
  targetLanguage: 'de',
  subtitles: true,
  translationVolume: 1
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
    translationVolume: volumeValue(
      candidate.translationVolume,
      DEFAULT_SETTINGS.translationVolume
    )
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
