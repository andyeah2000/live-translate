import { readFileSync } from 'node:fs';

export const TRANSLATION_PROFILE = JSON.parse(readFileSync(
  new URL('../macos/Sources/LiveTranslateCore/Resources/translation-profile.json', import.meta.url), 'utf8'
));
export const DUBBING_VOICE = TRANSLATION_PROFILE.defaultVoice;
export const DUBBING_PROMPT = `${TRANSLATION_PROFILE.instructions}\n${TRANSLATION_PROFILE.englishOnlyInstructions}`;
