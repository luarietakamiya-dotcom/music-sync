import {afterEach,expect,it,vi} from 'vitest';
import {bindExportSettings,EXPORT_METADATA_KEYS,inspectArtworkBytes,validateSavedExportSettings,type SavedExportSettings} from '../../apps/web/src/export-settings';

const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64'));
const settings=(title='保存した曲'):SavedExportSettings=>({format:'mp3',bitrate:256,dither:false,metadata:{title,artist:'作者🎵',year:'2026',track:'1/2'}});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

it('validates all saved metadata and settings as a separate canonical snapshot',()=>{
  const input=settings('  日本語の曲  '),saved=validateSavedExportSettings(input);
  expect(saved.metadata.title).toBe('日本語の曲');expect(input.metadata.title).toBe('  日本語の曲  ');
  expect(saved.metadata.comment).toBe('');
  for(const invalid of [{...input,format:'other'},{...input,bitrate:160},{...input,dither:0},{...input,metadata:null},
    {...input,metadata:{title:'valid',track:'0'}},{...input,metadata:{artist:'bad\0text'}},{...input,metadata:{year:'202'}}])
    expect(()=>validateSavedExportSettings(invalid as SavedExportSettings)).toThrow();
});

it('checks PNG and JPEG dimension headers before image allocation, including pixel and edge budgets',()=>{
  expect(inspectArtworkBytes(png)).toEqual({mimeType:'image/png',width:1,height:1});
  const jpeg=new Uint8Array([255,216,255,224,0,4,0,0,255,194,0,11,8,0,80,0,120,1,1,17,0,255,218]);
  expect(inspectArtworkBytes(jpeg)).toEqual({mimeType:'image/jpeg',width:120,height:80});
  for(const [w,h] of [[9000,1],[8192,8192],[0,1]]){
    const forged=png.slice(),view=new DataView(forged.buffer);view.setUint32(16,w);view.setUint32(20,h);
    expect(()=>inspectArtworkBytes(forged)).toThrow('ピクセル');
  }
  expect(()=>inspectArtworkBytes(png.subarray(0,20))).toThrow();
  expect(()=>inspectArtworkBytes(new Uint8Array([255,216,255,224,255,255,0,0]))).toThrow();
  expect(()=>inspectArtworkBytes(new TextEncoder().encode('<svg width="1" height="1"/>'))).toThrow();
});

function bindFake(){
  class Element {
    value='';checked=false;hidden=false;src='';textContent='';files:File[]=[];
    addEventListener=vi.fn();removeEventListener=vi.fn();removeAttribute=vi.fn();checkValidity=()=>true;
  }
  const elements=new Map<string,Element>();
  for(const key of ['audio-export-format','audio-export-bitrate','audio-export-artwork','audio-export-cover','audio-export-status','audio-export-mp3',
    'audio-export-dither-label','audio-export-dither','audio-export-cover-clear','wav-button',...EXPORT_METADATA_KEYS.map(k=>'audio-tag-'+k)])elements.set(key,new Element());
  elements.get('audio-export-format')!.value='wav-f32';elements.get('audio-export-bitrate')!.value='192';elements.get('audio-export-dither')!.checked=true;
  vi.stubGlobal('document',{getElementById:(name:string)=>elements.get(name)});
  vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:1,height:1,close:vi.fn()})));
  const create=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:cover');vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  const errors=vi.fn(),change=vi.fn(),api=bindExportSettings(errors,change);
  return {api,elements,create,errors,change};
}

it('restores only after all metadata and artwork pass validation and leaves prior values on failure',async()=>{
  const {api,create}=bindFake(),cover=new File([png],'cover.png');
  await api.restore(settings(),cover);expect(api.state().format).toBe('mp3');expect(api.artwork()?.name).toBe('cover.png');
  const before=api.state(),originalCover=api.artwork();
  await expect(api.restore({...settings('new title'),metadata:{title:'new title',track:'bad'}})).rejects.toThrow();
  expect(api.state()).toEqual(before);expect(api.artwork()).toBe(originalCover);
  const forged=png.slice();new DataView(forged.buffer).setUint32(16,20000);
  await expect(api.restore({...settings('new title'),format:'wav-16'},new File([forged],'huge.png'))).rejects.toThrow();
  expect(api.state()).toEqual(before);expect(api.artwork()).toBe(originalCover);
  expect(create).toHaveBeenCalledTimes(1);expect(createImageBitmap).toHaveBeenCalledTimes(1);
  api.dispose();
});

it('clears pending state after size and decoder failures so exports are never permanently blocked',async()=>{
  const {api}=bindFake(),before=api.state();
  await expect(api.restore(settings(),new File([new Uint8Array(2*1024**2+1)],'big.png'))).rejects.toThrow('2 MiB');
  expect(api.state()).toEqual(before);
  vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('invalid image'));
  await expect(api.restore(settings(),new File([png],'broken.png'))).rejects.toThrow('invalid image');
  expect(api.state()).toEqual(before);
  await api.restore(settings());expect(api.state().metadata.title).toBe('保存した曲');expect(api.artwork()).toBeUndefined();
  api.dispose();
});

it('cancels an asynchronous project restore before committing controls or the decoded cover',async()=>{
  const {api}=bindFake(),before=api.state(),abort=new AbortController();
  let release!:(value:ImageBitmap)=>void;const bitmap={width:1,height:1,close:vi.fn()} as unknown as ImageBitmap;
  vi.mocked(createImageBitmap).mockImplementationOnce(()=>new Promise<ImageBitmap>(resolve=>{release=resolve;}));
  const restore=api.restore(settings(),new File([png],'cover.png'),abort.signal);
  await vi.waitFor(()=>expect(createImageBitmap).toHaveBeenCalledTimes(1));
  abort.abort();release(bitmap);await expect(restore).rejects.toThrow();
  expect(api.state()).toEqual(before);expect(api.artwork()).toBeUndefined();expect(bitmap.close).toHaveBeenCalled();api.dispose();
});
