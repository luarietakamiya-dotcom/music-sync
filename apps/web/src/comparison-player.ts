import { COMPARISON_POLICY, type AudioData, type ComparisonSlot } from '@music-sync/core';

interface Envelope { from: number; to: number; start: number; end: number }
interface Voice { source: AudioBufferSourceNode; gain: GainNode; envelope: Envelope }
export interface PlaybackSource { audio?: AudioData; file?: File }
const slots: ComparisonSlot[] = ['a', 'b'];
const linear = (db: number) => 10 ** (db / 20);

function holdGain(parameter: AudioParam, time: number, value: number): void {
  // Retain the interrupted ramp's endpoint, then anchor the next ramp here.
  // An explicit anchor is also needed when the previous ramp ended long ago.
  parameter.cancelScheduledValues(time);
  parameter.linearRampToValueAtTime(value, time);
  parameter.setValueAtTime(value, time);
}

/** Linear ramps preserve the gain at interruption, including rapid A/B switches. */
export function envelopeAt(envelope: Envelope, time: number): number {
  if (time >= envelope.end) return envelope.to;
  if (time <= envelope.start) return envelope.from;
  return envelope.from + (envelope.to - envelope.from) * (time - envelope.start) / (envelope.end - envelope.start);
}

/** Browser-only adapter: both sources use the same clock, start time and offset. */
export class ComparisonPlayer {
  private buffers: Partial<Record<ComparisonSlot, AudioBuffer>> = {};
  private voices: Partial<Record<ComparisonSlot, Voice>> = {};
  private inputs: Partial<Record<ComparisonSlot, PlaybackSource>> = {};
  private gainsDb = { a: 0, b: 0 };
  private selected: ComparisonSlot = 'a';
  private volume = 0.5;
  private offset = 0;
  private startedAt = 0;
  private epoch = 0;
  private active = false;
  private pending = false;
  private duration = 0;
  private media?: HTMLAudioElement;
  private alternate?: HTMLAudioElement;
  private alternateUrl?: string;
  private mediaUrl?: string;

  constructor(private readonly context: BaseAudioContext) {}

  get playing(): boolean { return this.active || (!!this.media && this.pending); }
  get durationSeconds(): number { return this.duration; }
  get positionSeconds(): number {
    if (this.media) return Math.min(this.duration, this.media.currentTime || 0);
    return Math.min(this.duration, this.offset + (this.active ? Math.max(0, this.context.currentTime - this.startedAt) : 0));
  }

  setSources(inputs: Partial<Record<ComparisonSlot, PlaybackSource>>, duration: number): void {
    this.stop();
    if (!Number.isFinite(duration) || duration < 0) throw new Error('Invalid playback duration');
    this.inputs = inputs; this.duration = duration; this.buffers = {};
    if (this.media) { this.media.onended = null; this.media.removeAttribute('src'); this.media.load(); this.media = undefined; }
    if (this.alternate) { this.alternate.onended = null; this.alternate.removeAttribute('src'); this.alternate.load(); this.alternate = undefined; }
    if (this.alternateUrl) { URL.revokeObjectURL(this.alternateUrl); this.alternateUrl = undefined; }
    if (this.mediaUrl) { URL.revokeObjectURL(this.mediaUrl); this.mediaUrl = undefined; }
    if (inputs.a?.file) {
      this.selected = 'a';
      if (inputs.b?.file) {
        this.alternateUrl = URL.createObjectURL(inputs.b.file);
        this.alternate = new Audio(this.alternateUrl);
        this.alternate.preload = 'metadata';
        this.alternate.onended = () => { this.active = false; };
      }
      this.mediaUrl = URL.createObjectURL(inputs.a.file);
      this.media = new Audio(this.mediaUrl);
      this.media.preload = 'metadata';
      this.media.onended = () => { this.active = false; this.offset = 0; };
    }
  }

  configure(selected: ComparisonSlot, gainsDb: Record<ComparisonSlot, number>, volume: number): void {
    if (!['a', 'b'].includes(selected) || !Number.isFinite(volume) || volume < 0 || volume > 1 ||
      Object.values(gainsDb).some(db => !Number.isFinite(db) || db > 0 || db < -1100))
      throw new Error('Invalid monitoring gain');
    const swap = selected !== this.selected && this.media && this.alternate;
    this.selected = selected; this.gainsDb = { ...gainsDb }; this.volume = volume;
    if (this.media) {
      if (swap && this.alternate) {
        const position = this.positionSeconds;
        const resume = this.active || this.pending;
        this.epoch++; this.pending = false; this.active = false;
        this.media.pause();
        [this.media, this.alternate] = [this.alternate, this.media];
        this.media.currentTime = position;
        if (resume) void this.play().catch(() => { this.active = false; });
      }
      this.media.volume = Math.min(1, this.targetGain(selected));
      return;
    }
    const now = this.context.currentTime;
    // Before a scheduled start, gains are still silent. Start both ramps together.
    const rampStart = this.active ? Math.max(now, this.startedAt) : now;
    for (const slot of slots) {
      const voice = this.voices[slot];
      if (!voice) continue;
      const value = envelopeAt(voice.envelope, rampStart), target = this.targetGain(slot);
      const end = rampStart + COMPARISON_POLICY.rampSeconds;
      holdGain(voice.gain.gain, rampStart, value);
      voice.gain.gain.linearRampToValueAtTime(target, end);
      voice.envelope = { from: value, to: target, start: rampStart, end };
    }
  }

  private targetGain(slot: ComparisonSlot): number {
    return slot === this.selected ? linear(this.gainsDb[slot]) * this.volume : 0;
  }

  async play(): Promise<void> {
    if (this.active || this.pending || !this.inputs.a || this.duration <= 0) return;
    if (this.media) {
      const epoch = ++this.epoch;
      this.pending = true;
      try {
        if (this.media.currentTime >= this.duration) this.media.currentTime = 0;
        await this.media.play();
        if (epoch !== this.epoch) return;
        this.active = true;
      } finally { if (epoch === this.epoch) this.pending = false; }
      return;
    }
    const epoch = ++this.epoch;
    this.pending = true;
    try {
      if ('resume' in this.context && !(this.context instanceof OfflineAudioContext)) await (this.context as AudioContext).resume();
      if (epoch !== this.epoch) return;
      if (this.offset >= this.duration) this.offset = 0;
      for (const slot of slots) {
        const input = this.inputs[slot];
        if (!input || this.buffers[slot]) continue;
        const { audio } = input;
        if (!audio) continue;
        const buffer = this.context.createBuffer(audio.channels.length, audio.channels[0].length, audio.sampleRate);
        audio.channels.forEach((channel, c) => buffer.copyToChannel(channel as Float32Array<ArrayBuffer>, c));
        this.buffers[slot] = buffer;
      }
      // Buffer allocation may take time: choose the common start afterwards.
      this.startedAt = this.context.currentTime + 0.025;
      this.active = true;
      const remaining = this.duration - this.offset;
      for (const slot of slots) {
        const buffer = this.buffers[slot];
        if (!buffer) continue;
        const source = this.context.createBufferSource(), gain = this.context.createGain();
        source.buffer = buffer;
        gain.gain.value = 0;
        source.connect(gain); gain.connect(this.context.destination);
        this.voices[slot] = { source, gain, envelope: { from: 0, to: 0, start: this.startedAt, end: this.startedAt } };
        source.onended = () => {
          source.disconnect(); gain.disconnect();
          if (epoch === this.epoch && slot === 'a') { this.active = false; this.offset = 0; }
          if (this.voices[slot]?.source === source) delete this.voices[slot];
        };
        source.start(this.startedAt, this.offset, remaining);
      }
      this.configure(this.selected, this.gainsDb, this.volume);
    } catch (error) { this.stop(); throw error; }
    finally { if (epoch === this.epoch) this.pending = false; }
  }

  pause(): void {
    if (this.media) { this.epoch++; this.pending = false; this.media.pause(); this.offset = this.media.currentTime; this.active = false; return; }
    this.offset = this.positionSeconds;
    this.releaseVoices();
  }

  stop(): void {
    if (this.media) { this.media.pause(); try { this.media.currentTime = 0; } catch { /* metadata may not be ready */ } this.active = false; this.pending = false; this.epoch++; }
    else this.releaseVoices();
    this.offset = 0;
  }

  async seek(seconds: number): Promise<void> {
    if (!Number.isFinite(seconds)) throw new Error('Invalid seek position');
    if (this.media) { this.media.currentTime = Math.min(this.duration, Math.max(0, seconds)); this.offset = this.media.currentTime; return; }
    const resume = this.active;
    this.releaseVoices();
    this.offset = Math.min(this.duration, Math.max(0, seconds));
    if (resume && this.offset < this.duration) await this.play();
  }

  private releaseVoices(): void {
    this.epoch++; this.active = false; this.pending = false;
    const now = this.context.currentTime;
    for (const voice of Object.values(this.voices)) {
      voice.source.onended = () => { voice.source.disconnect(); voice.gain.disconnect(); };
      const value = envelopeAt(voice.envelope, now);
      holdGain(voice.gain.gain, now, value);
      voice.gain.gain.linearRampToValueAtTime(0, now + COMPARISON_POLICY.rampSeconds);
      voice.source.stop(now + COMPARISON_POLICY.rampSeconds);
    }
    this.voices = {};
  }
}
