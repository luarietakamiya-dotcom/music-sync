import { defaultProcessingChain, type ProcessingChain } from '@music-sync/dsp';
import type { AnalysisResult } from '@music-sync/shared';
import { AUTO_MODES, type AutoMode } from './mix-planner.js';

import { liftAllowance } from '../studio-settings.js';

export interface AutoMasteringPlan { desiredLufs: number; effectiveLufs: number; chain: ProcessingChain }
export function planAutoMastering(original: AnalysisResult, intermediate: AnalysisResult, mode: AutoMode, strength: number, aggression = 35): AutoMasteringPlan {
  const config = AUTO_MODES[mode], inputLufs = original.integratedLufs!;
  const baseTarget = mode === 'AUTO' && inputLufs >= -18 && inputLufs <= -14 ? inputLufs : config.targetLufs;
  const desiredLufs = baseTarget + Math.max(0, aggression - 35) / 65 * 2;
  const change = Math.max(-12, Math.min(liftAllowance(config.maxLiftLu, aggression), desiredLufs - inputLufs)) * strength;
  const effectiveLufs = inputLufs + change;
  const chain = defaultProcessingChain();
  chain.gainDb = Math.max(-24, Math.min(12, effectiveLufs - intermediate.integratedLufs!));
  chain.limiter.ceilingDb = -1; chain.limiter.releaseMs = mode === 'LIVE' ? 120 : 80;
  if (Math.abs(chain.gainDb) < 0.05 && Math.max(intermediate.samplePeakDbfs ?? Infinity, intermediate.truePeakDbtp ?? Infinity) <= -1) {
    chain.bypass = true; chain.gainDb = 0;
  }
  return { desiredLufs, effectiveLufs, chain };
}
