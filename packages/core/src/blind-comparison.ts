import type { AnalysisResult } from '@music-sync/shared';
import { createComparisonPlan } from './comparison.js';

/** Presentation adapter for a future blind UI. The controller keeps mapping private
 * until reveal. Swap comes from the host's randomization; this function is pure. */
export function createBlindComparison(a:AnalysisResult,b:AnalysisResult,swap:boolean){
  const comparison=createComparisonPlan(a,b);
  if(!comparison.match.available)throw new Error('Blind comparison requires measurable loudness matching');
  return {labels:['X','Y'] as const, mapping:swap?{X:'b' as const,Y:'a' as const}:{X:'a' as const,Y:'b' as const},
    gainsDb:comparison.match.gainsDb,durationSeconds:comparison.durationSeconds,matched:true as const};
}
