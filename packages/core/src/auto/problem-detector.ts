import type { AnalysisResult } from '@music-sync/shared';
import type { AdaptiveFeatures } from '@music-sync/audio-analysis';

export interface AudioProblems {
  bassExcess: boolean; muddy: boolean; harsh: boolean; presenceDeficit: boolean;
  dense: boolean; unstableStereo: boolean; wide: boolean; centerFocused: boolean;
  spaceRisk: boolean; dc: boolean; imbalance: boolean;
}
/** Heuristics are conservative mix descriptors, never vocal/reverb classifiers. */
export function detectProblems(report: AnalysisResult, features: AdaptiveFeatures): AudioProblems {
  const b = features.bandEnergy;
  return { bassExcess: b.bass > 0.55, muddy: b.lowMid > 0.48 && b.bass > 0.1,
    harsh: b.highMid + b.air > 0.5, presenceDeficit: b.presence < 0.1 && b.bass < 0.55 && b.air < 0.3,
    dense: (report.crestFactorDb ?? 0) < 6 || features.dynamicRangeDb < 2,
    unstableStereo: features.negativeCorrelationFraction > 0.15 || (report.stereoCorrelation ?? 1) < 0,
    wide: (report.sideEnergyPercent ?? 0) > 30,
    centerFocused: (report.sideEnergyPercent ?? 0) < 12 && b.presence > 0.2,
    spaceRisk: features.sustainRatio > 0.72 || (report.sideEnergyPercent ?? 0) > 30,
    dc: report.dcOffset.some(x => Math.abs(x) > 0.002),
    imbalance: report.channels === 2 && Math.abs(features.channelBalanceDb) > 3 };
}
