/** Portable planar PCM. Samples are full-scale floating point; never silently clipped. */
export interface AudioData {
  readonly sampleRate: number;
  readonly channels: readonly Float32Array[];
}

export const LIMITS = Object.freeze({
  maxFileBytes: 100 * 1024 * 1024,
  maxDecodedBytes: 192 * 1024 * 1024,
  maxSeconds: 600,
  minSampleRate: 8000,
  maxSampleRate: 192000,
});

export interface WaveformChannel { min: number[]; max: number[] }
export interface AnalysisResult {
  schemaVersion: 1;
  algorithmVersion: '0.1.0';
  sampleRate: number;
  channels: number;
  frames: number;
  durationSeconds: number;
  samplePeakDbfs: number | null;
  rmsDbfs: number | null;
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  truePeakMethod: '4x-windowed-sinc-estimate';
  crestFactorDb: number | null;
  stereoCorrelation: number | null;
  sideEnergyPercent: number | null;
  clippedSamples: number;
  dcOffset: number[];
  waveform: WaveformChannel[];
  warnings: string[];
}

export function validateAudio(audio: AudioData): void {
  const { sampleRate, channels } = audio;
  if (!Number.isInteger(sampleRate) || sampleRate < LIMITS.minSampleRate || sampleRate > LIMITS.maxSampleRate)
    throw new Error('対応サンプルレートは 8–192 kHz です。');
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2)
    throw new Error('モノラル／ステレオ音声に対応しています。');
  const frames = channels[0]?.length ?? 0;
  if (!frames) throw new Error('音声データが空です。');
  if (frames / sampleRate > LIMITS.maxSeconds || frames * channels.length * 4 > LIMITS.maxDecodedBytes)
    throw new Error('音声が大きすぎます。10分以内・展開後192 MiB以内に分割してください。');
  for (const channel of channels) {
    if (!(channel instanceof Float32Array) || channel.length !== frames)
      throw new Error('PCMチャンネルの長さまたは形式が不正です。');
    for (let i = 0; i < frames; i++) {
      if (!Number.isFinite(channel[i]) || Math.abs(channel[i]) > 32)
        throw new Error('音声に不正なサンプル値が含まれています。');
    }
  }
}

/** null represents silence or an undefined measurement in JSON. */
export function amplitudeToDb(value: number): number | null {
  return value > 0 ? 20 * Math.log10(value) : null;
}

/** Reserved asynchronous host adapter; processAudio is currently synchronous. */
export interface AudioProcessor {
  readonly id: string;
  process(input: AudioData, signal?: AbortSignal): Promise<AudioData>;
}
