import type { AudioData } from '@music-sync/shared';

export type LiveVenueId = 'live-house' | 'concert-hall' | 'arena';
export interface VenueParameters {
  venue: LiveVenueId; wet: number; highpassHz: number; decaySeconds: number; preDelayMs: number;
}
const spaces = {
  'live-house': { early: [0.009, 0.017, 0.029, 0.041, 0.057], lines: [0.0213, 0.0257, 0.0311, 0.0379, 0.0433, 0.0497, 0.0563, 0.0629], earlyGain: 0.8, lateGain: 0.65 },
  'concert-hall': { early: [0.019, 0.033, 0.053, 0.081, 0.109], lines: [0.0311, 0.0379, 0.0433, 0.0539, 0.0617, 0.0713, 0.0797, 0.0893], earlyGain: 0.65, lateGain: 0.85 },
  arena: { early: [0.037, 0.071, 0.113, 0.167, 0.229], lines: [0.0539, 0.0677, 0.0793, 0.0911, 0.1033, 0.1171, 0.1319, 0.1493], earlyGain: 0.5, lateGain: 0.95 },
} as const;

/** Eight-line damped Householder FDN per channel, plus stage reflections.
 * Original dry path stays at unity, with no fixed delay or stereo widening.
 * Ring memory depends on sample rate/venue, never on the song duration.
 */
export function applyVenueToOwned(audio: AudioData, p: VenueParameters): void {
  const frames = audio.channels[0].length;
  const levels = audio.channels.map(channel => Math.sqrt(channel.reduce((sum, x) => sum + x * x, 0) / frames));
  const process = createVenueStream(audio.sampleRate, frames, levels, p);
  process(audio);
}

/** Processes consecutive, exclusively owned blocks of a song. */
export function createVenueStream(sr: number, totalFrames: number, rmsLevels: number[], p: VenueParameters): (chunk: AudioData) => void {
  if (!Object.hasOwn(spaces, p.venue) || !Number.isFinite(p.wet) || p.wet < 0 || p.wet > 0.6 ||
    !Number.isFinite(p.highpassHz) || p.highpassHz < 120 || p.highpassHz > 600 ||
    !Number.isFinite(p.decaySeconds) || p.decaySeconds < 0.2 || p.decaySeconds > 2.5 ||
    !Number.isFinite(p.preDelayMs) || p.preDelayMs < 10 || p.preDelayMs > 40) throw new Error('Invalid live venue parameters');
  if (!p.wet) return () => {};
  const space = spaces[p.venue];
  const hpC = 1 - Math.exp(-2 * Math.PI * p.highpassHz / sr);
  const lpC = 1 - Math.exp(-2 * Math.PI * Math.min(7000, sr * 0.4) / sr);
  const dampingC = 1 - Math.exp(-2 * Math.PI * Math.min(4200, sr * 0.35) / sr);
  const weights = [0.38, 0.28, 0.2, 0.14, 0.1];
  let offset = 0;
  const processors = rmsLevels.map((rms, c) => {
    const predelay = Math.round(sr * p.preDelayMs / 1000);
    const taps = space.early.map((delay, j) => Math.max(1, Math.round(sr * (delay + c * 0.0023 * (j + 1)))));
    const history = new Float32Array(predelay + Math.max(...taps) + 1);
    const lines = space.lines.map((delay, j) => {
      const length = Math.max(1, Math.round(sr * (delay + c * 0.0019 * (j + 1))));
      const feedback = 10 ** (-3 * length / sr / p.decaySeconds);
      return { ring: new Float32Array(length), index: 0, damped: 0, feedback, injection: Math.sqrt(1 - feedback * feedback) };
    });
    const diffusers = [0.0047, 0.0083, 0.0131].map((delay, j) => ({
      ring: new Float32Array(Math.max(1, Math.round(sr * (delay + c * 0.0007 * (j + 1))))), index: 0,
    }));
    const values = new Float64Array(8);
    let low1 = 0, low2 = 0, filtered = 0, envelope = 0;
    const attack = Math.exp(-1 / (sr * 0.008)), release = Math.exp(-1 / (sr * 0.09));
    return (channel: Float32Array) => {
    for (let i = 0; i < channel.length; i++) {
      const dry = channel[i];
      low1 += hpC * (dry - low1); const upper = dry - low1;
      low2 += hpC * (upper - low2); filtered += lpC * (upper - low2 - filtered);
      const pos = (offset + i) % history.length; history[pos] = filtered;
      let early = 0;
      for (let j = 0; j < taps.length; j++) early += history[(pos - predelay - taps[j] + history.length) % history.length] * weights[j];
      let excitation = history[(pos - predelay + history.length) % history.length];
      // Diffuse the input before the network, rather than colouring the Dry path.
      for (const diffuser of diffusers) {
        const out = diffuser.ring[diffuser.index] - 0.65 * excitation;
        diffuser.ring[diffuser.index] = excitation + 0.65 * out;
        diffuser.index = (diffuser.index + 1) % diffuser.ring.length; excitation = out;
      }
      let sum = 0, late = 0;
      for (let j = 0; j < lines.length; j++) {
        const line = lines[j], value = line.ring[line.index];
        line.damped += dampingC * (value - line.damped); values[j] = line.damped; sum += line.damped;
        // Independent output signs avoid a persistent summed comb coloration.
        late += value * (j % 3 === 0 ? -1 : 1) / Math.sqrt(8);
      }
      const twiceMean = sum / 4;
      for (let j = 0; j < lines.length; j++) {
        const line = lines[j];
        line.ring[line.index] = (values[j] - twiceMean) * line.feedback + excitation * line.injection * (j % 2 ? -1 : 1);
        line.index = (line.index + 1) % line.ring.length;
      }
      const coefficient = Math.abs(dry) > envelope ? attack : release;
      envelope = coefficient * envelope + (1 - coefficient) * Math.abs(dry);
      // Level-relative ducking keeps the same room feel on quiet/loud recordings.
      const duck = 1 / (1 + 0.65 * envelope / Math.max(rms, 1e-8));
      const endFade = Math.min(1, (totalFrames - 1 - offset - i) / Math.max(1, sr * 0.12));
      channel[i] = dry + p.wet * duck * endFade * (space.earlyGain * early + space.lateGain * late);
    }
    };
  });
  return chunk => {
    chunk.channels.forEach((channel, c) => processors[c](channel));
    offset += chunk.channels[0].length;
  };
}
