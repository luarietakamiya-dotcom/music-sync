import { validateAudio, type AudioData } from '@music-sync/shared';

/** IEEE Float32 RIFF/WAVE, interleaved, fact chunk, no clipping/dither/resampling. */
export function encodeFloatWav(audio: AudioData): ArrayBuffer {
  validateAudio(audio);
  const count = audio.channels.length, frames = audio.channels[0].length, bytes = frames * count * 4;
  const buffer = new ArrayBuffer(56 + bytes);
  new Uint8Array(buffer).set(new Uint8Array(floatWavHeader(audio.sampleRate, count, frames)));
  writeFloatSamples(audio, new DataView(buffer, 56));
  return buffer;
}

export function floatWavHeader(sampleRate: number, count: number, frames: number): ArrayBuffer {
  const bytes = frames * count * 4;
  const buffer = new ArrayBuffer(56), view = new DataView(buffer);
  const tag = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  tag(0, 'RIFF'); view.setUint32(4, 48 + bytes, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true);
  view.setUint16(22, count, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * 4, true); view.setUint16(32, count * 4, true); view.setUint16(34, 32, true);
  tag(36, 'fact'); view.setUint32(40, 4, true); view.setUint32(44, frames, true);
  tag(48, 'data'); view.setUint32(52, bytes, true);
  return buffer;
}

export function writeFloatSamples(audio: AudioData, view: DataView): void {
  const frames = audio.channels[0].length;
  let offset = 0;
  for (let i = 0; i < frames; i++) for (const channel of audio.channels) { view.setFloat32(offset, channel[i], true); offset += 4; }
}
