import profile from '../macos/Sources/LiveTranslateCore/Resources/translation-profile.json';

/** One profile for server, extension and macOS app: model, voices and steering texts. */
export interface TranslationProfile {
  version: number;
  model: string;
  defaultVoice: string;
  voices: string[];
  instructions: string;
  englishOnlyInstructions: string;
  automaticInstructions: string;
  delegationRecovery: string;
  catchUpTighten: string;
  catchUpSkip: string;
}

export const TRANSLATION_PROFILE: Readonly<TranslationProfile> = profile;
