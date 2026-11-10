import {validateReferenceSelection,type ReferenceProfile,type ReferenceSelection,type AnalysisResult} from '@music-sync/core';
export interface SavedSoundReference {file:File;strength:number;enabled:boolean}
interface ReferenceAdapter {
  busy():boolean;hasSource():boolean;
  load(file:File):Promise<{profile:ReferenceProfile;result:AnalysisResult}|undefined>;
  changed():void;error(message:string):void;finish():void;
}
export function bindReferenceWorkspace(adapter:ReferenceAdapter) {
  const el=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
  const input=el<HTMLInputElement>('reference-input'),enabled=el<HTMLInputElement>('reference-enabled'),strength=el<HTMLSelectElement>('reference-strength');
  let current:{file:File;profile:ReferenceProfile}|undefined;
  let epoch=0;
  function refresh(){
    const busy=adapter.busy();
    el<HTMLFieldSetElement>('reference-settings').disabled=busy;
    enabled.disabled=busy||!current;
    el<HTMLButtonElement>('reference-clear').disabled=busy||!current;
    el<HTMLButtonElement>('reference-finish').disabled=busy||!current||!adapter.hasSource();
    el('reference-name').textContent=current?'参考曲：'+current.file.name:'参考曲は未選択です。';
  }
  function commit(file:File|undefined,profile?:ReferenceProfile,use=true,amount=.65) {
    if(file){validateReferenceSelection({profile:profile!,strength:amount});current={file,profile:profile!};}
    else current=undefined;
    epoch++;enabled.checked=use;
    if(!Array.from(strength.options).some(option=>option.value===String(amount))){const option=document.createElement('option');option.value=String(amount);option.textContent='保存した強さ（'+Math.round(amount*100)+'%）';strength.append(option);}
    strength.value=String(amount);refresh();
    el('reference-status').textContent=file?'参考曲を用意しました。次の仕上げに'+(use?'反映します。':'は使わない設定です。'):'参考曲は未選択です。現在のA/Bは保持しています。';
    adapter.changed();
  }
  async function load(file:File) {
    if(adapter.busy())return;
    const version=++epoch;
    try{
      const result=await adapter.load(file);
      if(result&&version===epoch){
        commit(file,result.profile,true,Number(strength.value));
        el('reference-status').textContent='参考曲の解析が完了しました。音色・低域・密度の傾向を使います。現在のBは変えていません。';
        el('reference-result').textContent='';
      }
    }catch(error){if(version===epoch)adapter.error(error instanceof Error?error.message:'参考曲を読み込めませんでした。');}
    finally{refresh();}
  }
  input.addEventListener('change',()=>{const file=input.files?.[0];input.value='';if(file)void load(file);});
  const zone=el('reference-dropzone');
  zone.addEventListener('dragover',event=>{event.preventDefault();zone.classList.add('drag-over');});
  zone.addEventListener('dragleave',()=>zone.classList.remove('drag-over'));
  zone.addEventListener('drop',event=>{
    event.preventDefault();event.stopPropagation();zone.classList.remove('drag-over');
    const files=(event as DragEvent).dataTransfer?.files;
    if(files?.length===1)void load(files[0]);else if(files?.length)adapter.error('参考曲は1曲ずつ選んでください。');
  });
  el('reference-clear').addEventListener('click',()=>{if(adapter.busy())return;commit(undefined);el('reference-status').textContent='参考曲を外しました。現在のA/Bは保持しています。';el('reference-result').textContent='';});
  enabled.addEventListener('change',()=>{adapter.changed();refresh();});
  strength.addEventListener('change',()=>adapter.changed());
  el('reference-finish').addEventListener('click',()=>{if(!adapter.busy()&&current){enabled.checked=true;adapter.finish();}});
  refresh();
  return{
    selection():ReferenceSelection|undefined{return current&&enabled.checked?{profile:current.profile,strength:Number(strength.value)}:undefined;},
    state():SavedSoundReference|undefined{return current?{file:current.file,strength:Number(strength.value),enabled:enabled.checked}:undefined;},
    commit,refresh,
    signature(){return JSON.stringify([enabled.checked,strength.value,current?.profile]);},
    dispose(){epoch++;current=undefined;},
  };
}
