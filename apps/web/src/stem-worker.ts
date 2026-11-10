import { renderFileStemRepair } from './stem-repair-render';
import { importFileStems } from './file-stems';
import { STEM_LIMITS, createStemMixSession, planStemBalance, planStemMasking, analyzePerceptualFeatures, type StemStudioSettings, type StemDescriptor, type StemMode, type AudioData } from '@music-sync/core';
import { decodeWav, readWavMetadata, readFlacMetadata } from './decode';

export interface StemFileEntry { id: string; file: File; role: StemDescriptor['role']; gainDb: number; pan: number; muted: boolean; vocalRole?: StemDescriptor['vocalRole']; restorationEnabled?: boolean }
export type StemWorkerRequest = { kind: 'stems-import'; mode: StemMode; tracks: StemFileEntry[]; autoBalance?: boolean; clarity?: boolean }
  | { kind: 'file-stems'; mode: StemMode; tracks: StemFileEntry[]; autoBalance: boolean; clarity?: boolean; vocalSupport?: boolean; destination?: FileSystemFileHandle; studio?: StemStudioSettings; reference?: File }
  | { kind: 'stem-repair-preview'; entry: StemFileEntry; studio: StemStudioSettings; destination?: FileSystemFileHandle }
  | { kind: 'stems-flac-result'; id: string; audio?: AudioData; error?: string };
let working = false;
let pendingFlac: { id: string; resolve: (audio: AudioData) => void; reject: (error: Error) => void } | undefined;

async function decodeEntry(entry: StemFileEntry): Promise<AudioData> {
  const raw = await entry.file.arrayBuffer();
  if (!/\.flac$/i.test(entry.file.name)) return decodeWav(raw, STEM_LIMITS.maxBusBytes);
  const decoding = new Promise<AudioData>((resolve, reject) => { pendingFlac = { id: entry.id, resolve, reject }; });
  self.postMessage({ type: 'stem-flac', id: entry.id, buffer: raw }, { transfer: [raw] });
  return decoding;
}

async function importStems(request: Extract<StemWorkerRequest, { kind: 'stems-import' }>): Promise<void> {
  if (working) throw new Error('STEMの読み込みが進行中です。');
  working = true;
  try {
    const entries = request.tracks;
    if (!Array.isArray(entries) || entries.length < 2 || entries.length > STEM_LIMITS.maxTracks ||
      entries.some(t => !(t.file instanceof File) || !t.file.size || t.file.size > STEM_LIMITS.maxFileBytes || !/\.(wav|flac)$/i.test(t.file.name)) ||
      entries.reduce((n, t) => n + t.file.size, 0) > STEM_LIMITS.maxTotalFileBytes)
      throw new Error('STEMは2〜16素材のWAV/FLAC、各100 MiB・合計400 MiBまでです。');
    const descriptors: StemDescriptor[] = [];
    for (const entry of entries) {
      self.postMessage({ type: 'stem-progress', fraction: descriptors.length / entries.length * 0.15, text: `${entry.file.name} の形式を確認しています…` });
      const raw = await entry.file.arrayBuffer();
      const info = /\.flac$/i.test(entry.file.name) ? readFlacMetadata(raw) : readWavMetadata(raw);
      descriptors.push({ id: entry.id, name: entry.file.name, role: entry.role, vocalRole: entry.vocalRole, restorationEnabled:entry.restorationEnabled, gainDb: entry.gainDb, pan: entry.pan, muted: entry.muted, ...info });
    }
    const sampleRate = descriptors[0].sampleRate, frames = Math.max(...descriptors.map(t => t.frames));
    self.postMessage({ type: 'stem-capacity', tracks: descriptors.length, sampleRate, seconds: frames / sampleRate,
      maxSeconds: Math.min(600, STEM_LIMITS.maxBusBytes / (8 * sampleRate)),
      sourceMiB: descriptors.reduce((n, t) => n + t.frames * t.channels * 4, 0) / (1024 * 1024), busMiB: frames * 8 / (1024 * 1024) });
    let balance: ReturnType<typeof planStemBalance> | undefined;
    let masking: ReturnType<typeof planStemMasking> | undefined;
    if (request.autoBalance && request.mode === 'vocal-instrumental') {
      const features = [];
      for (const [i, entry] of entries.entries()) {
        self.postMessage({ type: 'stem-progress', fraction: 0.15 + i / entries.length * 0.2,
          text: `${i + 1}/${entries.length} · 声と伴奏の帯域を調べています…` });
        const audio = await decodeEntry(entry);
        features.push(analyzePerceptualFeatures(audio));
      }
      balance = planStemBalance(descriptors, features);
      descriptors.forEach((descriptor, index) => { descriptor.gainDb = balance!.tracks[index].gainDb; });
      masking = planStemMasking(descriptors, features, balance);
      if (masking.status === 'proposed') descriptors.find(descriptor => descriptor.id === masking!.instrumentalId)!.presenceDip = masking.dip;
      self.postMessage({ type: 'stem-progress', fraction: 0.35, text: balance.explanation });
    }
    const session = createStemMixSession(descriptors, request.mode, undefined, masking);
    for (const [i, entry] of entries.entries()) {
      self.postMessage({ type: 'stem-progress', fraction: 0.35 + i / entries.length * 0.55, text: `${i + 1}/${entries.length} · ${entry.file.name} を読み込み・解析しています…` });
      const audio = await decodeEntry(entry);
      session.addTrack(entry.id, audio);
      // Only the accumulated bus/report is retained, not a copy of every source PCM.
    }
    self.postMessage({ type: 'stem-progress', fraction: 0.9, text: '素材を合成して、ピークと音量を確認しています…' });
    const result = session.finish();
    if (balance) result.report.autoBalance = balance;
    self.postMessage({ type: 'stem-result', ...result }, { transfer: result.audio.channels.map(c => c.buffer as ArrayBuffer) });
  } finally { working = false; pendingFlac = undefined; }
}
/** Separate import adapter, sharing the versioned processing Worker entry point. */
export function handleStemWorkerMessage(request: unknown): request is StemWorkerRequest {
  if (!request || typeof request !== 'object' || !('kind' in request)) return false;
  const data = request as StemWorkerRequest;
  if (data.kind === 'stem-repair-preview') {
    void renderFileStemRepair(data.entry,data.studio,data.destination,decodeEntry).then(result=>{
      const transfer='audio' in result ? result.audio.channels.map(ch=>ch.buffer as ArrayBuffer) : [];
      self.postMessage({type:'stem-repair-result',...result},{transfer});
    }).catch(error=>self.postMessage({type:'error',message:error instanceof Error?error.message:'素材の補修比較を準備できませんでした。'}));
    return true;
  }
  if (data.kind === 'file-stems') {
    void importFileStems(data.tracks, data.mode, data.autoBalance, data.destination, data.studio, data.reference, decodeEntry, data.clarity, data.vocalSupport)
      .then(result => {
        const channels = [...('audio' in result ? result.audio.channels : []), ...(result.audition?.dry.channels ?? []), ...(result.audition?.studio.channels ?? [])];
        self.postMessage({ type: 'stem-result', studioCompared: !!data.studio || !!data.clarity, ...result }, { transfer: channels.map(ch => ch.buffer as ArrayBuffer) });
      })
      .catch(error => self.postMessage({ type: 'error', message: error instanceof Error ? error.message : '長尺STEMを読み込めませんでした。' }));
    return true;
  }
  if (data.kind === 'stems-import') {
    void importStems(data).catch(error => self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'STEMを読み込めませんでした。' }));
    return true;
  }
  if (data.kind === 'stems-flac-result') {
    if (pendingFlac?.id === data.id) {
      const callback = pendingFlac; pendingFlac = undefined;
      if (data.audio) callback.resolve(data.audio); else callback.reject(new Error(data.error ?? 'FLACを読み込めませんでした。'));
    }
    return true;
  }
  return false;
}
