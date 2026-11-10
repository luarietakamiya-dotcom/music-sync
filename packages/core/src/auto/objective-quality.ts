import type { PerceptualFeatures } from '@music-sync/audio-analysis';
import { issueMetric, type PerceptualDecisionReport } from './perceptual-decisions.js';

export interface ObjectiveEvaluation { accepted:boolean; reasons:string[]; objectives:{issue:string; before:number; after:number; improved:boolean}[] }
export function evaluatePerceptualQuality(before:PerceptualFeatures,after:PerceptualFeatures,plan:PerceptualDecisionReport):ObjectiveEvaluation{
  const reasons:string[]=[],objectives:ObjectiveEvaluation['objectives']=[];
  const measuredValues = [after.confidence, after.centroidHz, after.rolloffHz, after.flux, after.crestDb, after.lowSideRatio, after.sideRatio, after.correlation,
    ...Object.values(after.bands).flatMap(b => Object.values(b)), ...Object.values(after.features).flatMap(f => [f.value, f.confidence])];
  if (!measuredValues.every(Number.isFinite)) reasons.push('聴感特徴の測定値が不正です。');
  for(const decision of plan.decisions){
    const detected=plan.detectedIssues.find(i=>i.issue===decision.targetIssue)!;
    const a=issueMetric(before,decision.targetIssue,detected.temporal),b=issueMetric(after,decision.targetIssue,detected.temporal);
    const improved=Number.isFinite(b)&&b<=a-Math.max(0.001,a*0.005);
    objectives.push({issue:decision.targetIssue,before:a,after:b,improved});
    if(!improved)reasons.push(`${decision.targetIssue}: 狙った補正の効果を確認できません。`);
  }
  for(const key of ['muddiness','harshness','brightness','dullness','masking','stereoInstability'] as const){
    if(!Number.isFinite(after.features[key].value)||Math.min(before.features[key].confidence,after.features[key].confidence)>=0.55&&after.features[key].value>before.features[key].value+0.08)reasons.push(`${key}: 聴感特徴の悪化を検出しました。`);
  }
  if(after.lowSideRatio>before.lowSideRatio+0.06)reasons.push('低音のSide成分が増えました。');
  if(before.features.presence.confidence>=0.55&&before.features.presence.value>0.3&&after.features.presence.value<before.features.presence.value*0.8)reasons.push('明瞭度を支える帯域が後退しました。');
  return {accepted:!reasons.length,reasons,objectives};
}
