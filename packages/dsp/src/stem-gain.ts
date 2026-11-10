import type { AudioData } from '@music-sync/shared';

const smooth = (value: number) => value * value * (3 - 2 * value);

/** Small positive gain on owned PCM. Zero windows remain sample-identical.
 * Each positive run fades over up to 100 ms inside its own bounds. Adjacent
 * positive windows interpolate at their centres without repeated window dips.
 * The caller must evaluate the candidate and protect its whole-mix true peak.
 */
export function createStemGain(sampleRate: number, channels: number, windowFrames: number, gainDb: Float32Array) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
    ![1, 2].includes(channels) || !Number.isSafeInteger(windowFrames) || windowFrames < 1 ||
    !(gainDb instanceof Float32Array) || !Number.isSafeInteger(gainDb.length * windowFrames) ||
    gainDb.some(value => !Number.isFinite(value) || value < 0 || value > 1.5))
    throw new Error('STEMの歌声サポート量または形式が不正です。');
  const curve = gainDb.slice();
  const starts = new Uint32Array(curve.length), ends = new Uint32Array(curve.length);
  let applied = false;
  for (let i = 0; i < curve.length;) {
    if (!curve[i]) { i++; continue; }
    const start = i;
    while (i < curve.length && curve[i] > 0) i++;
    starts.fill(start, start, i); ends.fill(i, start, i); applied = true;
  }
  let offset = 0;
  return {
    applied,
    processOwned(audio: AudioData): void {
      const frames = audio.channels[0]?.length ?? 0;
      if (audio.sampleRate !== sampleRate || audio.channels.length !== channels || !frames ||
        !Number.isSafeInteger(offset + frames) ||
        audio.channels.some(channel => !(channel instanceof Float32Array) || channel.length !== frames))
        throw new Error('STEMの歌声サポート中に音声形式が変わりました。');
      // Validate the complete chunk before modifying any owned samples.
      for (const channel of audio.channels) for (const value of channel)
        if (!Number.isFinite(value) || Math.abs(value) > 32) throw new Error('STEMに不正なサンプル値があります。');
      if (!applied) { offset += frames; return; }
      for (let i = 0; i < frames; i++, offset++) {
        const index = Math.floor(offset / windowFrames), current = curve[index] ?? 0;
        if (!current) continue;
        const position = offset + 0.5;
        const relative = position / windowFrames - index - 0.5;
        const previous = curve[index - 1] || current, next = curve[index + 1] || current;
        const db = relative < 0 ? previous + (current - previous) * smooth(relative + 1) :
          current + (next - current) * smooth(relative);
        const first = starts[index] * windowFrames, last = ends[index] * windowFrames;
        const fadeFrames = Math.min(sampleRate * 0.1, (last - first) / 2);
        const distance = Math.min(position - first, last - position);
        const envelope = smooth(Math.min(1, Math.max(0, distance / fadeFrames)));
        const gain = 10 ** (db * envelope / 20);
        for (let c = 0; c < channels; c++) audio.channels[c][i] *= gain;
      }
    },
  };
}
