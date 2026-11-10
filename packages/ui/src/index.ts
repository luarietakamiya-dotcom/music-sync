import type { WaveformChannel } from '@music-sync/shared';

export function drawWaveform(canvas: HTMLCanvasElement, channels: readonly WaveformChannel[], progress = 0): void {
  const ratio = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(ratio, ratio);
  const lane = height / Math.max(channels.length, 1);
  channels.forEach((channel, c) => {
    const center = lane * (c + 0.5), amplitude = lane * 0.38;
    ctx.strokeStyle = '#24303a'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, center); ctx.lineTo(width, center); ctx.stroke();
    const count = channel.min.length;
    for (let i = 0; i < count; i++) {
      const x = (i + 0.5) * width / count;
      ctx.strokeStyle = i / count < progress ? '#d8fa89' : '#7ab7ac';
      ctx.lineWidth = Math.max(1, width / count * 0.65);
      ctx.beginPath();
      ctx.moveTo(x, center - Math.min(1, channel.max[i]) * amplitude);
      ctx.lineTo(x, center - Math.max(-1, channel.min[i]) * amplitude);
      ctx.stroke();
    }
  });
  if (progress > 0) {
    ctx.strokeStyle = '#ecf7da'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(progress * width, 0); ctx.lineTo(progress * width, height); ctx.stroke();
  }
}

export function formatMetric(value: number | null, decimals = 1): string {
  return value === null ? '—' : value.toFixed(decimals);
}
