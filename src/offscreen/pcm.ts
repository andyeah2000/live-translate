const TARGET_RATE = 16000;
const FIR_TAPS = 63;
const CUTOFF_HZ = 7000;
const HIGHPASS_HZ = 80;

/**
 * Aufbereitung für den 16-kHz-Weg zur KI („weniger ist mehr"):
 * 1. einpoliger Highpass gegen Bass-Rumpeln,
 * 2. FIR-Tiefpass (Windowed Sinc, Blackman) als sauberes Anti-Aliasing,
 * 3. phasenkontinuierliches Resampling auf 16 kHz über Chunk-Grenzen hinweg.
 */
export class SpeechPreprocessor {
  private readonly coeffs: Float32Array<ArrayBuffer>;
  private firHistory: Float32Array<ArrayBuffer>;
  private readonly hpAlpha: number;
  private readonly highpassEnabled: boolean;
  private hpPrevIn = 0;
  private hpPrevOut = 0;
  private resampleBuffer: Float32Array<ArrayBuffer> = new Float32Array(0);
  private resamplePos = 0;
  private readonly step: number;

  constructor(inputRate: number, options: { highpass?: boolean } = {}) {
    if (!Number.isFinite(inputRate) || inputRate < TARGET_RATE) {
      throw new Error(`Nicht unterstützte Audio-Samplerate: ${inputRate}`);
    }
    this.highpassEnabled = options.highpass !== false;
    this.step = inputRate / TARGET_RATE;
    const rc = 1 / (2 * Math.PI * HIGHPASS_HZ);
    this.hpAlpha = rc / (rc + 1 / inputRate);

    const coeffs = new Float32Array(FIR_TAPS);
    const fc = CUTOFF_HZ / inputRate;
    const mid = (FIR_TAPS - 1) / 2;
    let sum = 0;
    for (let i = 0; i < FIR_TAPS; i++) {
      const x = i - mid;
      const sinc = x === 0 ? 2 * Math.PI * fc : Math.sin(2 * Math.PI * fc * x) / x;
      const window =
        0.42 -
        0.5 * Math.cos((2 * Math.PI * i) / (FIR_TAPS - 1)) +
        0.08 * Math.cos((4 * Math.PI * i) / (FIR_TAPS - 1));
      coeffs[i] = sinc * window;
      sum += coeffs[i] ?? 0;
    }
    // Auf Verstärkung 1 im Durchlassbereich normieren.
    for (let i = 0; i < FIR_TAPS; i++) coeffs[i] = (coeffs[i] ?? 0) / sum;
    this.coeffs = coeffs;
    this.firHistory = new Float32Array(FIR_TAPS - 1);
  }

  reset(): void {
    this.hpPrevIn = 0;
    this.hpPrevOut = 0;
    this.firHistory.fill(0);
    this.resampleBuffer = new Float32Array(0);
    this.resamplePos = 0;
  }

  process(chunk: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
    // 1. Highpass (zustandsbehaftet über Chunk-Grenzen)
    const hp = new Float32Array(chunk.length);
    let prevIn = this.hpPrevIn;
    let prevOut = this.hpPrevOut;
    for (let i = 0; i < chunk.length; i++) {
      const x = chunk[i] ?? 0;
      const y = this.highpassEnabled ? this.hpAlpha * (prevOut + x - prevIn) : x;
      hp[i] = y;
      prevIn = x;
      prevOut = y;
    }
    this.hpPrevIn = prevIn;
    this.hpPrevOut = prevOut;

    // 2. FIR-Tiefpass (History sorgt für nahtlose Chunk-Grenzen)
    const input = new Float32Array(this.firHistory.length + hp.length);
    input.set(this.firHistory, 0);
    input.set(hp, this.firHistory.length);
    const filtered = new Float32Array(hp.length);
    for (let i = 0; i < hp.length; i++) {
      let acc = 0;
      for (let k = 0; k < FIR_TAPS; k++) acc += (this.coeffs[k] ?? 0) * (input[i + k] ?? 0);
      filtered[i] = acc;
    }
    this.firHistory = input.slice(input.length - (FIR_TAPS - 1));

    // 3. Resampling auf 16 kHz mit fraktionaler Positions-Fortschreibung
    const buf = new Float32Array(this.resampleBuffer.length + filtered.length);
    buf.set(this.resampleBuffer, 0);
    buf.set(filtered, this.resampleBuffer.length);
    const count = Math.max(0, Math.ceil((buf.length - 1 - this.resamplePos) / this.step));
    const out = new Float32Array(count);
    let produced = 0;
    while (this.resamplePos + 1 < buf.length && produced < count) {
      const i0 = Math.floor(this.resamplePos);
      const frac = this.resamplePos - i0;
      out[produced++] = (buf[i0] ?? 0) * (1 - frac) + (buf[i0 + 1] ?? 0) * frac;
      this.resamplePos += this.step;
    }
    // resamplePos kann nach dem letzten gültigen Output um bis zu `step`
    // hinter das aktuelle Chunk-Ende springen. Nur tatsächlich vorhandene
    // Samples verwerfen und den Rest als Offset in das nächste Chunk tragen;
    // sonst entsteht an manchen Grenzen ein doppeltes Output-Sample.
    const consumed = Math.min(Math.floor(this.resamplePos), buf.length);
    this.resampleBuffer = buf.slice(consumed);
    this.resamplePos -= consumed;
    return produced === count ? out : out.slice(0, produced);
  }
}

export function floatToInt16(input: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

export function int16ToFloat(input: Int16Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = (input[i] ?? 0) / 0x8000;
  return out;
}

export function base64FromInt16(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function int16FromBase64(data: string): Int16Array<ArrayBuffer> {
  const binary = atob(data);
  // Auf gerade Bytezahl kürzen – ein halbes PCM16-Sample ist nicht dekodierbar.
  const usable = binary.length - (binary.length % 2);
  const bytes = new Uint8Array(usable);
  for (let i = 0; i < usable; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}
