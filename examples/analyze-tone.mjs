// A separate Node consumer: imports the built public package, never the Web app.
import { analyzeAudio } from '@music-sync/core';
const sampleRate = 48000;
const samples = Float32Array.from({ length: sampleRate }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 1000 * i / sampleRate));
const report = analyzeAudio({ sampleRate, channels: [samples] });
if (Math.abs(report.samplePeakDbfs + 20) > 0.001) throw new Error('Unexpected sample peak');
console.log(JSON.stringify({ integratedLufs: report.integratedLufs, samplePeakDbfs: report.samplePeakDbfs, crestFactorDb: report.crestFactorDb }, null, 2));
