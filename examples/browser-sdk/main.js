import { analyzeAudio } from './music-sync-core.js';

document.querySelector('#run').addEventListener('click', () => {
  const result = document.querySelector('#result'), button = document.querySelector('#run');
  button.disabled = true;
  const audio = { sampleRate: 48000, channels: [Float32Array.from({ length: 24000 }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 1000 * i / 48000))] };
  const before = analyzeAudio(audio);
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => { result.textContent = JSON.stringify({ before: before.integratedLufs, ...data }, null, 2); worker.terminate(); button.disabled = false; };
  worker.onerror = () => { result.textContent = 'Workerの起動または処理に失敗しました。'; worker.terminate(); button.disabled = false; };
  // This demo no longer needs its PCM: transfer ownership rather than cloning.
  worker.postMessage(audio, audio.channels.map(c => c.buffer));
});
