import { createBiquad, peakingCoefficients } from '@music-sync/dsp';
import type { AnalysisResult, AudioData } from '@music-sync/shared';
import { validateFinishingPreferences, type FinishControls } from './finishing-preferences.js';

interface TonalStage {
  filter: ((value: number) => number)[];
  band?: 'bass' | 'lowMid' | 'high';
  threshold?: number;
  minimum?: number;
  wet: number;
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** Stateful finishing intent for owned PCM chunks. No full-song buffers are retained. */
export function createLongPreferences(before: AnalysisResult, controls: FinishControls, strength: number) {
  validateFinishingPreferences({ controls, output: 'auto' });
  if (![1, 0.5, 0.25].includes(strength) || !Number.isInteger(before.sampleRate) || before.sampleRate < 8000 ||
    before.sampleRate > 192000 || ![1, 2].includes(before.channels)) throw new Error('長尺の仕上がり調整が不正です。');
  const rate = before.sampleRate, count = before.channels;
  const appliedControls = { ...controls };
  const explanations: string[] = [], skipped: string[] = [], stages: TonalStage[] = [];
  const amount = (key: keyof FinishControls) => controls[key] / 3 * strength;
  function eq(hz: number, gain: number, band?: TonalStage['band'], threshold?: number, minimum?: number) {
    const coefficients = peakingCoefficients(rate, Math.min(hz, rate * 0.4), gain, 0.7);
    stages.push({ filter: Array.from({ length: count }, () => createBiquad(coefficients)), band, threshold, minimum, wet: 1 });
  }
  if (controls.vocal) {
    eq(2600, 1.8 * amount('vocal'), 'high', 0.3, 0.45);
    eq(450, -0.6 * amount('vocal'));
    explanations.push('声の存在感を支える帯域を整えました。');
  }
  if (controls.bass) {
    eq(95, 2 * amount('bass'), 'bass', 0.55, 0.35);
    explanations.push('低音の量を見ながら厚みを加えました。');
  }
  if (controls.clarity) {
    eq(6500, 1.6 * amount('clarity'), 'high', 0.35, 0.35);
    explanations.push('高域の量を見ながら明るさと輪郭を加えました。');
  }
  if (controls.warmth) {
    eq(220, 1.4 * amount('warmth'), 'lowMid', 0.35, 0.4);
    explanations.push('低中域の量を見ながら暖かさを加えました。');
  }
  const stableStereo = count === 2 && (before.stereoCorrelation ?? 0) >= 0.25 &&
    (before.sideEnergyPercent ?? 0) > 0.001 && (before.sideEnergyPercent ?? 0) <= 30;
  const width = controls.width && stableStereo ? 1 + 0.06 * amount('width') : 1;
  if (controls.width) {
    if (width > 1) explanations.push('低音を中央に保ちながら上の帯域の広がりを加えました。');
    else { appliedControls.width = 0; skipped.push('元の広がりとステレオの安定性を考慮し、幅の追加を見送りました。'); }
  }
  const crest = before.crestFactorDb ?? 0;
  const density = crest >= 6 ? controls.density : 0;
  const compressionDb = 1.2 * density / 3 * strength;
  const punchDb = crest >= 4 ? amount('punch') : 0;
  if (controls.density && !density) {
    appliedControls.density = 0; skipped.push('すでに密度が高いため、追加の圧縮を見送りました。');
  }
  if (controls.punch && !punchDb) {
    appliedControls.punch = 0; skipped.push('強弱の余裕が小さいため、立ち上がりの追加を見送りました。');
  }
  if (compressionDb) explanations.push('強弱を抑えすぎない範囲で密度を加えました。');
  if (punchDb) explanations.push('音の立ち上がりを強調しました。');
  const applied = stages.length > 0 || width > 1 || compressionDb > 0 || punchDb > 0;

  // Complementary one-pole bands supply a local, smoothed estimate of spectral excess.
  const lows = new Float64Array(count), lowMids = new Float64Array(count), bodies = new Float64Array(count);
  const bands = { bass: 0, lowMid: 0, body: 0, high: 0 };
  const lowC = 1 - Math.exp(-2 * Math.PI * 180 / rate), lowMidC = 1 - Math.exp(-2 * Math.PI * 400 / rate);
  const bodyC = 1 - Math.exp(-2 * Math.PI * Math.min(2500, rate * 0.3) / rate);
  const energyC = 1 - Math.exp(-1 / (rate * 0.08)), wetC = 1 - Math.exp(-1 / (rate * 0.05));
  const widthC = 1 - Math.exp(-2 * Math.PI * 220 / rate);
  const fastC = 1 - Math.exp(-1 / (rate * 0.004)), slowC = 1 - Math.exp(-1 / (rate * 0.06));
  const attackC = 1 - Math.exp(-1 / (rate * 0.015)), releaseC = 1 - Math.exp(-1 / (rate * 0.1));
  const referenceRms = Math.max(1e-8, 10 ** ((before.rmsDbfs ?? -160) / 20));
  let lowSide = 0, fast = 0, slow = 0, gainDb = 0;

  return {
    explanations, skipped, appliedControls, applied, density,
    processOwned(audio: AudioData) {
      const frames = audio.channels[0]?.length ?? 0;
      if (audio.sampleRate !== rate || audio.channels.length !== count || !frames ||
        audio.channels.some(channel => !(channel instanceof Float32Array) || channel.length !== frames))
        throw new Error('長尺の仕上がり調整中に音声形式が変わりました。');
      for (let i = 0; i < frames; i++) {
        let bassPower = 0, lowMidPower = 0, bodyPower = 0, highPower = 0;
        for (let c = 0; c < count; c++) {
          const value = audio.channels[c][i];
          if (!Number.isFinite(value) || Math.abs(value) > 32) throw new Error('音声に不正なサンプル値があります。');
          if (!applied) continue;
          lows[c] += lowC * (value - lows[c]); lowMids[c] += lowMidC * (value - lowMids[c]);
          bodies[c] += bodyC * (value - bodies[c]);
          bassPower += lows[c] ** 2; lowMidPower += (lowMids[c] - lows[c]) ** 2;
          bodyPower += (bodies[c] - lowMids[c]) ** 2; highPower += (value - bodies[c]) ** 2;
        }
        if (!applied) continue;
        bands.bass += energyC * (bassPower - bands.bass); bands.lowMid += energyC * (lowMidPower - bands.lowMid);
        bands.body += energyC * (bodyPower - bands.body); bands.high += energyC * (highPower - bands.high);
        const total = Math.max(1e-20, bands.bass + bands.lowMid + bands.body + bands.high);
        for (const stage of stages) {
          const wet = stage.band ? 1 - (1 - stage.minimum!) * clamp((bands[stage.band] / total - stage.threshold! + 0.05) / 0.1) : 1;
          stage.wet += wetC * (wet - stage.wet);
          for (let c = 0; c < count; c++) {
            const value = audio.channels[c][i];
            audio.channels[c][i] = value + stage.wet * (stage.filter[c](value) - value);
          }
        }
        if (width > 1) {
          const mid = (audio.channels[0][i] + audio.channels[1][i]) / 2;
          const side = (audio.channels[0][i] - audio.channels[1][i]) / 2;
          lowSide += widthC * (side - lowSide);
          const adjusted = lowSide + (side - lowSide) * width;
          audio.channels[0][i] = mid + adjusted; audio.channels[1][i] = mid - adjusted;
        }
        if (compressionDb || punchDb) {
          let level = 0;
          for (const channel of audio.channels) level = Math.max(level, Math.abs(channel[i]));
          fast += fastC * (level - fast); slow += slowC * (level - slow);
          const over = Math.max(0, 20 * Math.log10(Math.max(slow, 1e-12) / referenceRms) - 3);
          const target = -Math.min(compressionDb, over * 0.35);
          gainDb += (target < gainDb ? attackC : releaseC) * (target - gainDb);
          const punch = punchDb * clamp((fast - slow) / Math.max(slow, referenceRms * 0.5));
          const gain = 10 ** ((gainDb + punch) / 20);
          for (const channel of audio.channels) channel[i] *= gain;
        }
      }
    },
  };
}
