export interface AudioMetadata {
  title?: string; artist?: string; album?: string; albumArtist?: string;
  year?: string; track?: string; genre?: string; comment?: string;
}
export interface AudioArtwork { data: Uint8Array; mimeType: 'image/jpeg' | 'image/png' }
export const MAX_ARTWORK_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();

function text(value: unknown, key: string): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 1000)
    throw new Error('曲情報の文字数または文字が不正です。');
  for (let i=0;i<value.length;i++) {
    const c=value.charCodeAt(i);
    if((c<32&&!(key==='comment'&&[9,10,13].includes(c)))||c===127)throw new Error('曲情報の文字が不正です。');
    if (c>=0xd800&&c<=0xdbff) {
      const next=value.charCodeAt(++i); if (!(next>=0xdc00&&next<=0xdfff)) throw new Error('曲情報の文字が不正です。');
    } else if(c>=0xdc00&&c<=0xdfff)throw new Error('曲情報の文字が不正です。');
  }
  return value.trim();
}

export function validateAudioMetadata(input: AudioMetadata = {}): AudioMetadata {
  if (!input || typeof input !== 'object' || Array.isArray(input))throw new Error('曲情報が不正です。');
  const result:AudioMetadata={};
  for(const key of ['title','artist','album','albumArtist','year','track','genre','comment'] as const)result[key]=text(input[key],key);
  if(result.year && (!/^\d{4}$/.test(result.year)||Number(result.year)<1000))throw new Error('リリース年は西暦4桁で入力してください。');
  if(result.track && (!/^\d{1,3}(?:\/\d{1,3})?$/.test(result.track)||result.track.split('/').some(n=>Number(n)<1)||
    (result.track.includes('/')&&Number(result.track.split('/')[0])>Number(result.track.split('/')[1]))))throw new Error('曲順は1〜999、または1/10の形式で入力してください。');
  return result;
}

export function validateAudioArtwork(input?:AudioArtwork):AudioArtwork|undefined {
  if(input===undefined)return undefined;
  if(!input || !(input.data instanceof Uint8Array) || input.data.length<8 || input.data.length>MAX_ARTWORK_BYTES)
    throw new Error('ジャケットは2 MiB以内のJPEGまたはPNGにしてください。');
  const b=input.data;
  const png=b[0]===137&&b[1]===80&&b[2]===78&&b[3]===71&&b[4]===13&&b[5]===10&&b[6]===26&&b[7]===10;
  const jpeg=b[0]===255&&b[1]===216&&b[2]===255;
  if(!((input.mimeType==='image/png'&&png)||(input.mimeType==='image/jpeg'&&jpeg)))
    throw new Error('ジャケットの形式と内容が一致しません。JPEGまたはPNGを選んでください。');
  return {mimeType:input.mimeType,data:input.data.slice()};
}

function join(parts:Uint8Array[]):Uint8Array {
  const result=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;
  for(const part of parts){result.set(part,offset);offset+=part.length;}return result;
}
function utf16(value:string):Uint8Array {
  const result=new Uint8Array(2+value.length*2),view=new DataView(result.buffer);result.set([255,254]);
  for(let i=0;i<value.length;i++)view.setUint16(2+i*2,value.charCodeAt(i),true);return result;
}
function frame(id:string,payload:Uint8Array):Uint8Array {
  const header=new Uint8Array(10);header.set(encoder.encode(id));new DataView(header.buffer).setUint32(4,payload.length,false);
  return join([header,payload]);
}

/** ID3v2.3, UTF-16 text, front-cover APIC. Bytes precede MP3 frames, never become PCM. */
export function encodeId3(metadata:AudioMetadata={},artwork?:AudioArtwork,durationMs?:number):Uint8Array {
  const values=validateAudioMetadata(metadata),cover=validateAudioArtwork(artwork),frames:Uint8Array[]=[];
  const keys={title:'TIT2',artist:'TPE1',album:'TALB',albumArtist:'TPE2',year:'TYER',track:'TRCK',genre:'TCON'} as const;
  for(const [key,id] of Object.entries(keys)) {
    const value=values[key as keyof typeof keys];if(value)frames.push(frame(id,join([new Uint8Array([1]),utf16(value)])));
  }
  if(values.comment)frames.push(frame('COMM',join([new Uint8Array([1]),encoder.encode('eng'),utf16(''),new Uint8Array(2),utf16(values.comment)])));
  if(durationMs!==undefined){
    if(!Number.isFinite(durationMs)||durationMs<0||durationMs>1200000)throw new Error('音声の長さが不正です。');
    frames.push(frame('TLEN',join([new Uint8Array([0]),encoder.encode(String(Math.round(durationMs)))])));
  }
  if(cover)frames.push(frame('APIC',join([new Uint8Array([0]),encoder.encode(cover.mimeType),new Uint8Array([0,3,0]),cover.data])));
  const body=join(frames),header=new Uint8Array([73,68,51,3,0,0,0,0,0,0]);
  const size=body.length;header[6]=(size>>>21)&127;header[7]=(size>>>14)&127;header[8]=(size>>>7)&127;header[9]=size&127;
  return join([header,body]);
}
