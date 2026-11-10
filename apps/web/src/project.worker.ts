import { exportProject, importProject, type ProjectManifest } from './project-archive';

type Request = {kind:'project-export';manifest:ProjectManifest;assets:{id:string;file:Blob}[];destination?:FileSystemFileHandle} |
  {kind:'project-import';file:File};
let working=false;
self.onmessage=(event:MessageEvent<Request>)=>{
  if(working){self.postMessage({type:'error',message:'プロジェクト処理が進行中です。'});return;}
  working=true;
  const progress=(fraction:number,text:string)=>self.postMessage({type:'progress',fraction,text});
  void(async()=>{
    try {
      const request=event.data;
      if(request.kind==='project-import') {
        const result=await importProject(request.file,{progress});
        self.postMessage({type:'project-import-result',manifest:result.manifest,assetEntries:[...result.assets]});
      } else if(request.kind==='project-export') {
        const stream=await request.destination?.createWritable();
        try {
          const blob=await exportProject(request.manifest,request.assets,{progress,
            ...(stream ? {write:async(chunk:Uint8Array)=>{await stream.write(chunk as Uint8Array<ArrayBuffer>);}} : {}),
          });
          if(stream){await stream.close();self.postMessage({type:'project-export-result',file:await request.destination!.getFile()});}
          else self.postMessage({type:'project-export-result',blob});
        } catch(error){await stream?.abort().catch(()=>{});throw error;}
      } else throw new Error('不明なプロジェクト処理です。');
    }catch(error){self.postMessage({type:'error',message:error instanceof Error?error.message:'プロジェクトを処理できませんでした。'});}
    finally{working=false;}
  })();
};
