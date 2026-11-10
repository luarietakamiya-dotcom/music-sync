import { Zip, ZipPassThrough } from 'fflate';

export interface ProjectAssetDescriptor {
  id: string;
  path: string;
  name: string;
  mimeType: string;
  size: number;
}
export interface ProjectManifest {
  format: 'music-sync-project';
  version: 1;
  createdAt: string;
  name: string;
  assets: ProjectAssetDescriptor[];
  /** Application state is data only. The host validates its domain-specific schema before committing. */
  state: Record<string, unknown>;
}
export interface ProjectArchiveOptions {
  signal?: AbortSignal;
  progress?(fraction: number, text: string): void;
}
export const PROJECT_ARCHIVE_LIMITS = Object.freeze({
  assets: 64, assetBytes: 512 * 1024 ** 2, totalBytes: 2 * 1024 ** 3,
  manifestBytes: 8 * 1024 ** 2, blobBytes: 256 * 1024 ** 2,
  archiveBytes: 2 * 1024 ** 3 + 16 * 1024 ** 2,
});
const MANIFEST = 'manifest.json', BLOCK = 65536;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const mediaTypes = new Set(['audio/wav', 'audio/flac', 'image/jpeg', 'image/png', 'application/octet-stream']);
const idPattern = /^[a-z0-9_-]{1,64}$/;
const fail: (text: string) => never = text => { throw new Error(text); };
const cancelled = (signal?: AbortSignal) => signal?.throwIfAborted();
const ownKeys = (value: object, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' &&
  !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function label(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && encoder.encode(value).length <= 1024;
}

function safeJson(value: unknown, signal?: AbortSignal) {
  let nodes = 0, jsonBytes = 0;
  const budget = (text: string) => {
    if (text.length > PROJECT_ARCHIVE_LIMITS.manifestBytes) fail('プロジェクトの文字列が大きすぎます。');
    jsonBytes += encoder.encode(JSON.stringify(text)).length;
    if (jsonBytes > PROJECT_ARCHIVE_LIMITS.manifestBytes) fail('プロジェクトの設定が8 MiBを超えています。');
  };
  function visit(item: unknown, depth: number, arrayMember = false) {
    if (++nodes % 1024 === 0) cancelled(signal);
    if (nodes > 500000 || depth > 30) fail('プロジェクトの設定データが複雑すぎます。');
    if (item === null || typeof item === 'boolean' || (item === undefined && !arrayMember)) return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail('プロジェクトに不正な数値があります。'); return; }
    if (typeof item === 'string') { budget(item); return; }
    if (Array.isArray(item)) {
      if (item.length > 100000) fail('プロジェクトの配列が大きすぎます。');
      for (const child of item) visit(child, depth + 1, true);
      return;
    }
    if (!plain(item)) fail('プロジェクトの設定データが不正です。');
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('プロジェクトに使用できない設定キーがあります。');
      budget(key);
      visit(child, depth + 1);
    }
  }
  visit(value, 0);
}

/** Validate before allocating or applying any project state. */
export function validateProjectManifest(value: unknown, signal?: AbortSignal): ProjectManifest {
  cancelled(signal); safeJson(value, signal);
  if (!plain(value) || !ownKeys(value, ['format', 'version', 'createdAt', 'name', 'assets', 'state']) ||
    value.format !== 'music-sync-project' || value.version !== 1 || !label(value.name) || typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt ||
    !Array.isArray(value.assets) || value.assets.length > PROJECT_ARCHIVE_LIMITS.assets || !plain(value.state))
    fail('対応するMusicSyncプロジェクトではありません。');
  const ids = new Set<string>();
  let bytes = 0;
  for (const asset of value.assets) {
    if (!plain(asset) || !ownKeys(asset, ['id', 'path', 'name', 'mimeType', 'size']) ||
      typeof asset.id !== 'string' || !idPattern.test(asset.id) || ids.has(asset.id) ||
      asset.path !== `assets/${asset.id}.bin` || !label(asset.name) || typeof asset.mimeType !== 'string' ||
      !mediaTypes.has(asset.mimeType) || !Number.isSafeInteger(asset.size) || (asset.size as number) < 0 ||
      (asset.size as number) > PROJECT_ARCHIVE_LIMITS.assetBytes) fail('プロジェクトの素材情報が不正です。');
    ids.add(asset.id); bytes += asset.size as number;
  }
  if (bytes > PROJECT_ARCHIVE_LIMITS.totalBytes) fail('プロジェクトの素材合計が2 GiBを超えています。');
  const text = JSON.stringify(value);
  if (encoder.encode(text).length > PROJECT_ARCHIVE_LIMITS.manifestBytes) fail('プロジェクトの設定が8 MiBを超えています。');
  // Own a JSON-only snapshot; later UI mutations cannot alter a running save.
  return JSON.parse(text) as ProjectManifest;
}

/** Stream ZIP STORE entries with backpressure. Original Blob/File objects are never changed. */
export async function exportProject(value: ProjectManifest, inputs: readonly { id: string; file: Blob }[],
  options: ProjectArchiveOptions & { write?(chunk: Uint8Array): Promise<void> } = {}): Promise<Blob | undefined> {
  const { signal, progress, write } = options;
  const manifest = validateProjectManifest(value, signal);
  if (!Array.isArray(inputs) || inputs.length !== manifest.assets.length) fail('保存する素材が不足しています。');
  const sources = new Map<string, Blob>();
  for (const input of inputs) {
    const expected = manifest.assets.find(asset => asset.id === input.id);
    if (!expected || sources.has(input.id) || !(input.file instanceof Blob) || input.file.size !== expected.size)
      fail('保存する素材とプロジェクト情報が一致しません。');
    sources.set(input.id, input.file);
  }
  const metadata = new Blob([encoder.encode(JSON.stringify(manifest))], { type: 'application/json' });
  const total = metadata.size + manifest.assets.reduce((sum, asset) => sum + asset.size, 0);
  if (!write && total + 256000 > PROJECT_ARCHIVE_LIMITS.blobBytes)
    fail('大きなプロジェクトの保存にはブラウザの一時保存が必要です。');
  const chunks: BlobPart[] = [];
  let chain = Promise.resolve(), error: Error | undefined, final = false, outputBytes = 0;
  const zip = new Zip((failure, data, last) => {
    if (failure) { error = failure; return; }
    outputBytes += data.byteLength;
    if (outputBytes > PROJECT_ARCHIVE_LIMITS.archiveBytes) { error = new Error('プロジェクトが保存上限を超えました。'); return; }
    if (write) chain = chain.then(async () => { cancelled(signal); await write(data); });
    else chunks.push(data.slice().buffer as ArrayBuffer);
    final ||= last;
  });
  const drain = async () => { await chain; cancelled(signal); if (error) throw error; };
  let processed = 0;
  try {
    const entries = [{ path: MANIFEST, file: metadata }, ...manifest.assets.map(asset => ({ path: asset.path, file: sources.get(asset.id)! }))];
    for (const entry of entries) {
      cancelled(signal);
      const part = new ZipPassThrough(entry.path);
      part.mtime = new Date('1980-01-01T00:00:00.000Z');
      zip.add(part); await drain();
      if (!entry.file.size) { part.push(new Uint8Array(0), true); await drain(); }
      for (let offset = 0; offset < entry.file.size; offset += BLOCK) {
        const bytes = new Uint8Array(await entry.file.slice(offset, offset + BLOCK).arrayBuffer());
        cancelled(signal); part.push(bytes, offset + bytes.length === entry.file.size); await drain();
        processed += bytes.length; progress?.(processed / Math.max(1, total), '素材と設定をプロジェクトに保存しています…');
      }
    }
    zip.end(); await drain();
    if (!final) fail('プロジェクトの保存を完了できませんでした。');
    progress?.(1, 'プロジェクトを保存しました。');
    return write ? undefined : new Blob(chunks, { type: 'application/zip' });
  } catch (failure) { zip.terminate(); throw failure; }
}

interface StoredEntry { path: string; offset: number; size: number; crc: number; start: number; end: number }
async function read(file: Blob, start: number, count: number, signal?: AbortSignal): Promise<Uint8Array> {
  cancelled(signal);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 0 || start + count > file.size)
    fail('プロジェクトのZIP構造が途中で切れています。');
  const bytes = new Uint8Array(await file.slice(start, start + count).arrayBuffer());
  cancelled(signal); if (bytes.length !== count) fail('プロジェクトを読み取れませんでした。');
  return bytes;
}
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
function pathName(bytes: Uint8Array): string {
  let name: string;
  try { name = decoder.decode(bytes); } catch { return fail('ZIP内の素材名が不正です。'); }
  if (name !== MANIFEST && !/^assets\/[a-z0-9_-]{1,64}\.bin$/.test(name)) fail('MusicSync用ではないZIPパスが含まれています。');
  return name;
}
function extras(bytes: Uint8Array) {
  const data = view(bytes);
  for (let i = 0; i < bytes.length;) {
    if (i + 4 > bytes.length) fail('ZIPの追加情報が不正です。');
    const kind = data.getUint16(i, true), length = data.getUint16(i + 2, true); i += 4;
    if (kind === 1 || i + length > bytes.length) fail('ZIP64または不正な追加情報には対応していません。');
    i += length;
  }
}

/** Restricted ZIP STORE profile (PKWARE APPNOTE 4.3); never expands compressed asset data.
 * Header offsets: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 */
async function index(file: File, signal?: AbortSignal): Promise<StoredEntry[]> {
  if (!(file instanceof File) || file.size < 22 || file.size > PROJECT_ARCHIVE_LIMITS.archiveBytes)
    fail('プロジェクトファイルのサイズが対応範囲外です。');
  const tailStart = Math.max(0, file.size - 65557), tail = await read(file, tailStart, file.size - tailStart, signal), last = view(tail);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--)
    if (last.getUint32(i, true) === 0x06054b50 && i + 22 + last.getUint16(i + 20, true) === tail.length) { end = i; break; }
  if (end < 0) fail('プロジェクトのZIP終端が見つかりません。');
  const count = last.getUint16(end + 10, true), size = last.getUint32(end + 12, true), offset = last.getUint32(end + 16, true);
  if (last.getUint16(end + 4, true) || last.getUint16(end + 6, true) || last.getUint16(end + 8, true) !== count ||
    count < 1 || count > PROJECT_ARCHIVE_LIMITS.assets + 1 || count === 0xffff || offset === 0xffffffff || size === 0xffffffff ||
    size > 256000 || offset + size !== tailStart + end) fail('分割ZIP・ZIP64または不正なプロジェクトです。');
  const directory = await read(file, offset, size, signal), central = view(directory), entries: StoredEntry[] = [], names = new Set<string>();
  let position = 0, total = 0;
  for (let i = 0; i < count; i++) {
    cancelled(signal);
    if (position + 46 > size || central.getUint32(position, true) !== 0x02014b50) fail('ZIPの索引が不正です。');
    const needed = central.getUint16(position + 6, true), flags = central.getUint16(position + 8, true), compression = central.getUint16(position + 10, true);
    const crc = central.getUint32(position + 16, true), compressed = central.getUint32(position + 20, true), original = central.getUint32(position + 24, true);
    const nameSize = central.getUint16(position + 28, true), extraSize = central.getUint16(position + 30, true), commentSize = central.getUint16(position + 32, true);
    const local = central.getUint32(position + 42, true), next = position + 46 + nameSize + extraSize + commentSize;
    const attrs = central.getUint32(position + 38, true), unixKind = attrs >>> 16 & 0xf000;
    if (needed > 20 || flags & ~0x0808 || compression !== 0 || compressed !== original || original === 0xffffffff ||
      central.getUint16(position + 34, true) || nameSize < 1 || nameSize > 100 || extraSize > 4096 || next > size ||
      local >= offset || unixKind === 0xa000 || unixKind === 0x4000 || attrs & 0x10)
      fail('圧縮・暗号化・特殊ファイルを含むZIPには対応していません。');
    const path = pathName(directory.subarray(position + 46, position + 46 + nameSize));
    if (names.has(path)) fail('ZIPに重複する素材があります。'); names.add(path);
    const maximum = path === MANIFEST ? PROJECT_ARCHIVE_LIMITS.manifestBytes : PROJECT_ARCHIVE_LIMITS.assetBytes;
    if (original > maximum) fail('ZIP内の素材が保存上限を超えています。');
    total += original; if (total > PROJECT_ARCHIVE_LIMITS.totalBytes + PROJECT_ARCHIVE_LIMITS.manifestBytes) fail('ZIPの合計サイズが大きすぎます。');
    extras(directory.subarray(position + 46 + nameSize, position + 46 + nameSize + extraSize));
    const header = view(await read(file, local, 30, signal));
    const localName = header.getUint16(26, true), localExtra = header.getUint16(28, true);
    if (header.getUint32(0, true) !== 0x04034b50 || header.getUint16(4, true) !== needed || header.getUint16(6, true) !== flags ||
      header.getUint16(8, true) !== 0 || localName !== nameSize || localExtra > 4096) fail('ZIPの素材ヘッダーが一致しません。');
    const details = await read(file, local + 30, localName + localExtra, signal);
    if (pathName(details.subarray(0, localName)) !== path) fail('ZIPの素材名が一致しません。');
    extras(details.subarray(localName));
    const dataOffset = local + 30 + localName + localExtra, dataEnd = dataOffset + original;
    let entryEnd = dataEnd;
    if (dataEnd > offset) fail('ZIPの素材領域が索引と重なっています。');
    if (flags & 8) {
      const descriptorStart = view(await read(file, dataEnd, 4, signal)).getUint32(0, true) === 0x08074b50 ? 4 : 0;
      const descriptor = view(await read(file, dataEnd + descriptorStart, 12, signal));
      if (descriptor.getUint32(0, true) !== crc || descriptor.getUint32(4, true) !== original || descriptor.getUint32(8, true) !== original)
        fail('ZIPのストリーム情報が一致しません。');
      entryEnd += descriptorStart + 12;
      for (const [at, expected] of [[14, crc], [18, original], [22, original]]) {
        const actual = header.getUint32(at, true); if (actual !== 0 && actual !== expected) fail('ZIPの素材サイズが一致しません。');
      }
    } else if (header.getUint32(14, true) !== crc || header.getUint32(18, true) !== original || header.getUint32(22, true) !== original)
      fail('ZIPの素材サイズが一致しません。');
    if (entryEnd > offset) fail('ZIPの素材情報が索引と重なっています。');
    entries.push({path,offset:dataOffset,size:original,crc,start:local,end:entryEnd}); position = next;
  }
  if (position !== size || !names.has(MANIFEST)) fail('ZIPの索引またはプロジェクト設定が不正です。');
  let endOffset = 0;
  for (const entry of [...entries].sort((a, b) => a.start - b.start)) {
    if (entry.start !== endOffset) fail('ZIPの素材領域が重複しているか、不明なデータがあります。');
    endOffset = entry.end;
  }
  if (endOffset !== offset) fail('ZIPの素材領域と索引が一致しません。');
  return entries;
}

const crcTable = Uint32Array.from({length:256},(_,value)=>{
  for(let i=0;i<8;i++) value=value&1 ? 0xedb88320 ^ value>>>1 : value>>>1;
  return value>>>0;
});
async function verifyCrc(file: File, entry: StoredEntry, signal: AbortSignal | undefined, onRead: (bytes: number) => void) {
  let crc = 0xffffffff;
  for (let offset=0;offset<entry.size;offset+=BLOCK) {
    const bytes=await read(file,entry.offset+offset,Math.min(BLOCK,entry.size-offset),signal);
    for (const value of bytes) crc=crcTable[(crc^value)&255] ^ crc>>>8;
    onRead(bytes.length);
  }
  if (((crc^0xffffffff)>>>0)!==entry.crc) fail('プロジェクトの素材が壊れています（CRC不一致）。');
}

/** Asset Files are slices of the input archive, not copied/extracted PCM buffers. */
export async function importProject(file: File, options: ProjectArchiveOptions = {}): Promise<{manifest: ProjectManifest; assets: Map<string, File>}> {
  const {signal,progress}=options, entries=await index(file,signal), manifestEntry=entries.find(entry=>entry.path===MANIFEST)!;
  await verifyCrc(file,manifestEntry,signal,()=>{});
  let manifest: ProjectManifest;
  try { manifest=validateProjectManifest(JSON.parse(decoder.decode(await read(file,manifestEntry.offset,manifestEntry.size,signal))),signal); }
  catch(error) { if(signal?.aborted)throw error;throw new Error('プロジェクト設定を読み込めません。'+(error instanceof Error?error.message:''),{cause:error}); }
  const expected=new Map(manifest.assets.map(asset=>[asset.path,asset]));
  if(entries.length!==manifest.assets.length+1 || entries.some(entry=>entry.path!==MANIFEST && !expected.has(entry.path)))
    fail('ZIPの素材一覧とプロジェクト設定が一致しません。');
  const total=manifest.assets.reduce((sum,asset)=>sum+asset.size,0);
  let scanned=0;
  const assets=new Map<string,File>();
  for(const entry of entries) {
    if(entry.path===MANIFEST)continue;
    const asset=expected.get(entry.path)!;
    if(entry.size!==asset.size)fail('ZIPの素材サイズとプロジェクト設定が一致しません。');
    await verifyCrc(file,entry,signal,bytes=>{scanned+=bytes;progress?.(scanned/Math.max(1,total),'プロジェクトの素材を確認しています…');});
    assets.set(asset.id,new File([file.slice(entry.offset,entry.offset+entry.size)],asset.name,{type:asset.mimeType,lastModified:Date.parse(manifest.createdAt)}));
  }
  cancelled(signal);progress?.(1,'プロジェクトの素材と設定を確認しました。');
  return {manifest,assets};
}
