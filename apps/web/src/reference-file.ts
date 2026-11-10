import {StreamingAudioAnalyzer,checkLongCandidate,floatWavHeader,writeFloatSamples,planReferenceCorrection,evaluateReferenceQuality,validateReferenceSelection,
  type AnalysisResult,type ReferenceResult,type ReferenceSelection} from '@music-sync/core';
import {PerceptualAnalyzer} from '@music-sync/audio-analysis';
import {createReferenceProcessor} from '@music-sync/dsp';
import {CandidateFile} from './candidate-file';
import {readWavFileMetadata,streamWavChunks,LONG_WAV_LIMITS} from './wav-stream';

/** Optional reference tone/density on an already accepted, file-backed B.
 * Scratch is worker-owned and leased. The caller owns destination and Original. */
export async function finishReferenceFile(base:{file:File;analysis:AnalysisResult;original:AnalysisResult},selection:ReferenceSelection,destination:FileSystemFileHandle,
  progress:(fraction:number,text:string)=>void=()=>{}):Promise<{file:File;analysis:AnalysisResult;reference:Omit<ReferenceResult,'processed'>}>{
  validateReferenceSelection(selection);
  const info=await readWavFileMetadata(base.file),before=base.analysis;
  if(info.sampleRate!==before.sampleRate||info.channels!==before.channels||info.frames!==before.frames||
    base.original.sampleRate!==info.sampleRate||base.original.channels!==info.channels||base.original.frames!==info.frames)
    throw new Error('原音とリファレンス補正候補の形式が一致しません。');
  if(56+info.frames*info.channels*4>LONG_WAV_LIMITS.maxFileBytes)throw new Error('リファレンス補正後のWAVは512 MiB以内にしてください。');
  const report:Omit<ReferenceResult,'processed'>={version:1,status:'skipped',selection:structuredClone(selection),before,attempts:[],explanations:[],reasons:[]};
  const preserve=()=>({file:base.file,analysis:before,reference:report});
  if(info.sampleRate<24000||!selection.strength){
    report.explanations=[info.sampleRate<24000?'24 kHz未満の音源では比較する帯域が足りないため、お手本への補正を見送りました。':'お手本の適用量が0のため、仕上がった候補をそのまま保ちました。'];
    progress(1,'お手本への追加補正を見送りました');return preserve();
  }
  if(before.integratedLufs===null||before.clippedSamples){report.explanations=['仕上がりの音量またはピークを比較できないため、お手本への補正を見送りました。'];progress(1,'お手本への追加補正を見送りました');return preserve();}
  const perceptual=new PerceptualAnalyzer(info.sampleRate,info.channels);let frames=0;
  for await(const chunk of streamWavChunks(base.file,info)){
    perceptual.push(chunk.channels);frames+=chunk.channels[0].length;progress(.12*frames/info.frames,'仕上がりとお手本の傾向を比較しています');
  }
  const features=perceptual.finish(),target=before.integratedLufs;
  for(let iteration=0;iteration<3;iteration++){
    const plan=planReferenceCorrection(before,features,selection.profile,selection.strength*[1,.5,.25][iteration]);
    if(!plan.bands.length&&!plan.density){
      report.status=report.attempts.length?'rejected':'skipped';
      report.explanations=report.attempts.length?['補正量を弱めると有効な変更が残らなかったため、お手本への補正は採用せず元の候補を保ちました。']:plan.skipped;
      progress(1,'安全に仕上がった候補を保ちました');return preserve();
    }
    const fraction=(pass:number,amount:number)=>.12+.86*(iteration+(pass+amount)/3)/3;
    const intermediate=new StreamingAudioAnalyzer(info.sampleRate,info.channels,info.frames),measure=createReferenceProcessor(plan,info.sampleRate,info.channels);
    frames=0;
    for await(const chunk of streamWavChunks(base.file,info)){
      measure(chunk);intermediate.push(chunk);frames+=chunk.channels[0].length;
      progress(fraction(0,frames/info.frames),'お手本に合わせた補正量とピークを調べています');
    }
    const middle=intermediate.finish();
    if(middle.integratedLufs===null||middle.truePeakDbtp===null||middle.samplePeakDbfs===null)throw new Error('お手本への補正後の音量を測定できません。');
    // Preserve BASE's achieved loudness. Do not lift towards an unreachable output/ref target.
    const gainDb=Math.max(-24,Math.min(6,target-middle.integratedLufs,-1.001-Math.max(middle.truePeakDbtp,middle.samplePeakDbfs))),gain=10**(gainDb/20);
    const scratch=new CandidateFile();
    try{
      const handle=await scratch.handle,writer=await handle.createWritable(),render=createReferenceProcessor(plan,info.sampleRate,info.channels);
      try{
        await writer.write(floatWavHeader(info.sampleRate,info.channels,info.frames));frames=0;
        for await(const chunk of streamWavChunks(base.file,info)){
          render(chunk);for(const channel of chunk.channels)for(let n=0;n<channel.length;n++)channel[n]*=gain;
          const buffer=new ArrayBuffer(chunk.channels[0].length*info.channels*4);writeFloatSamples(chunk,new DataView(buffer));await writer.write(buffer);
          frames+=chunk.channels[0].length;progress(fraction(1,frames/info.frames),'お手本に近づけた別の候補を作っています');
        }
        await writer.close();
      }catch(error){await writer.abort().catch(()=>{});throw error;}
      const candidate=await handle.getFile(),expected=56+info.frames*info.channels*4;
      if(candidate.size!==expected)throw new Error('リファレンス候補WAVの長さが一致しません。');
      const candidateInfo=await readWavFileMetadata(candidate),resultMeter=new StreamingAudioAnalyzer(info.sampleRate,info.channels,info.frames),post=new PerceptualAnalyzer(info.sampleRate,info.channels);
      frames=0;
      for await(const chunk of streamWavChunks(candidate,candidateInfo)){
        resultMeter.push(chunk);post.push(chunk.channels);frames+=chunk.channels[0].length;
        progress(fraction(2,frames/info.frames),'お手本への変化と原音の安全性を確認しています');
      }
      const after=resultMeter.finish(),postFeatures=post.finish();
      const evaluation=evaluateReferenceQuality(before,after,features,postFeatures,selection.profile,{ceilingDb:-1,requestedLufs:target,reductionDb:render.reductionDb()});
      const reasons=[...evaluation.reasons];
      if(!checkLongCandidate(base.original,after,target))reasons.push('原音全体からの変化が安全条件を満たしません。');
      report.attempts.push({iteration:iteration+1,plan,after,reductionDb:render.reductionDb(),distanceBefore:evaluation.distanceBefore,distanceAfter:evaluation.distanceAfter,reasons});report.reasons=reasons;
      if(reasons.length)continue;
      // Commit only a completely evaluated scratch. IO errors must propagate; do not
      // return a base File snapshot after its destination has started changing.
      progress(.99,'確認できたお手本補正を仕上がりへ反映しています');
      await candidate.stream().pipeTo(await destination.createWritable());
      const file=await destination.getFile();if(file.size!==expected)throw new Error('保存したリファレンス候補WAVの長さが一致しません。');
      report.status='accepted';report.explanations=[...plan.explanations,...plan.skipped,...(iteration?['測定条件に合わせ、お手本への補正量を弱めました。']:[])];report.reasons=[];
      progress(1,'お手本の傾向に近づけた候補を用意しました');return {file,analysis:after,reference:report};
    }finally{await scratch.discard();}
  }
  report.status='rejected';report.explanations=['お手本への補正候補は採用せず、安全に仕上がった元の候補を保ちました。'];
  progress(1,'お手本補正を見送り、仕上がった候補を保ちました');return preserve();
}
