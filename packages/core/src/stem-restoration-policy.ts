import type { StemMixReport } from './stems.js';
import type { RepairControls } from './studio-settings.js';
import type { GrainRestorationReport } from './grain-restoration.js';

/** Older reports without overrides follow the existing finishing path.
 * An explicit material OFF also protects the summed bus; repeatGrain is the
 * deliberate whole-mix grain/treble override, still subject to normal quality gates.
 */
export function resolveStemGrainRestoration(report?: StemMixReport, selection?: RepairControls) {
  const controls = selection ? { ...selection } : undefined;
  if (controls?.repeatGrain !== undefined && typeof controls.repeatGrain !== 'boolean')
    throw new Error('追加のざらつき補修の指定が不正です。');
  if (controls?.grain !== undefined && !['off','light','standard','strong'].includes(controls.grain))
    throw new Error('ざらつき除去のモードが不正です。');
  const applied = new Set<string>();
  const protectedMaterials = new Set<string>();
  if (report?.version === 1 && Array.isArray(report.tracks) && Array.isArray(report.plan?.tracks)) {
    for (const track of report.tracks) {
      const descriptor = report.plan.tracks.find(item => item.id === track.descriptor.id);
      const grain = track.restoration?.grain;
      if (descriptor && !descriptor.muted && !track.descriptor.muted &&
        (descriptor.restorationEnabled === false || track.descriptor.restorationEnabled === false))
        protectedMaterials.add(descriptor.id);
      if (descriptor && !descriptor.muted && !track.descriptor.muted && grain?.status === 'applied' &&
        Number.isFinite(grain.seconds) && grain.seconds > 0) applied.add(descriptor.id);
    }
  }
  const protectedTracks = protectedMaterials.size;
  const suppressTreble = protectedTracks > 0 && !controls?.repeatGrain;
  const preservationExplanation = suppressTreble ? protectedTracks + '素材の補修OFFを尊重し、全体へのざらつき・高域補修を見送りました。' : undefined;
  if (suppressTreble) {
    const report: GrainRestorationReport | undefined = controls?.grain && controls.grain !== 'off' && controls.amount !== 0 ? {
      mode:controls.grain,status:'skipped',seconds:0,estimatedResidualReductionDb:0,rmsChangeDb:0,
      explanation:preservationExplanation!,reasons:[],
    } : undefined;
    return {controls:{...controls,grain:'off' as const},appliedTracks:applied.size,report,protectedTracks,suppressTreble,preservationExplanation};
  }
  if (!applied.size || controls?.repeatGrain || !controls?.grain || controls.grain === 'off' || controls.amount === 0)
    return { controls, appliedTracks: applied.size, report: undefined,protectedTracks,suppressTreble,preservationExplanation };
  if (!['light', 'standard', 'strong'].includes(controls.grain))
    throw new Error('ざらつき除去のモードが不正です。');
  const decision: GrainRestorationReport = { inheritedTracks:applied.size,mode:controls.grain,status:'skipped',seconds:0,estimatedResidualReductionDb:0,rmsChangeDb:0,
    explanation: applied.size + '素材にジャリつき補修を採用済みのため、全体への重ね掛けを見送りました。',reasons:[] };
  return { controls: { ...controls, grain:'off' as const }, appliedTracks:applied.size, report:decision,protectedTracks,suppressTreble,preservationExplanation };
}
