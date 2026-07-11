export interface VoiceDecision {
  speaking: boolean;
  probability: number;
}

const POSITIVE_THRESHOLD = 0.55;
const IMMEDIATE_THRESHOLD = 0.85;
const NEGATIVE_THRESHOLD = 0.25;
const ATTACK_WINDOW_FRAMES = 3;
const ATTACK_POSITIVE_FRAMES = 2;
const RELEASE_NEGATIVE_FRAMES = 4;

export interface DuckingState {
  dubbing: boolean;
  fullOriginal: boolean;
  sourceSpeaking: boolean;
  translationReady: boolean;
  backgroundVolume: number;
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
  return Number.isFinite(state.backgroundVolume)
    ? Math.min(1, Math.max(0, state.backgroundVolume))
    : 1;
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
 * Zwei positive Frames innerhalb von drei starten das Ducking; vier sicher
 * negative Frames beenden es. Ungültige Werte gelten immer als Nicht-Sprache,
 * damit ein VAD-Fehler den Originalton niemals dauerhaft leise hält.
 */
export class SpeechProbabilityDetector {
  private speaking = false;
  private readonly attackWindow: boolean[] = [];
  private negativeFrames = 0;

  update(value: number): VoiceDecision {
    const probability = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    if (!this.speaking) {
      if (probability >= IMMEDIATE_THRESHOLD) {
        this.speaking = true;
        this.negativeFrames = 0;
        this.attackWindow.length = 0;
        return { speaking: true, probability };
      }
      this.attackWindow.push(probability >= POSITIVE_THRESHOLD);
      if (this.attackWindow.length > ATTACK_WINDOW_FRAMES) this.attackWindow.shift();
      if (this.attackWindow.filter(Boolean).length >= ATTACK_POSITIVE_FRAMES) {
        this.speaking = true;
        this.negativeFrames = 0;
        this.attackWindow.length = 0;
      }
    } else if (probability < NEGATIVE_THRESHOLD) {
      this.negativeFrames++;
      if (this.negativeFrames >= RELEASE_NEGATIVE_FRAMES) this.reset();
    } else {
      this.negativeFrames = 0;
    }
    return { speaking: this.speaking, probability };
  }

  reset(): void {
    this.speaking = false;
    this.negativeFrames = 0;
    this.attackWindow.length = 0;
  }
}
