import type { AudioData } from '@music-sync/shared';
import { fft } from './fft.js';

export interface TrebleFrame {
  high: number; presence: number; body: number; flatness: number; transient: boolean; peak: number;
}

/** Each frame describes about 21 ms. No full-song PCM is retained. */
export class TrebleAnalyzer {
  readonly size: number;
  readonly frames: TrebleFrame[] = [];
  private readonly pcm: Float32Array[];
  private readonly real: Float64Array;
  private readonly imag: Float64Array;
  private readonly window: Float64Array;
  private filled = 0;
  constructor(readonly rate: number, readonly channels: number, private center = 9000) {
    this.size = 2 ** Math.round(Math.log2(rate * 0.0213));
    this.pcm = Array.from({ length: channels }, () => new Float32Array(this.size));
    this.real = new Float64Array(this.size); this.imag = new Float64Array(this.size);
    this.window = Float64Array.from({ length: this.size }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.size));
  }
  push(audio: AudioData): void {
    if (audio.channels.length !== this.channels || audio.sampleRate !== this.rate) throw new Error('高域補修の入力形式が変わりました。');
    for (let offset = 0; offset < audio.channels[0].length;) {
      const count = Math.min(this.size - this.filled, audio.channels[0].length - offset);
      audio.channels.forEach((ch, i) => this.pcm[i].set(ch.subarray(offset, offset + count), this.filled));
      offset += count; this.filled += count;
      if (this.filled === this.size) { this.frames.push(this.measure()); this.filled = 0; }
    }
  }
  private measure(): TrebleFrame {
    const out = { high: 0, presence: 0, body: 0, flatness: 1, transient: false, peak: 0 };
    for (const channel of this.pcm) {
      const quarters = [0, 0, 0, 0];
      for (let i = 0; i < this.size; i++) {
        this.real[i] = channel[i] * this.window[i];
        out.peak = Math.max(out.peak, Math.abs(channel[i]));
        if (i) quarters[Math.floor(i * 4 / this.size)] += (channel[i] - channel[i - 1]) ** 2;
      }
      this.imag.fill(0); fft(this.real, this.imag);
      let high = 0, logs = 0, bins = 0;
      for (let k = 1; k < this.size / 2; k++) {
        const hz = k * this.rate / this.size;
        const power = (this.real[k] ** 2 + this.imag[k] ** 2) / this.size ** 2;
        if (hz >= this.center * (6500 / 9000) && hz <= Math.min(this.center * (12500 / 9000), this.rate * 0.47)) {
          high += power; logs += Math.log(power + 1e-24); bins++;
        }
        if (hz >= 4000 && hz <= 5500) out.presence += power;
        else if (hz >= 150 && hz < 4000) out.body += power;
      }
      out.high += high;
      if (high > 1e-10 && bins) {
        out.flatness = Math.min(out.flatness, Math.exp(logs / bins) / (high / bins));
        if (Math.max(...quarters) > 3 * Math.max(1e-15, Math.min(...quarters))) out.transient = true;
      }
    }
    return out;
  }
}
