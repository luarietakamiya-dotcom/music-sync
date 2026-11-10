import { ComparisonPlayer } from '../../apps/web/src/comparison-player';
import { analyzeAudio, createComparisonPlan, type ComparisonSlot } from '@music-sync/core';

interface Scenario {
  kind: 'impulses' | 'tone' | 'dc';
  matched?: boolean;
  seek?: number;
  switches?: { at: number; slot: ComparisonSlot; toggleMatch?: boolean }[];
}

async function renderScenario(scenario: Scenario) {
  const sr = 48000, frames = sr;
  const a = new Float32Array(frames), b = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    a[i] = scenario.kind === 'tone' ? 0.3 * Math.sin(2 * Math.PI * 1000 * i / sr) : scenario.kind === 'dc' ? 0.3 : 0;
    b[i] = a[i] * 2;
  }
  if (scenario.kind === 'impulses') for (const i of [4800, 14400, 24000, 33600, 43200]) { a[i] = 0.3; b[i] = 0.6; }
  const aAudio = { sampleRate: sr, channels: [a] }, bAudio = { sampleRate: sr, channels: [b] };
  const aBefore = a.slice(), bBefore = b.slice();
  const context = new OfflineAudioContext(1, sr * 1.15, sr);
  const player = new ComparisonPlayer(context);
  const plan = createComparisonPlan(analyzeAudio(aAudio), analyzeAudio(bAudio));
  player.setSources({ a: { audio: aAudio }, b: { audio: bAudio } }, 1);
  let matched = !!scenario.matched;
  player.configure('a', { ...(matched ? plan.match.gainsDb : plan.rawGainsDb) }, 1);
  if (scenario.seek) await player.seek(scenario.seek);
  await player.play();
  const positions: { before: number; after: number }[] = [];
  const suspensions = (scenario.switches ?? []).map(change => context.suspend(change.at).then(() => {
    const before = player.positionSeconds;
    if (change.toggleMatch) matched = !matched;
    player.configure(change.slot, { ...(matched ? plan.match.gainsDb : plan.rawGainsDb) }, 1);
    positions.push({ before, after: player.positionSeconds });
    void context.resume();
  }));
  const rendered = await context.startRendering();
  await Promise.all(suspensions);
  return { pcm: Array.from(rendered.getChannelData(0)), sampleRate: sr, positions,
    sourceUnchanged: a.every((x, i) => x === aBefore[i]) && b.every((x, i) => x === bBefore[i]) };
}

declare global { interface Window { renderScenario: typeof renderScenario } }
window.renderScenario = renderScenario;
