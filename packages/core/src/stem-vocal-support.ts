import type { StemClarityFeatures } from './stem-clarity.js';

export interface StemVocalSupportPlan {
  gainDb: Float32Array;
  seconds: number;
  maxGainDb: number;
}

/** A short, weak island inside an otherwise healthy sung phrase may need support.
 * This conservative spectral/activity heuristic is not a vocal or breath detector.
 * Missing optional body-band evidence retains the previous exact no-support path.
 */
export function planStemVocalSupport(lead: StemClarityFeatures, relativePresenceDb: Float32Array,
  options: { signal?: AbortSignal } = {}): StemVocalSupportPlan {
  options.signal?.throwIfAborted();
  if (!lead || !Number.isInteger(lead.sampleRate) || lead.sampleRate < 8000 || lead.sampleRate > 192000 ||
    ![1, 2].includes(lead.channels) || !Number.isInteger(lead.frames) || lead.frames < 1 || lead.frames > lead.sampleRate * 1200 ||
    lead.windowFrames !== Math.round(lead.sampleRate * 0.05)) throw new Error('ボーカル補助の解析形式が不正です。');
  const count = Math.ceil(lead.frames / lead.windowFrames);
  for (const values of [lead.bodyRms, lead.presenceEnergy, lead.lowEnergy])
    if (!(values instanceof Float32Array) || values.length !== count || values.some((value: number) => !Number.isFinite(value) || value < 0))
      throw new Error('ボーカル補助の解析値が不正です。');
  if (!(lead.attack instanceof Uint8Array) || lead.attack.length !== count || lead.attack.some((value: number) => value > 1) ||
    !(relativePresenceDb instanceof Float32Array) || relativePresenceDb.length !== count || relativePresenceDb.some(value => !Number.isFinite(value)) ||
    (lead.clippedSamples !== undefined && (!Number.isInteger(lead.clippedSamples) || lead.clippedSamples < 0 || lead.clippedSamples > lead.frames * lead.channels)))
    throw new Error('ボーカル補助の時間軸が不正です。');
  const result: StemVocalSupportPlan = { gainDb: new Float32Array(count), seconds: 0, maxGainDb: 0 };
  const bodyEnergy = lead.bodyEnergy;
  if (bodyEnergy !== undefined && (!(bodyEnergy instanceof Float32Array) || bodyEnergy.length !== count ||
    bodyEnergy.some((value: number) => !Number.isFinite(value) || value < 0))) throw new Error('ボーカルの胴体帯域の解析値が不正です。');
  if (!bodyEnergy || lead.clippedSamples) return result;

  const quantile = (values: number[], fraction: number) => {
    if (!values.length) return 0;
    values.sort((a, b) => a - b);
    return values[Math.floor((values.length - 1) * fraction)];
  };
  const activeRms = Array.from(lead.bodyRms).filter(value => value > 1e-5);
  const activity = Math.max(1e-5, quantile(activeRms, 0.8) * 0.08);
  const confident = new Uint8Array(count), reference = new Float32Array(count), weak = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    options.signal?.throwIfAborted();
    const rms = lead.bodyRms[i], body = bodyEnergy[i], presence = lead.presenceEnergy[i];
    // Reject low-level tails and material dominated by high-band noise/sibilance.
    if (rms >= activity && body >= rms * rms * 0.2 && body <= rms * rms * 1.5 &&
      presence > 1e-12 && presence / Math.max(body, 1e-20) <= 3) confident[i] = 1;
  }
  // Fixed-size neighbourhoods keep work/memory bounded for a twenty-minute input.
  const radius = Math.max(1, Math.round(lead.sampleRate / lead.windowFrames));
  for (let i = 0; i < count; i++) {
    options.signal?.throwIfAborted();
    if (!confident[i] || lead.attack[i] || relativePresenceDb[i] > -4) continue;
    const nearby: number[] = [];
    for (let n = Math.max(0, i - radius); n <= Math.min(count - 1, i + radius); n++)
      if (n !== i && confident[n]) nearby.push(lead.bodyRms[n]);
    const healthy = quantile(nearby, 0.7);
    if (!healthy) continue;
    const drop = 20 * Math.log10(healthy / lead.bodyRms[i]);
    if (drop >= 3 && drop <= 10) { weak[i] = 1; reference[i] = healthy; }
  }

  const minimum = Math.ceil(0.15 * lead.sampleRate / lead.windowFrames);
  const maximum = Math.floor(0.8 * lead.sampleRate / lead.windowFrames);
  const anchorLength = Math.ceil(0.15 * lead.sampleRate / lead.windowFrames);
  function anchors(start: number, end: number, target: number): number[] | undefined {
    if (start < 0 || end > count) return;
    const selected: number[] = [];
    for (let i = start; i < end; i++) {
      if (!confident[i] || lead.bodyRms[i] < target * 0.8) return;
      selected.push(i);
    }
    return selected;
  }
  for (let start = 0; start < count;) {
    options.signal?.throwIfAborted();
    if (!weak[start]) { start++; continue; }
    let end = start + 1;
    while (end < count && weak[end]) end++;
    if (end - start >= minimum && end - start <= maximum) {
      const target = quantile(Array.from(reference.subarray(start, end)), 0.5);
      let before: number[] | undefined, after: number[] | undefined;
      // Allow at most 100 ms of naturally transitioning syllable volume at either edge.
      for (let gap = 0; gap <= 2 && !before; gap++) before = anchors(start - gap - anchorLength, start - gap, target);
      for (let gap = 0; gap <= 2 && !after; gap++) after = anchors(end + gap, end + gap + anchorLength, target);
      if (before && after) {
        const healthy = [...before, ...after];
        const spectral = quantile(healthy.map(i => lead.presenceEnergy[i] / Math.max(bodyEnergy[i], 1e-20)), 0.5);
        const stableAnchors = Math.abs(20 * Math.log10(quantile(before.map(i => lead.bodyRms[i]), 0.5) /
          quantile(after.map(i => lead.bodyRms[i]), 0.5))) <= 3;
        const stableIsland = Array.from({ length: end - start }, (_, n) => start + n).every(i => {
          const ratio = lead.presenceEnergy[i] / Math.max(bodyEnergy[i], 1e-20);
          return ratio >= spectral * 0.5 && ratio <= spectral * 2;
        });
        if (stableAnchors && stableIsland) for (let i = start; i < end; i++) {
          const drop = 20 * Math.log10(reference[i] / lead.bodyRms[i]);
          const gain = Math.min(1.5, Math.max(0, (drop - 2) * 0.4));
          result.gainDb[i] = gain;
          result.maxGainDb = Math.max(result.maxGainDb, gain);
          result.seconds += Math.min(lead.windowFrames, lead.frames - i * lead.windowFrames) / lead.sampleRate;
        }
      }
    }
    start = end;
  }
  return result;
}
