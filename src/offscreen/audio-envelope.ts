/**
 * Hörbar sanfte Pegelverläufe. Die längere Freigabe verhindert, dass Musik
 * und Atmo in kurzen Sprechpausen pumpen; die Absenkung bleibt schnell genug,
 * damit der übersetzte Satz nicht gegen das englische Original ankämpft.
 */
export const SOURCE_DUCK_FADE_DOWN_S = 0.22;
export const SOURCE_DUCK_FADE_UP_S = 0.7;

/** Gemini wird pro zusammenhängendem Sprach-Turn ein- und ausgeblendet. */
export const GEMINI_FADE_IN_S = 0.09;
export const GEMINI_FADE_OUT_S = 0.14;
export const GEMINI_INTERRUPT_FADE_S = 0.06;

const DEFAULT_CURVE_POINTS = 64;

/**
 * Raised-Cosine/S-Curve mit waagerechter Tangente an beiden Enden. Dadurch
 * ändern sich Pegel und Änderungsgeschwindigkeit ohne hörbare Kante.
 */
export function cosineRamp(
  from: number,
  to: number,
  points = DEFAULT_CURVE_POINTS
): Float32Array<ArrayBuffer> {
  const count = Math.max(2, Math.floor(points));
  const curve = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    const position = index / (count - 1);
    const blend = (1 - Math.cos(Math.PI * position)) / 2;
    curve[index] = from + (to - from) * blend;
  }
  return curve;
}

/** Plant eine unterbrechbare S-Curve ab der aktuellen Param-Position. */
export function rampAudioParam(
  param: AudioParam,
  target: number,
  startTime: number,
  duration: number
): void {
  param.cancelAndHoldAtTime(startTime);
  const current = param.value;
  if (duration <= 0 || Math.abs(current - target) < 1e-6) {
    param.setValueAtTime(target, startTime);
    return;
  }
  param.setValueCurveAtTime(cosineRamp(current, target), startTime, duration);
}

/**
 * Blendet von dem am zukünftigen Startzeitpunkt tatsächlich berechneten Wert
 * aus. Anders als `param.value` berücksichtigt `cancelAndHoldAtTime` dabei
 * auch eine noch laufende oder erst zukünftig beginnende Fade-in-Kurve.
 */
export function fadeOutAudioParam(param: AudioParam, startTime: number, endTime: number): void {
  if (endTime <= startTime) {
    param.cancelAndHoldAtTime(startTime);
    param.setValueAtTime(0, startTime);
    return;
  }
  param.cancelAndHoldAtTime(startTime);
  param.linearRampToValueAtTime(0, endTime);
}

/**
 * Glättet nur die äußeren Kanten eines kompletten Gemini-Sprach-Turns. Die
 * inneren Netzwerk-Chunks bleiben unangetastet und damit lückenlos.
 */
export function applyCosineEdgeFades(
  samples: Float32Array,
  sampleRate: number,
  fadeInSeconds: number,
  fadeOutSeconds: number
): void {
  if (samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return;
  const fadeInSamples = Math.min(samples.length, Math.max(0, Math.round(sampleRate * fadeInSeconds)));
  const fadeOutSamples = Math.min(
    samples.length,
    Math.max(0, Math.round(sampleRate * fadeOutSeconds))
  );

  for (let index = 0; index < fadeInSamples; index++) {
    const position = fadeInSamples === 1 ? 1 : index / (fadeInSamples - 1);
    samples[index] = (samples[index] ?? 0) * ((1 - Math.cos(Math.PI * position)) / 2);
  }
  for (let index = 0; index < fadeOutSamples; index++) {
    const sampleIndex = samples.length - fadeOutSamples + index;
    const position = fadeOutSamples === 1 ? 0 : index / (fadeOutSamples - 1);
    samples[sampleIndex] =
      (samples[sampleIndex] ?? 0) * ((1 + Math.cos(Math.PI * position)) / 2);
  }
}
