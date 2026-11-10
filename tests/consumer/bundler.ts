import { analyzeAudio, defaultProcessingChain, processAudio, encodeFloatWav, autoMixMaster, applySoundColor } from '@music-sync/core';
const input = { sampleRate: 48000, channels: [Float32Array.from({ length: 24000 }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 1000 * i / 48000))] };
const chain = defaultProcessingChain(); chain.gainDb = 3;
const output = processAudio(input, chain).audio;
const finishing = autoMixMaster(input, 'LIVE');
const colour = applySoundColor(input, { preset: 'cassette', intensity: 'standard' });
document.body.dataset.result = JSON.stringify({ gain: analyzeAudio(output).integratedLufs! - analyzeAudio(input).integratedLufs!, bytes: encodeFloatWav(output).byteLength, autoStatus: finishing.status, perceptualVersion: finishing.perceptual.version, objectiveAccepted: finishing.attempts.at(-1)?.objectiveQuality.accepted, colourStatus: colour.status, colourClipped: colour.attempts.at(-1)?.after.clippedSamples });
