/** Modellspezifische Vorgabe für Gemini 3.5 Live Translate. */
export const CAPTURE_BATCH_MS = 20;
export const SEND_CHUNK_MS = 100;

/**
 * Überbrückt Setup und den ersten schnellen Reconnect, ohne mehr Audio zu
 * puffern als der WebSocket anschließend verzögerungsarm senden kann.
 */
export const MAX_PREROLL_AUDIO_MS = 500;

export function samplesForDuration(sampleRate: number, durationMs: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 0;
  return Math.max(1, Math.round((sampleRate * durationMs) / 1_000));
}

/** Erster Netz-Reconnect nach 250 ms, danach begrenzt exponentiell. */
export function reconnectDelayMs(attempt: number): number {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  return Math.min(30_000, 250 * 2 ** (normalizedAttempt - 1));
}
