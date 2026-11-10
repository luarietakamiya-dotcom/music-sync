import type { AudioData } from '@music-sync/shared';

/** Modulated delayed mid signal added in opposite polarity. Mono fold-down stays dry. */
export function humanDouble(rate: number, delayMs: number, amount: number) {
  if (!Number.isFinite(delayMs) || delayMs < 12 || delayMs > 45 || !Number.isFinite(amount) || amount < 0 || amount > 100)
    throw new Error('ギターダブリングの設定が範囲外です。');
  const ring = new Float32Array(Math.ceil(rate * 0.05) + 2);
  const depth = rate * 0.0009, base = rate * delayMs / 1000;
  let write = 0, phase = 0, low = 0;
  const bass = 1 - Math.exp(-2 * Math.PI * 180 / rate);
  return (audio: AudioData) => {
    const [left, right] = audio.channels;
    for (let i = 0; i < left.length; i++) {
      const mid = (left[i] + right[i]) / 2;
      low += bass * (mid - low); ring[write] = mid - low;
      const cursor = (write - base - depth * Math.sin(phase) + ring.length) % ring.length;
      const n = Math.floor(cursor), frac = cursor - n;
      const side = (ring[n] + frac * (ring[(n + 1) % ring.length] - ring[n])) * 0.38 * amount / 100;
      left[i] += side; right[i] -= side;
      write = (write + 1) % ring.length; phase += 2 * Math.PI * 0.67 / rate;
    }
  };
}
