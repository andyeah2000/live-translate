import type { SessionSettings } from './messages';

const RESTRICTED_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'devtools://',
  'view-source:',
  'https://chromewebstore.google.com',
  'https://chrome.google.com/webstore'
];

export function configurationError(settings: SessionSettings): string | null {
  if (!settings.geminiKey) return 'Bitte zuerst einen Gemini API-Key eintragen.';
  if (!settings.subtitles && !settings.dubbing) {
    return 'Bitte mindestens Untertitel oder übersetzte Tonspur aktivieren.';
  }
  return null;
}

export function isTranslatableUrl(url: string | undefined): boolean {
  return Boolean(url && !RESTRICTED_PREFIXES.some((prefix) => url.startsWith(prefix)));
}
