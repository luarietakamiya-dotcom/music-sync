import { analyzeAudio, analyzePerceptualFeatures, PerceptualAnalyzer, profileFromMeasurements, StreamingAudioAnalyzer, type AudioData } from '@music-sync/core';
import { decodeWav } from './decode';
import { readWavFileMetadata, streamWavChunks } from './wav-stream';

self.onmessage = async (event: MessageEvent<{ buffer?: ArrayBuffer; audio?: AudioData; file?: File; maxDecodedBytes?: number; reference?: boolean }>) => {
  try {
    if (event.data.file) {
      const info = await readWavFileMetadata(event.data.file);
      const analyzer = new StreamingAudioAnalyzer(info.sampleRate, info.channels, info.frames);
      const perceptual = event.data.reference ? new PerceptualAnalyzer(info.sampleRate,info.channels) : undefined;
      let done = 0;
      for await (const chunk of streamWavChunks(event.data.file, info)) {
        analyzer.push(chunk); perceptual?.push(chunk.channels); done += chunk.channels[0].length;
        self.postMessage({ type: 'progress', fraction: done / info.frames });
      }
      const result=analyzer.finish();
      self.postMessage(event.data.reference ? {type:'reference-result',result,profile:profileFromMeasurements(result,perceptual!.finish())} : {type:'stream-result',result});
      return;
    }
    const audio = event.data.audio ?? decodeWav(event.data.buffer!, event.data.maxDecodedBytes);
    const result = analyzeAudio(audio, { onProgress: fraction => self.postMessage({ type: 'progress', fraction }) });
    if(event.data.reference){self.postMessage({type:'reference-result',result,profile:profileFromMeasurements(result,analyzePerceptualFeatures(audio))});return;}
    self.postMessage({ type: 'result', result, audio }, { transfer: audio.channels.map(c => c.buffer as ArrayBuffer) });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : '解析に失敗しました。' });
  }
};
