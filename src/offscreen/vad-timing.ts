export interface CaptureStamp {
  sequence: number;
  captureEndTime: number;
  sampleCount: number;
}

const DEFAULT_INTERVAL_FACTOR = 1.75;

/**
 * AudioWorklet-Blöcke müssen sowohl in der Sequenz als auch auf der monotonen
 * AudioContext-Zeitachse lückenlos sein. So erkennen wir verlorene Blöcke,
 * ohne von verstellbarer Systemzeit oder Message-Queue-Latenz abzuhängen.
 */
export function hasCaptureDiscontinuity(
  previous: CaptureStamp | null,
  current: CaptureStamp,
  sampleRate: number,
  intervalFactor = DEFAULT_INTERVAL_FACTOR
): boolean {
  if (
    !Number.isSafeInteger(current.sequence) ||
    current.sequence < 0 ||
    !Number.isFinite(current.captureEndTime) ||
    !Number.isSafeInteger(current.sampleCount) ||
    current.sampleCount <= 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isFinite(intervalFactor) ||
    intervalFactor <= 1
  ) {
    return true;
  }
  if (previous === null) return false;
  if (current.sequence !== previous.sequence + 1) return true;

  const actualInterval = current.captureEndTime - previous.captureEndTime;
  const expectedInterval = current.sampleCount / sampleRate;
  return (
    !Number.isFinite(actualInterval) ||
    actualInterval <= 0 ||
    actualInterval < expectedInterval / intervalFactor ||
    actualInterval > expectedInterval * intervalFactor
  );
}

/** Exakte Endzeit eines VAD-Frames innerhalb des gerade erzeugten 16-kHz-Blocks. */
export function outputFrameEndTime(
  captureEndTime: number,
  outputSampleCount: number,
  consumedOutputSamples: number,
  outputSampleRate: number
): number {
  if (
    !Number.isFinite(captureEndTime) ||
    !Number.isSafeInteger(outputSampleCount) ||
    !Number.isSafeInteger(consumedOutputSamples) ||
    outputSampleCount < 0 ||
    consumedOutputSamples < 0 ||
    consumedOutputSamples > outputSampleCount ||
    !Number.isFinite(outputSampleRate) ||
    outputSampleRate <= 0
  ) {
    return Number.NaN;
  }
  return captureEndTime - (outputSampleCount - consumedOutputSamples) / outputSampleRate;
}

/** Behält die neuesten Blöcke, verarbeitet sie aber weiterhin strikt FIFO. */
export function pushBoundedFifo<T>(queue: T[], item: T, maximumLength: number): boolean {
  if (!Number.isSafeInteger(maximumLength) || maximumLength <= 0) {
    throw new Error(`Ungültige FIFO-Grenze: ${maximumLength}`);
  }
  const dropped = queue.length >= maximumLength;
  if (dropped) queue.shift();
  queue.push(item);
  return dropped;
}
