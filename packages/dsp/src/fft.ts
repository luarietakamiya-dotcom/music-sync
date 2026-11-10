/** In-place radix-2 transform. Buffers are allocated once per analyzer. */
export function fft(re: Float64Array, im: Float64Array): void {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; }
  }
  for (let length = 2; length <= N; length *= 2) {
    const ar = Math.cos(-2 * Math.PI / length), ai = Math.sin(-2 * Math.PI / length);
    for (let start = 0; start < N; start += length) {
      let wr = 1, wi = 0;
      for (let j = 0; j < length / 2; j++) {
        const a = start + j, b = a + length / 2, tr = wr * re[b] - wi * im[b], ti = wr * im[b] + wi * re[b];
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const next = wr * ar - wi * ai; wi = wr * ai + wi * ar; wr = next;
      }
    }
  }
}
