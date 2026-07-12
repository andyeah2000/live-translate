export {};

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor
): void;
declare const currentFrame: number;
declare const sampleRate: number;

const BATCH_SIZE = 2048;

/** Lückenloser Stereo→Mono-Capturepfad ausschließlich für die lokale VAD. */
class VadCaptureProcessor extends AudioWorkletProcessor {
  private buffer = new Float32Array(BATCH_SIZE);
  private offset = 0;
  private sequence = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const left = input?.[0];
    if (!left) return true;
    const right = input?.[1];
    let inputOffset = 0;
    while (inputOffset < left.length) {
      const count = Math.min(left.length - inputOffset, BATCH_SIZE - this.offset);
      for (let i = 0; i < count; i++) {
        const index = inputOffset + i;
        this.buffer[this.offset + i] = right
          ? ((left[index] ?? 0) + (right[index] ?? 0)) * 0.5
          : (left[index] ?? 0);
      }
      this.offset += count;
      inputOffset += count;
      if (this.offset === BATCH_SIZE) {
        const complete = this.buffer;
        this.buffer = new Float32Array(BATCH_SIZE);
        this.offset = 0;
        // currentFrame/sampleRate bilden die monotone AudioContext-Zeitachse.
        // inputOffset lokalisiert das Blockende exakt innerhalb dieses Quants.
        const captureEndTime = (currentFrame + inputOffset) / sampleRate;
        this.port.postMessage(
          { samples: complete, sequence: this.sequence++, captureEndTime },
          [complete.buffer]
        );
      }
    }
    return true;
  }
}

registerProcessor('vad-pcm-capture', VadCaptureProcessor);
