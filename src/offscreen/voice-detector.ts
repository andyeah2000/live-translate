export interface VoiceMeasurement {
  bandRms: number;
  totalRms: number;
  nowMs: number;
}

export interface VoiceDecision {
  speaking: boolean;
  bandRatio: number;
}

// Hysterese hält kurze Silbenpausen zusammen. Der Verhältniswert unterdrückt
// tieffrequente Raketen-/Motorgeräusche, deren Energie überwiegend außerhalb
// des Sprachbands liegt.
const START_MIN_RMS = 0.01;
const START_MIN_RATIO = 0.48;
const CONTINUE_MIN_RMS = 0.005;
const CONTINUE_MIN_RATIO = 0.3;
const RELEASE_HOLD_MS = 80;

export interface DuckingState {
  dubbing: boolean;
  fullOriginal: boolean;
  sourceSpeaking: boolean;
  backgroundVolume: number;
}

/**
 * Exakter linearer Zielpegel für den dynamischen Originalpfad. Nur erkannte
 * Sprache im Quellvideo darf das Original absenken.
 */
export function sourceDuckGain(state: DuckingState): number {
  if (!state.dubbing || state.fullOriginal || !state.sourceSpeaking) return 1;
  return Number.isFinite(state.backgroundVolume)
    ? Math.min(1, Math.max(0, state.backgroundVolume))
    : 1;
}

/** Exakte Pfadwahl: Full-Modus ist 100 % Dry und 0 % EQ-Pfad. */
export function sourcePathMix(state: Pick<DuckingState, 'dubbing' | 'fullOriginal'>): {
  dry: number;
  dynamic: number;
} {
  const useDryBypass = state.fullOriginal || !state.dubbing;
  return useDryBypass ? { dry: 1, dynamic: 0 } : { dry: 0, dynamic: 1 };
}

/** Zustandsbehaftete Aktivitätserkennung auf dem englischen Quellton. */
export class SourceVoiceDetector {
  private speaking = false;
  private lastVoiceAt = Number.NEGATIVE_INFINITY;

  update(measurement: VoiceMeasurement): VoiceDecision {
    const bandRms = finitePositive(measurement.bandRms);
    const totalRms = finitePositive(measurement.totalRms);
    const nowMs = Number.isFinite(measurement.nowMs) ? measurement.nowMs : 0;
    const bandRatio = totalRms > 0.001 ? bandRms / totalRms : 0;
    const hasVoiceEnergy = this.speaking
      ? bandRms >= CONTINUE_MIN_RMS && bandRatio >= CONTINUE_MIN_RATIO
      : bandRms >= START_MIN_RMS && bandRatio >= START_MIN_RATIO;

    if (hasVoiceEnergy) {
      this.lastVoiceAt = nowMs;
      this.speaking = true;
    } else if (this.speaking && nowMs - this.lastVoiceAt >= RELEASE_HOLD_MS) {
      this.speaking = false;
    }

    return { speaking: this.speaking, bandRatio };
  }
}

function finitePositive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
