import type { PerceptualFeatures, PerceptualBand } from '@music-sync/audio-analysis';
import type { MixStage } from '@music-sync/dsp';
import type { MixCorrectionPlan } from './mix-planner.js';
import { planLiveSound } from './live-strategy.js';

export type IssueId = 'lowEndBuildup' | 'muddiness' | 'boxiness' | 'harshness' | 'brightness' | 'dullness' | 'lowDynamics' | 'highDynamics' | 'lowSpread' | 'phaseRisk';
export interface DetectedIssue { issue: IssueId; severity:number; confidence:number; evidence:string[]; temporal:'persistent'|'intermittent'; band:PerceptualBand }
export interface ProcessingDecision { stage:MixStage['kind']; targetIssue:IssueId; reason:string; metricBefore:number }
export interface PerceptualDecisionReport { detectedIssues:DetectedIssue[]; decisions:ProcessingDecision[]; skippedProcessing:string[] }
const clamp=(x:number)=>Math.max(0,Math.min(1,x));
const bandFor:Record<IssueId,PerceptualBand>={lowEndBuildup:'low',muddiness:'lowMid',boxiness:'mid',harshness:'presence',brightness:'high',dullness:'high',lowDynamics:'low',highDynamics:'high',lowSpread:'low',phaseRisk:'low'};
/** Evidence is deliberately descriptive and testable, not semantic vocal detection. */
export function detectPerceptualProblems(p:PerceptualFeatures):DetectedIssue[]{
  const result:DetectedIssue[]=[];
  for(const issue of ['lowEndBuildup','muddiness','boxiness','harshness','brightness','dullness'] as const){
    const band=bandFor[issue],stats=p.bands[band],feature=p.features[issue];
    const intermittent=stats.excessFraction>0.06&&stats.excessFraction<0.6&&stats.p90-stats.p50>0.15;
    // Transient excess needs both temporal contrast and elevated spectral occupancy.
    const temporalSeverity=issue!=='dullness'&&intermittent?clamp((stats.p90-stats.p50-0.1)*1.5):0;
    const severity=Math.max(feature.value,temporalSeverity);
    if(severity>0.08)result.push({issue,severity,confidence:feature.confidence,band,temporal:intermittent?'intermittent':'persistent',
      evidence:[`feature=${feature.value.toFixed(3)}`,`band p50/p90=${stats.p50}/${stats.p90}`,`excess occupancy=${stats.excessFraction.toFixed(3)}`,`centroid=${p.centroidHz.toFixed(0)} Hz; rolloff=${p.rolloffHz.toFixed(0)} Hz`]});
  }
  for(const [issue,band] of [['lowDynamics','low'],['highDynamics','high']] as const){
    const b=p.bands[band],other=band==='low'?p.bands.mid:p.bands.low;
    const severity=clamp((b.rangeDb-other.rangeDb-6)/20)*clamp((b.p90-b.p50)*4);
    if(severity>0.08)result.push({issue,band,severity,confidence:p.confidence,temporal:'intermittent',evidence:[`band range=${b.rangeDb.toFixed(1)} dB`, `reference range=${other.rangeDb.toFixed(1)} dB`,`ratio spread=${(b.p90-b.p50).toFixed(2)}`]});
  }
  if(p.lowSideRatio>0.3&&p.sideRatio>0.15)result.push({issue:'lowSpread',band:'low',severity:clamp((p.lowSideRatio-0.3)/0.5),confidence:p.confidence,temporal:'persistent',evidence:[`low side=${p.lowSideRatio.toFixed(3)}`,`total side=${p.sideRatio.toFixed(3)}`]});
  if(p.correlation<0.1&&p.features.stereoInstability.value>0.1)result.push({issue:'phaseRisk',band:'low',severity:p.features.stereoInstability.value,confidence:p.confidence,temporal:'persistent',evidence:[`correlation=${p.correlation.toFixed(3)}`,`negative windows=${p.features.stereoInstability.value.toFixed(3)}`]});
  return result;
}
export function issueMetric(p:PerceptualFeatures,issue:IssueId,temporal:'persistent'|'intermittent'='persistent'):number{
  if(issue==='lowSpread')return p.lowSideRatio;
  if(issue==='phaseRisk')return p.features.stereoInstability.value;
  if(issue==='lowDynamics'||issue==='highDynamics')return p.bands[bandFor[issue]].rangeDb/60;
  if(temporal==='intermittent')return p.bands[bandFor[issue]].p90;
  return p.features[issue].value;
}
export function refinePerceptualPlan(plan:MixCorrectionPlan,p:PerceptualFeatures,sampleRate:number):PerceptualDecisionReport {
  const detectedIssues=detectPerceptualProblems(p),decisions:ProcessingDecision[]=[],skippedProcessing:string[]=[];
  const legacyDynamics=plan.stages.find(s=>s.kind==='dynamics');
  plan.stages=plan.stages.filter(s=>s.kind==='dc'||s.kind==='balance'||s.kind==='live');
  plan.explanations=plan.explanations.filter(x=>x.includes('DC')||x.includes('左右')||x.includes('会場')||x.includes('初期反射'));
  const live=plan.stages.find(s=>s.kind==='live');
  if(live?.kind==='live'){
    const ambience=p.features.ambience;
    // A sustained note is not reliable reverb evidence. Prefer the newer
    // temporal estimate when it confidently describes dry, stable material.
    if(!plan.liveSelection&&p.ambienceClass==='Dry'&&ambience.confidence>=0.55&&!plan.problems.wide&&!plan.problems.unstableStereo) {
      live.parameters=planLiveSound({...plan.problems,spaceRisk:false},plan.strength);
      plan.explanations=plan.explanations.filter(x=>!x.includes('会場')&&!x.includes('初期反射'));
      plan.explanations.push('原音の手前感を残して、初期反射と小ホールの会場感・奥行きを加えました。');
    }
    const factor=plan.liveSelection
      ? p.ambienceClass==='Wet'&&ambience.confidence>=0.55?0.55:p.ambienceClass==='Moderate'||ambience.confidence<0.4?0.85:1
      : ambience.confidence<0.4?0.45:p.ambienceClass==='Wet'?0.15:p.ambienceClass==='Moderate'?0.5:1;
    live.parameters.wet*=factor;
    if(p.ambienceClass==='Wet'&&!plan.liveSelection) {
      live.parameters.venue='intimate-room';
      live.parameters.decaySeconds=Math.min(0.5,live.parameters.decaySeconds);
      plan.explanations=plan.explanations.filter(x=>!x.includes('小ホール'));
      plan.explanations.push('元音源の響きを考慮し、短い部屋の会場感だけを加えました。');
    }
    if(plan.liveSelection&&p.ambienceClass==='Wet'&&ambience.confidence>=0.55)live.parameters.decaySeconds*=0.8;
    if(factor<1)plan.explanations.push('空間成分の推定を考慮し、追加する会場感を少なくしました。');
  }
  const priority=(i:DetectedIssue)=>i.severity*i.confidence+(i.issue.endsWith('Dynamics')?0.01:0);
  const eligible=detectedIssues.filter(i=>i.severity>=0.28&&i.confidence>=0.55&&i.severity*i.confidence>=0.18).sort((a,b)=>priority(b)-priority(a));
  for(const issue of detectedIssues)if(!eligible.includes(issue))skippedProcessing.push(`${issue.issue}: mild issue or insufficient confidence (${issue.severity.toFixed(2)} / ${issue.confidence.toFixed(2)})`);
  const usedBands=new Set<PerceptualBand>(); let correctionBudget = 3;
  for(const issue of eligible){
    if(decisions.length>=3||usedBands.has(issue.band)){skippedProcessing.push(`${issue.issue}: correction budget / overlapping band`);continue;}
    let stage:MixStage,explanation:string;
    const amount=Math.min(correctionBudget, Math.min(1.8,2*issue.severity*issue.confidence)*plan.strength);
    if(amount<0.25){skippedProcessing.push(`${issue.issue}: predicted change too small`);continue;}
    if(issue.issue==='lowSpread'){stage={kind:'bass-center',amount:1-Math.min(0.25,amount*0.12),crossoverHz:150};explanation='低音の左右への広がりを軽く整理しました。';}
    else if(issue.issue==='phaseRisk'){stage={kind:'width',amount:1-Math.min(0.2,amount*0.1),crossoverHz:180};explanation='位相の不安定さを抑えるため、広がりを控えめに整えました。';}
    else if(issue.issue==='lowDynamics'||issue.issue==='highDynamics'){
      const index=issue.issue==='lowDynamics'?0:2;
      stage={kind:'multiband',parameters:{lowHz:180,highHz:Math.min(3500,sampleRate*0.4),attackMs:15,releaseMs:120,bands:[0,1,2].map(b=>({thresholdDb:Math.max(-80,p.bands[issue.band].rmsDb+3),maxReductionDb:b===index?Math.min(1.2,amount):0}))}};
      explanation=index===0?'大きく膨らむ低音だけを軽く制御しました。':'高音の瞬間的な強さだけを軽く制御しました。';
    }else{
      const frequencies={lowEndBuildup:110,muddiness:280,boxiness:650,harshness:3200,brightness:7500,dullness:6500};
      const frequencyHz=Math.min(frequencies[issue.issue],sampleRate*0.4);
      if(issue.temporal==='intermittent'&&issue.issue!=='dullness'){
        stage={kind:'dynamic-eq',bands:[{frequencyHz,q:0.8,thresholdDb:Math.max(-80,p.bands[issue.band].rmsDb+2),maxReductionDb:amount,attackMs:8,releaseMs:120}]};
        explanation=issue.issue==='harshness'||issue.issue==='brightness'?'刺さりやすい高域を必要な部分だけ抑えました。':'膨らみやすい帯域を必要な部分だけ抑えました。';
      }else{
        stage={kind:'eq',frequencyHz,q:0.7,gainDb:issue.issue==='dullness'?Math.min(0.7,amount):-amount};
        explanation=issue.issue==='dullness'?'高域の明瞭さを控えめに補いました。':issue.issue==='muddiness'||issue.issue==='boxiness'?'低中域の濁りを軽く整理しました。':'偏りが続く帯域を控えめに整えました。';
      }
    }
    plan.stages.unshift(stage);usedBands.add(issue.band); correctionBudget -= amount;
    decisions.push({stage:stage.kind,targetIssue:issue.issue,reason:issue.evidence.join('; '),metricBefore:issueMetric(p,issue.issue,issue.temporal)});plan.explanations.push(explanation);
  }
  // IMPACT is not an instruction to boost every transient. Preserve already strong/dense attacks.
  if(legacyDynamics?.kind==='dynamics'&&plan.mode==='IMPACT'&&p.features.punch.value<0.65&&p.features.dynamicDensity.value<0.65&&p.confidence>=0.55){
    plan.stages.push({...legacyDynamics,compressionDb:0,punchDb:Math.min(0.8,legacyDynamics.punchDb)});plan.explanations.push('アタックの余裕を確認し、立ち上がりを少し補いました。');
  }else{skippedProcessing.push('Transient emphasis / broadband compression: no sufficiently confident need');plan.explanations.push('追加のアタック強調・全体圧縮は見送りました。');}
  if(!plan.stages.some(s=>s.kind==='width'||s.kind==='bass-center')){skippedProcessing.push('Stereo: preserve original width; no automatic widening');plan.explanations.push(live ? '原音のステレオ幅は広げず、会場の響きだけ左右に分散しました。' : 'ステレオ幅は原音のまま保ちました。');}
  if(!decisions.length)plan.explanations.push('確かな補正根拠が少ないため、追加の音色補正は見送りました。');
  return {detectedIssues,decisions,skippedProcessing};
}
