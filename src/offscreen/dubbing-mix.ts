/** Original stays intact unless decoded translation audio is actually playing. */
export function dubbingSourceGain(sourceSpeaking: boolean, outputActive: boolean, volume: number): number {
  if (!outputActive || !Number.isFinite(volume) || volume <= 0) return 1;
  // More atmosphere between original words, more separation when voices overlap.
  return sourceSpeaking ? 0.28 : 0.6;
}

/** Short hold bridges syllables, without suppressing original audio for seconds. */
export class OutputActivity {
  private lastActive = -Infinity;
  update(samples: Float32Array, nowMs: number): boolean {
    let energy = 0;
    for (const value of samples) energy += value * value;
    if (samples.length && Math.sqrt(energy / samples.length) > 0.001) this.lastActive = nowMs;
    return nowMs - this.lastActive < 220;
  }
}
