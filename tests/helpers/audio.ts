import type { AudioData } from '@music-sync/shared';

export function tone({ sampleRate = 48000, seconds = 1, amplitude = 0.1, frequency = 1000, stereo = false, phase = 0 } = {}): AudioData {
  const left = Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate + phase));
  return { sampleRate, channels: stereo ? [left, left.slice()] : [left] };
}

export function wav(audio: AudioData, bits = 16, float = false): ArrayBuffer {
  const channels = audio.channels.length, frames = audio.channels[0].length, bytes = bits / 8;
  const buffer = new ArrayBuffer(44 + frames * channels * bytes), view = new DataView(buffer);
  const text = (start: number, s: string) => [...s].forEach((c, i) => view.setUint8(start + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, float ? 3 : 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, audio.sampleRate, true); view.setUint32(28, audio.sampleRate * channels * bytes, true);
  view.setUint16(32, channels * bytes, true); view.setUint16(34, bits, true); text(36, 'data'); view.setUint32(40, frames * channels * bytes, true);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    const p = 44 + (i * channels + c) * bytes, sample = audio.channels[c][i];
    if (float) view.setFloat32(p, sample, true);
    else {
      const scale = 2 ** (bits - 1), integer = Math.max(-scale, Math.min(scale - 1, Math.round(sample * scale)));
      if (bits === 8) view.setUint8(p, integer + 128);
      if (bits === 16) view.setInt16(p, integer, true);
      if (bits === 24) { view.setUint8(p, integer & 255); view.setUint8(p + 1, (integer >> 8) & 255); view.setUint8(p + 2, (integer >> 16) & 255); }
      if (bits === 32) view.setInt32(p, integer, true);
    }
  }
  return buffer;
}
