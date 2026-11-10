type WorkerKind = 'analysis' | 'processing' | 'export' | 'project' | 'batch' | 'batch-export';
const unavailable = '処理プログラムを読み込めませんでした。原音は保持しています。接続を確認し、画面を再読み込みしてください。';
/** Resolve each job against the current deployment, never a cached asset name.
 * Protocol changes require a reload rather than mixing incompatible messages. */
export async function openAudioWorker(kind: WorkerKind, fallback: URL): Promise<Worker> {
  let url = fallback;
  const manifestUrl = new URL('workers.json', document.baseURI);
  let response: Response;
  try { response = await fetch(manifestUrl, { cache: 'no-store', signal: AbortSignal.timeout(8000) }); }
  catch { throw new Error(unavailable); }
  // Dev mode has no manifest; production emits one next to index.html.
  if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
    const manifest = await response.json();
    if (manifest.protocol !== 1 || typeof manifest[kind] !== 'string') throw new Error('画面と処理プログラムのバージョンが一致しません。原音は保持しています。画面を再読み込みしてください。');
    url = new URL(manifest[kind], manifestUrl);
    if (url.origin !== location.origin || !url.pathname.startsWith(new URL('.', manifestUrl).pathname) || !url.pathname.endsWith('.js')) throw new Error(unavailable);
  }
  let asset: Response;
  try { asset = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(8000) }); }
  catch { throw new Error(unavailable); }
  if (!asset.ok || !/(javascript|ecmascript)/i.test(asset.headers.get('content-type') ?? '')) throw new Error(unavailable);
  return new Worker(url, { type: 'module' });
}
