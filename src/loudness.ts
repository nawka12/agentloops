// ITU-R BS.1770-4 / EBU R128 loudness of a 16-bit PCM WAV, whole and per span. The peak is a sample peak, not a true peak (no oversampling).

export type Span = [number, number]; // seconds

/** K-weighting (BS.1770 stage 1 high shelf, stage 2 high pass) as [b0, b1, b2, a1, a2] per stage, for any sample rate */
function kWeight(fs: number): number[][] {
  const K = Math.tan(Math.PI * 1681.974450955533 / fs), Vh = 10 ** (3.999843853973347 / 20), Vb = Vh ** 0.4996667741545416, Q = 0.7071752369554196, a0 = 1 + K / Q + K * K;
  const K2 = Math.tan(Math.PI * 38.13547087602444 / fs), Q2 = 0.5003270373238773, d = 1 + K2 / Q2 + K2 * K2;
  return [
    [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0],
    [1, -2, 1, 2 * (K2 * K2 - 1) / d, (1 - K2 / Q2 + K2 * K2) / d],
  ];
}

/** Loudness and sample peak (dBFS) of a WAV's samples in [a, b) frames; lufs null under 400 ms or when every block is gated out */
function one(y: Float32Array[], pcm: (i: number, c: number) => number, fs: number, a: number, b: number) {
  const L = Math.round(0.4 * fs), H = Math.round(0.1 * fs), ch = y.length;
  let peak = 0;
  for (let i = a; i < b; i++) for (let c = 0; c < ch; c++) peak = Math.max(peak, Math.abs(pcm(i, c)));
  const z: number[] = []; // per block: sum over channels of the mean square
  if (b - a >= L) {
    const sum = new Float64Array(ch); // running sums of squares over the window [s, s + L)
    for (let i = a; i < a + L; i++) for (let c = 0; c < ch; c++) sum[c] += y[c][i] * y[c][i];
    for (let s = a; s + L <= b; s += H) {
      if (s > a) for (let i = s - H; i < s - H + H; i++) for (let c = 0; c < ch; c++) sum[c] += y[c][i + L] * y[c][i + L] - y[c][i] * y[c][i];
      z.push(sum.reduce((p, q) => p + q, 0) / L);
    }
  }
  const lk = (v: number) => -0.691 + 10 * Math.log10(v), mean = (xs: number[]) => xs.reduce((p, q) => p + q, 0) / xs.length;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const abs = z.filter((v) => lk(v) > -70); // absolute gate
  let lufs: number | null = null;
  if (abs.length) {
    const rel = lk(mean(abs)) - 10; // relative gate: 10 LU below the ungated mean
    const kept = abs.filter((v) => lk(v) > rel);
    lufs = r1(lk(mean(kept)));
  }
  return { lufs, peakDb: peak > 0 ? r1(20 * Math.log10(peak / 32768)) : null };
}

/** Measure a 16-bit PCM WAV: the whole file, and each [startSec, endSec] span. The filter runs once; blocks must lie fully inside a span. */
export function measure(wav: Buffer, spans: Span[]) {
  const ch = wav.readUInt16LE(22), fs = wav.readUInt32LE(24), frames = Math.floor((wav.length - 44) / (2 * ch));
  const pcm = (i: number, c: number) => wav.readInt16LE(44 + 2 * (i * ch + c));
  const [s1, s2] = kWeight(fs), y: Float32Array[] = [];
  for (let c = 0; c < ch; c++) {
    const x = new Float32Array(frames);
    for (let i = 0; i < frames; i++) x[i] = pcm(i, c) / 32768;
    for (const [b0, b1, b2, a1, a2] of [s1, s2]) { // direct form I
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < frames; i++) { const v = x[i], o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = o; x[i] = o; }
    }
    y.push(x);
  }
  const at = (t: number) => Math.min(frames, Math.max(0, Math.round(t * fs)));
  return { ...one(y, pcm, fs, 0, frames), spans: spans.map(([s, e]) => one(y, pcm, fs, at(s), at(e))) };
}
