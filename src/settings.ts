import type { SessionSettings } from './messages';

const AUDIO_MODES = new Set(['filtered', 'native']);
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
  settingsVersion: 5,
  subtitles: true,
  dubbing: true,
  translationVolume: 1,
  fullOriginal: false,
  geminiKey: '',
  targetLanguage: 'de',
  audioMode: 'filtered',
  calloutBoost: false
};

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
  const isCurrentVersion = candidate.settingsVersion === DEFAULT_SETTINGS.settingsVersion;
  const hasTranslationVolume = isCurrentVersion || candidate.settingsVersion === 4;
  return {
    settingsVersion: DEFAULT_SETTINGS.settingsVersion,
    subtitles: booleanValue(candidate.subtitles, DEFAULT_SETTINGS.subtitles),
    dubbing: booleanValue(candidate.dubbing, DEFAULT_SETTINGS.dubbing),
    // Version 5 entfernt den frei konfigurierbaren Originalpegel. Der
    // Produktvertrag lautet jetzt eindeutig: Stimme = 10 %, keine Stimme =
    // exakt 100 %. So kann ein persistierter 100-%-Wert Ducking nicht mehr
    // unbemerkt wirkungslos machen.
    translationVolume: hasTranslationVolume
      ? volumeValue(candidate.translationVolume, DEFAULT_SETTINGS.translationVolume)
      : volumeValue(candidate.germanVolume, DEFAULT_SETTINGS.translationVolume),
    fullOriginal: isCurrentVersion
      ? booleanValue(candidate.fullOriginal, DEFAULT_SETTINGS.fullOriginal)
      : DEFAULT_SETTINGS.fullOriginal,
    geminiKey: stringValue(candidate.geminiKey, '').trim(),
    targetLanguage: languageValue(
      candidate.targetLanguage,
      TARGET_LANGUAGES,
      DEFAULT_SETTINGS.targetLanguage
    ),
    audioMode: AUDIO_MODES.has(candidate.audioMode as string)
      ? (candidate.audioMode as SessionSettings['audioMode'])
      : DEFAULT_SETTINGS.audioMode,
    calloutBoost: booleanValue(candidate.calloutBoost, DEFAULT_SETTINGS.calloutBoost)
  };
}

export async function loadSettings(): Promise<SessionSettings> {
  // Ohne Default-Objekt laden, damit eine fehlende Versionsnummer zuverlässig
  // als Altbestand erkennbar bleibt.
  const stored = await chrome.storage.local.get(null);
  const settings = sanitizeSettings(stored);
  if (stored.settingsVersion !== DEFAULT_SETTINGS.settingsVersion) {
    await chrome.storage.local.set(settings);
    // Nicht mehr verwendete Provider-Secrets und Optionen aktiv entfernen.
    await chrome.storage.local.remove([
      'provider',
      'voiceProvider',
      'openaiKey',
      'xaiKey',
      'grokVoice',
      'grokSpeed',
      'sourceLanguage',
      'originalVolume',
      'germanVolume'
    ]);
  }
  return settings;
}

let saveQueue: Promise<void> = Promise.resolve();

export function saveSettings(settings: SessionSettings): Promise<void> {
  const sanitized = sanitizeSettings(settings);
  // Range-Inputs können viele Änderungen pro Sekunde erzeugen. Serialisieren
  // verhindert, dass eine langsamere alte Speicherung einen neueren Wert
  // nachträglich überschreibt.
  saveQueue = saveQueue.catch(() => {}).then(() => chrome.storage.local.set(sanitized));
  return saveQueue;
}
