import { exportAudioSource, type AudioExportOptions } from './audio-export';
import type { AudioData } from '@music-sync/core';

self.onmessage=(event:MessageEvent<{kind:'audio-export';source:{audio?:AudioData;file?:File};options:AudioExportOptions}>)=>{
  if(event.data.kind!=='audio-export')return;
  void exportAudioSource(event.data.source,event.data.options,{progress:(fraction,text)=>self.postMessage({type:'progress',fraction,text})})
    .then(result=>self.postMessage({type:'audio-export-result',...result}))
    .catch(error=>self.postMessage({type:'error',message:error instanceof Error?error.message:'音声を書き出せませんでした。'}));
};
