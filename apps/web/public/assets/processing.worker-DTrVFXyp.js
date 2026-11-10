// Compatibility entry for an already-open 0.7.0 tab. No PCM leaves this origin.
// The worker protocol is unchanged; resolve current code without losing Original.
const pending = [];
const hold = event => pending.push(event);
self.onmessage = hold;
try {
  const manifestUrl = new URL('../workers.json', import.meta.url);
  const response = await fetch(manifestUrl, { cache: 'no-store' });
  const manifest = await response.json();
  if (manifest.protocol !== 1 || typeof manifest.processing !== 'string') throw new Error('画面を再読み込みしてください。');
  const url = new URL(manifest.processing, new URL('../', import.meta.url));
  if (url.origin !== self.location.origin || !url.pathname.endsWith('.js')) throw new Error('処理プログラムを読み込めませんでした。');
  await import(url.href);
  const handle = self.onmessage;
  if (handle === hold) throw new Error('処理プログラムを開始できませんでした。');
  for (const event of pending) handle.call(self, event);
} catch (error) {
  self.postMessage({ type: 'error', message: `${error instanceof Error ? error.message : '処理プログラムを読み込めませんでした。'} 原音は保持しています。` });
}
