import type { SessionSettings, SubtitleMode } from './messages';

/** GPT-Live-Stimmen aus der offiziellen OpenAI-Dokumentation. */
export const VOICE_IDS = new Set([
  'marin', 'quartz', 'ripple', 'vesper', 'willow', 'stone', 'gleam', 'meridian',
  'bossa', 'tempo', 'beacon', 'delta', 'cinder'
]);

const SUBTITLE_MODES = new Set<SubtitleMode>(['translation', 'dual']);
export const MAX_SERVER_TOKEN_LENGTH = 1_024;
const DEFAULT_SERVER_URL = 'http://127.0.0.1:8787';

export const DEFAULT_SETTINGS: SessionSettings = {
  settingsVersion: 11,
  liveServerUrl: DEFAULT_SERVER_URL,
  liveServerToken: '',
  liveVoice: 'meridian',
  subtitles: true,
  subtitleMode: 'translation',
  translationVolume: 1,
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

/** Validate the same backend address before permission prompts and persistence. */
export function normalizeServerUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    const localHttp =
      url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    if (url.protocol !== 'https:' && !localHttp) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function enumValue<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value as T) ? (value as T) : fallback;
}

/** Jede geladene Browser-Einstellung wird auf die GPT-Live-Grenze reduziert. */
export function sanitizeSettings(value: unknown): SessionSettings {
  const candidate = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    settingsVersion: DEFAULT_SETTINGS.settingsVersion,
    liveServerUrl: normalizeServerUrl(candidate.liveServerUrl) ?? DEFAULT_SETTINGS.liveServerUrl,
    liveServerToken: stringValue(candidate.liveServerToken, '')
      .trim()
      .slice(0, MAX_SERVER_TOKEN_LENGTH),
    liveVoice: enumValue(candidate.liveVoice, VOICE_IDS, DEFAULT_SETTINGS.liveVoice),
    subtitles: booleanValue(candidate.subtitles, DEFAULT_SETTINGS.subtitles),
    subtitleMode: enumValue(candidate.subtitleMode, SUBTITLE_MODES, DEFAULT_SETTINGS.subtitleMode),
    translationVolume: volumeValue(candidate.translationVolume, DEFAULT_SETTINGS.translationVolume)
  };
}

let storageQueue: Promise<unknown> = Promise.resolve();

function queueStorage<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageQueue.catch(() => {}).then(operation);
  storageQueue = result;
  return result;
}

export function loadSettings(): Promise<SessionSettings> {
  return queueStorage(async () => {
    const stored = await chrome.storage.local.get(null);
    const settings = sanitizeSettings(stored);
    // Remove obsolete credentials and options; retain only current controls.
    await chrome.storage.local.set(settings);
    const unknownKeys = Object.keys(stored).filter((key) => !CANONICAL_SETTING_KEYS.has(key));
    if (unknownKeys.length > 0) await chrome.storage.local.remove(unknownKeys);
    return settings;
  });
}

export function saveSettings(settings: SessionSettings): Promise<void> {
  const sanitized = sanitizeSettings(settings);
  return queueStorage(() => chrome.storage.local.set(sanitized));
}
