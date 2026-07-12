/**
 * Transparenter Sample-Limiter für Sprache und den finalen Mix.
 *
 * Bis zum Knie bleibt das Signal bitgenau unverändert. Darüber nähert sich
 * die Kennlinie weich der Obergrenze. Anders als DynamicsCompressorNode kann
 * dieser Limiter auch sehr kurze Transienten nicht über die Grenze lassen.
 */
export const SOFT_LIMIT_KNEE = 0.8;
export const SOFT_LIMIT_CEILING = 0.98;

export function softLimitSample(
  sample: number,
  knee = SOFT_LIMIT_KNEE,
  ceiling = SOFT_LIMIT_CEILING
): number {
  if (!Number.isFinite(sample)) return 0;
  const magnitude = Math.abs(sample);
  if (magnitude <= knee) return sample;
  const limited = knee + (ceiling - knee) * Math.tanh((magnitude - knee) / (ceiling - knee));
  return Math.sign(sample) * limited;
}

export function softLimitInPlace(
  samples: Float32Array,
  knee = SOFT_LIMIT_KNEE,
  ceiling = SOFT_LIMIT_CEILING
): void {
  for (let index = 0; index < samples.length; index++) {
    samples[index] = softLimitSample(samples[index] ?? 0, knee, ceiling);
  }
}

/** Transferkurve für einen WaveShaperNode im gemeinsamen Ausgangspfad. */
export function createSoftLimiterCurve(
  points = 65_537,
  knee = SOFT_LIMIT_KNEE,
  ceiling = SOFT_LIMIT_CEILING
): Float32Array<ArrayBuffer> {
  const count = Math.max(3, Math.floor(points));
  const curve = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    const input = (index / (count - 1)) * 2 - 1;
    curve[index] = softLimitSample(input, knee, ceiling);
  }
  return curve;
}
