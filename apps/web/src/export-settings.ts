import type { AudioExportOptions } from './audio-export';
import { MAX_ARTWORK_BYTES, validateAudioMetadata } from './id3';

export const EXPORT_METADATA_KEYS=['title','artist','album','albumArtist','year','track','genre','comment'] as const;
export interface SavedExportSettings {
  format:AudioExportOptions['format'];bitrate:128|192|256|320;dither:boolean;
  metadata:Record<string,string>;
}
const MAX_COVER_EDGE=8192,MAX_COVER_PIXELS=16777216;
const id=<T extends HTMLElement>(name:string)=>document.getElementById(name) as T;

export function validateSavedExportSettings(state:SavedExportSettings):SavedExportSettings {
  if(!state||!['wav-f32','wav-16','wav-24','mp3'].includes(state.format)||![128,192,256,320].includes(state.bitrate)||typeof state.dither!=='boolean'||
    !state.metadata||typeof state.metadata!=='object'||Array.isArray(state.metadata))throw new Error('書き出し設定が不正です。');
  const metadata=validateAudioMetadata(state.metadata);
  return {format:state.format,bitrate:state.bitrate,dither:state.dither,
    metadata:Object.fromEntries(EXPORT_METADATA_KEYS.map(key=>[key,metadata[key]??'']))};
}

/** Read the small image header before the browser allocates its decoded pixel buffer. */
export function inspectArtworkBytes(data:Uint8Array):{mimeType:'image/png'|'image/jpeg';width:number;height:number} {
  if(data.length<8||data.length>MAX_ARTWORK_BYTES)throw new Error('ジャケットは2 MiB以内のJPEGまたはPNGを選んでください。');
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  let width=0,height=0,mimeType:'image/png'|'image/jpeg';
  if([137,80,78,71,13,10,26,10].every((n,i)=>data[i]===n)){
    if(data.length<33||view.getUint32(8)!==13||view.getUint32(12)!==0x49484452)throw new Error('PNG画像のヘッダーが不正です。');
    width=view.getUint32(16);height=view.getUint32(20);mimeType='image/png';
  }else if(data[0]===255&&data[1]===216&&data[2]===255){
    mimeType='image/jpeg';let offset=2;
    while(offset<data.length){
      if(data[offset++]!==255)throw new Error('JPEG画像のヘッダーが不正です。');
      while(data[offset]===255)offset++;
      const marker=data[offset++];
      if(marker===0xd9||marker===0xda||marker===undefined)break;
      if(marker===1||(marker>=0xd0&&marker<=0xd7))continue;
      if(offset+2>data.length)break;
      const length=view.getUint16(offset);
      if(length<2||offset+length>data.length)throw new Error('JPEG画像のヘッダーが不正です。');
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
        if(length<8)throw new Error('JPEG画像のヘッダーが不正です。');
        height=view.getUint16(offset+3);width=view.getUint16(offset+5);break;
      }
      offset+=length;
    }
  }else throw new Error('ジャケットはJPEGまたはPNG画像を選んでください。');
  if(!width||!height||width>MAX_COVER_EDGE||height>MAX_COVER_EDGE||width*height>MAX_COVER_PIXELS)
    throw new Error('ジャケットは縦横8192ピクセル以内、合計1677万画素以内の画像を選んでください。');
  return {mimeType,width,height};
}
interface PreparedCover {file:File;data:Uint8Array}
async function prepareArtwork(file?:File):Promise<PreparedCover|undefined>{
  if(!file)return undefined;
  if(file.size>MAX_ARTWORK_BYTES||!file.size)throw new Error('ジャケットは2 MiB以内のJPEGまたはPNGを選んでください。');
  const data=new Uint8Array(await file.arrayBuffer()),header=inspectArtworkBytes(data);
  const normalized=new File([data],file.name,{type:header.mimeType,lastModified:file.lastModified});
  const bitmap=await createImageBitmap(normalized);
  try{
    // EXIF orientation can interchange width/height. Decode validates the full image.
    if(!bitmap.width||!bitmap.height||bitmap.width>MAX_COVER_EDGE||bitmap.height>MAX_COVER_EDGE||bitmap.width*bitmap.height>MAX_COVER_PIXELS)
      throw new Error('ジャケットの画像サイズが不正です。');
  }finally{bitmap.close();}
  return {file:normalized,data};
}

export function bindExportSettings(onError:(message:string)=>void,onChange:()=>void){
  const format=id<HTMLSelectElement>('audio-export-format'),bitrate=id<HTMLSelectElement>('audio-export-bitrate');
  const image=id<HTMLInputElement>('audio-export-artwork'),thumbnail=id<HTMLImageElement>('audio-export-cover');
  let cover:PreparedCover|undefined,url:string|undefined,epoch=0,pending=false;
  const message=id<HTMLElement>('audio-export-status');
  function release(){if(url)URL.revokeObjectURL(url);url=undefined;thumbnail.removeAttribute('src');thumbnail.hidden=true;}
  function commitArtwork(candidate?:PreparedCover){
    const nextUrl=candidate?URL.createObjectURL(candidate.file):undefined;
    release();cover=candidate;url=nextUrl;image.value='';
    if(candidate){thumbnail.src=url!;thumbnail.hidden=false;message.textContent='ジャケット：'+candidate.file.name+'。MP3とプロジェクトに保存します。';}
    else message.textContent='ジャケットなし';
  }
  function refresh(){
    id('audio-export-mp3').hidden=format.value!=='mp3';
    id('audio-export-dither-label').hidden=!['wav-16','wav-24'].includes(format.value);
    const button=id<HTMLButtonElement>('wav-button');
    button.textContent=format.value==='mp3'?'処理済みBをMP3保存 ↓':'処理済みBをWAV保存 ↓';
    onChange();
  }
  async function setArtwork(file?:File){
    const current=++epoch;pending=!!file;let applied=false;
    try{
      const candidate=await prepareArtwork(file);
      if(current!==epoch)return;
      commitArtwork(candidate);applied=true;
    }catch(error){if(current===epoch)throw error;}
    finally{if(current===epoch)pending=false;}
    if(applied)onChange();
  }
  const imageChanged=()=>{void setArtwork(image.files?.[0]).catch(error=>onError(error instanceof Error?error.message:'画像を読み込めません。'));};
  const clearCover=()=>{void setArtwork().catch(error=>onError(error instanceof Error?error.message:'画像を変更できません。'));};
  image.addEventListener('change',imageChanged);
  id('audio-export-cover-clear').addEventListener('click',clearCover);
  format.addEventListener('change',refresh);
  function snapshot():SavedExportSettings{
    if(pending)throw new Error('ジャケットの準備が終わるまでお待ちください。');
    const metadata:Record<string,string>={};
    for(const key of EXPORT_METADATA_KEYS){
      const input=id<HTMLInputElement>('audio-tag-'+key);
      if(!input.checkValidity())throw new Error('メタデータの入力値を確認してください。');
      metadata[key]=input.value;
    }
    return validateSavedExportSettings({format:format.value as SavedExportSettings['format'],bitrate:Number(bitrate.value) as SavedExportSettings['bitrate'],
      dither:id<HTMLInputElement>('audio-export-dither').checked,metadata});
  }
  refresh();
  return{
    state:snapshot,artwork:()=>cover?.file,
    options():AudioExportOptions{
      const state=snapshot();
      return {...state,metadata:state.metadata,artwork:cover?{data:cover.data,mimeType:cover.file.type as 'image/png'|'image/jpeg'}:undefined};
    },
    async restore(state:SavedExportSettings,file?:File,signal?:AbortSignal){
      signal?.throwIfAborted();
      const validated=validateSavedExportSettings(state),current=++epoch;pending=true;
      try{
        const candidate=await prepareArtwork(file);
        signal?.throwIfAborted();
        if(current!==epoch)throw new DOMException('書き出し設定の読み込みをキャンセルしました。','AbortError');
        // No settings or cover have changed until every field and image has passed validation.
        commitArtwork(candidate);format.value=validated.format;bitrate.value=String(validated.bitrate);
        id<HTMLInputElement>('audio-export-dither').checked=validated.dither;
        for(const key of EXPORT_METADATA_KEYS)id<HTMLInputElement>('audio-tag-'+key).value=validated.metadata[key];
      }finally{if(current===epoch)pending=false;}
      refresh();
    },
    dispose(){epoch++;pending=false;release();cover=undefined;image.removeEventListener('change',imageChanged);id('audio-export-cover-clear').removeEventListener('click',clearCover);format.removeEventListener('change',refresh);},
  };
}
