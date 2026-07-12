export interface VoiceDecision {
  speaking: boolean;
  probability: number;
}

const POSITIVE_THRESHOLD = 0.55;
const IMMEDIATE_THRESHOLD = 0.85;
const NEGATIVE_THRESHOLD = 0.25;
const ATTACK_WINDOW_FRAMES = 3;
const ATTACK_POSITIVE_FRAMES = 2;
const RELEASE_SCORE_LIMIT = 20;
const STRONG_NEGATIVE_SCORE = 2;
const AMBIGUOUS_NEGATIVE_SCORE = 1;
export const DUCKED_SOURCE_GAIN = 0.1;

export interface DuckingState {
  dubbing: boolean;
  fullOriginal: boolean;
  sourceSpeaking: boolean;
  translationReady: boolean;
}

/**
 * Exakter linearer Zielpegel für den dynamischen Originalpfad. Nur erkannte
 * Sprache im Quellvideo darf das Original absenken.
 */
export function sourceDuckGain(state: DuckingState): number {
  if (
    !state.dubbing ||
    state.fullOriginal ||
    !state.sourceSpeaking ||
    !state.translationReady
  ) {
    return 1;
  }
  return DUCKED_SOURCE_GAIN;
}

/** Exakte Pfadwahl: Full-Modus ist 100 % Dry und 0 % dynamischer Pfad. */
export function sourcePathMix(state: Pick<DuckingState, 'dubbing' | 'fullOriginal'>): {
  dry: number;
  dynamic: number;
} {
  const useDryBypass = state.fullOriginal || !state.dubbing;
  return useDryBypass ? { dry: 1, dynamic: 0 } : { dry: 0, dynamic: 1 };
}

/**
 * Hysterese für Silero-v6-Wahrscheinlichkeiten (ein Frame = 32 ms).
 * Zwei positive Frames innerhalb von drei starten das Ducking. Beim Release
 * zählen sichere Nicht-Sprach-Frames doppelt und mehrdeutige Frames einfach;
 * 20 Punkte entsprechen 320–640 ms. So verbinden wir natürliche Wortpausen,
 * ohne bei dauerhaft mittleren Werten endlos zu ducken. Ungültige Werte gelten
 * als sichere Nicht-Sprache, damit VAD-Fehler niemals dauerhaft ducken.
 */
export class SpeechProbabilityDetector {
  private speaking = false;
  private readonly attackWindow: boolean[] = [];
  private releaseScore = 0;

  update(value: number): VoiceDecision {
    const probability = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    if (!this.speaking) {
      if (probability >= IMMEDIATE_THRESHOLD) {
        this.speaking = true;
        this.releaseScore = 0;
        this.attackWindow.length = 0;
        return { speaking: true, probability };
      }
      this.attackWindow.push(probability >= POSITIVE_THRESHOLD);
      if (this.attackWindow.length > ATTACK_WINDOW_FRAMES) this.attackWindow.shift();
      if (this.attackWindow.filter(Boolean).length >= ATTACK_POSITIVE_FRAMES) {
        this.speaking = true;
        this.releaseScore = 0;
        this.attackWindow.length = 0;
      }
    } else {
      if (probability >= POSITIVE_THRESHOLD) {
        this.releaseScore = 0;
      } else {
        this.releaseScore = Math.min(
          RELEASE_SCORE_LIMIT,
          this.releaseScore +
            (probability < NEGATIVE_THRESHOLD
              ? STRONG_NEGATIVE_SCORE
              : AMBIGUOUS_NEGATIVE_SCORE)
        );
        if (this.releaseScore >= RELEASE_SCORE_LIMIT) this.reset();
      }
    }
    return { speaking: this.speaking, probability };
  }

  reset(): void {
    this.speaking = false;
    this.releaseScore = 0;
    this.attackWindow.length = 0;
  }
}
