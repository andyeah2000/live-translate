// Läuft im AudioWorklet-Kontext (eigener Thread, eigene Globals).
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor
): void;

const BATCH_SIZE = 2048;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private buffer = new Float32Array(BATCH_SIZE);
  private offset = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const ch0 = input?.[0];
    if (!ch0) return true;
    const ch1 = input?.[1];

    let mono = ch0;
    if (ch1) {
      mono = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) mono[i] = ((ch0[i] ?? 0) + (ch1[i] ?? 0)) / 2;
    }

    let i = 0;
    while (i < mono.length) {
      const n = Math.min(mono.length - i, BATCH_SIZE - this.offset);
      this.buffer.set(mono.subarray(i, i + n), this.offset);
      this.offset += n;
      i += n;
      if (this.offset === BATCH_SIZE) {
        this.port.postMessage(this.buffer.slice(0));
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
