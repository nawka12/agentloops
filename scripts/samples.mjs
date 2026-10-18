// Rebuilds the note samples in ui/samples/{piano,sax}: Salamander Grand Piano V3 (CC BY 3.0, Alexander Holm) and
// University of Iowa alto sax. The MP3s are committed; this script only exists so they can be rebuilt. Needs ffmpeg, curl, tar.
// Usage: node scripts/samples.mjs [cacheDir]. Downloads land in cacheDir and are only read by ffmpeg/tar, never run.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cache = process.argv[2] ?? join(tmpdir(), "agentloops-samples");
const out = fileURLToPath(new URL("../ui/samples/", import.meta.url));
const SR = 44100;
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const roots = (a, b) => Array.from({ length: (b - a) / 3 + 1 }, (_, i) => a + 3 * i);
// Piano stops at 105: the Salamander C8 recording measures ~+125 cents sharp, so it fails the pitch check. C8 plays root 105 pitched up.
const PIANO_ROOTS = roots(21, 105), SAX_ROOTS = roots(49, 79);
const PIANO_URL = "https://freepats.zenvoid.org/Piano/SalamanderGrandPiano/SalamanderGrandPianoV3+20161209_44khz16bit.tar.xz";
const PIANO_DIR = "SalamanderGrandPianoV3_44.1khz16bit/44.1khz16bit/";
const SAX = [["Db3B3", 49, 11], ["C4B4", 60, 12], ["C5Ab5", 72, 9]]; // [range, first midi, notes in file]
const SAX_URL = (layer, range) => `https://theremin.music.uiowa.edu/sound%20files/MIS/Woodwinds/altosaxophone/AltoSax.Vib.${layer}.${range}.aiff`;
const ENC = ["-ac", "1", "-ar", String(SR), "-c:a", "libmp3lame", "-b:a", "80k"];
const PIANO_CHAIN = "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0,atrim=duration=8,afade=t=out:st=6.5:d=1.5";
const SAX_CHAIN = "silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0,areverse,afade=t=in:d=0.05,areverse";

const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}): ${r.stderr.toString().slice(-500)}`);
  return r;
};
const ff = (args) => sh("ffmpeg", ["-hide_banner", "-nostats", "-y", ...args]);
const pianoName = (m) => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;

function fetchTo(url, name) {
  const dest = join(cache, name);
  if (!existsSync(dest)) {
    mkdirSync(cache, { recursive: true });
    sh("curl", ["-sSfL", "-o", `${dest}.part`, url]);
    renameSync(`${dest}.part`, dest);
  }
  return dest;
}

// Two passes: volumedetect finds the peak, then the gain brings it to -3 dBFS. The cut goes before -i: as an output
// option it would apply after the filters, and silenceremove has already shifted the timeline by then.
function encode(src, cut, chain, dest) {
  const input = [...cut, "-i", src];
  const det = ff([...input, "-af", `${chain},volumedetect`, "-f", "null", "-"]).stderr.toString();
  const peak = +/max_volume: (-?[\d.]+) dB/.exec(det)[1];
  ff([...input, "-af", `${chain},volume=${(-3 - peak).toFixed(2)}dB`, ...ENC, dest]);
}

// Note = the sound between two silences (silencedetect at -40 dB, 0.25 s). Asserts the expected count.
function regions(file, want) {
  const log = sh("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "silencedetect=noise=-40dB:d=0.25", "-f", "null", "-"]).stderr.toString();
  const [, h, mi, se] = /Duration: (\d+):(\d+):([\d.]+)/.exec(log);
  const dur = +h * 3600 + +mi * 60 + +se;
  const sil = [];
  for (const [, k, t] of log.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    if (k === "start") sil.push({ s: +t, e: dur });
    else sil[sil.length - 1].e = +t;
  }
  const segs = [];
  let t = 0;
  for (const x of sil) {
    if (x.s - t > 0.5) segs.push([t, x.s]);
    t = x.e;
  }
  if (dur - t > 0.5) segs.push([t, dur]);
  if (segs.length !== want) throw new Error(`${file}: ${segs.length} notes found, want ${want}`);
  return segs;
}

// Piano: extract only the 58 layer files needed, in one pass over the 412 MB archive.
const pianoDir = join(cache, "piano-src");
const pianoWav = (m, layer) => `${PIANO_DIR}${pianoName(m)}${layer}.wav`;
const needed = PIANO_ROOTS.flatMap((m) => [pianoWav(m, "v10"), pianoWav(m, "v5")]).filter((p) => !existsSync(join(pianoDir, p)));
if (needed.length) {
  mkdirSync(pianoDir, { recursive: true });
  sh("tar", ["-xJf", fetchTo(PIANO_URL, "piano.tar.xz"), "-C", pianoDir, ...needed]);
}

const made = [];
const emit = (sound, m, suffix, src, cut, chain, maxSec) => {
  const dest = join(out, sound, `${m}${suffix}.mp3`);
  encode(src, cut, chain, dest);
  made.push({ sound, m, file: dest, maxSec, src, cut, chain });
};

rmSync(join(out, "piano"), { recursive: true, force: true });
rmSync(join(out, "sax"), { recursive: true, force: true });
mkdirSync(join(out, "piano"), { recursive: true });
mkdirSync(join(out, "sax"), { recursive: true });
for (const m of PIANO_ROOTS) {
  emit("piano", m, "", join(pianoDir, pianoWav(m, "v10")), [], PIANO_CHAIN, 8); // mf
  emit("piano", m, "-p", join(pianoDir, pianoWav(m, "v5")), [], PIANO_CHAIN, 8); // soft
}

for (const [layer, suffix] of [["mf", ""], ["pp", "-p"]]) {
  for (const [range, first, count] of SAX) {
    const file = fetchTo(SAX_URL(layer, range), `AltoSax.Vib.${layer}.${range}.aiff`);
    const segs = regions(file, count);
    for (const m of SAX_ROOTS) {
      if (m < first || m >= first + count) continue;
      emit("sax", m, suffix, file, ["-ss", String(segs[m - first][0]), "-to", String(segs[m - first][1])], SAX_CHAIN, 0);
    }
  }
}

// Self-check: decode each MP3 and compare its pitch class to the midi number in its name.
// Decoded at 4x so high notes have enough lag resolution. The lag search is +-10% around the expected period
// (a note a semitone off still lands inside it and fails; anything further out fails with no peak).
const RATE = 4 * SR;
function decode(file) {
  const b = sh("ffmpeg", ["-hide_banner", "-v", "error", "-i", file, "-f", "f32le", "-ac", "1", "-ar", String(RATE), "-"]).stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}

// Autocorrelation on 0.5 s starting at 0.15 s. Takes the first lag that is a local max near the best peak,
// so a multiple of the period is not picked. Parabolic interpolation for sub-sample lags.
function pitch(x, want) {
  const n = Math.round(0.5 * RATE), w = x.subarray(Math.round(0.15 * RATE), Math.round(0.15 * RATE) + n);
  const exp = RATE / want, lo = Math.floor(exp * 0.9), hi = Math.ceil(exp * 1.1);
  const r = new Float64Array(hi + 2);
  for (let L = lo - 1; L <= hi + 1; L++) {
    let xy = 0, e0 = 0, e1 = 0;
    for (let i = 0; i + L < n; i++) {
      const a = w[i], b = w[i + L];
      xy += a * b; e0 += a * a; e1 += b * b;
    }
    r[L] = xy / Math.sqrt(e0 * e1 + 1e-12);
  }
  let best = 0;
  for (let L = lo; L <= hi; L++) best = Math.max(best, r[L]);
  for (let L = lo; L <= hi; L++) {
    if (r[L] >= 0.9 * best && r[L] >= r[L - 1] && r[L] >= r[L + 1]) {
      const d = 0.5 * (r[L - 1] - r[L + 1]) / (r[L - 1] - 2 * r[L] + r[L + 1]);
      return RATE / (L + d);
    }
  }
  throw new Error("no pitch peak");
}

// The Iowa player drifts sharp up high (+20 to +50 cents from G4 up): retune each sax note to equal temperament from its pitch
// mid-note. asetrate moves pitch and length together, by a few percent at most. The piano's sharp top is stretch tuning, so it stays.
for (const s of made.filter((s) => s.sound === "sax")) {
  const want = 440 * 2 ** ((s.m - 69) / 12), r = want / pitch(decode(s.file).subarray(Math.round(0.45 * RATE)), want);
  if (Math.abs(1200 * Math.log2(r)) > 3) encode(s.src, s.cut, `asetrate=${(SR * r).toFixed(1)},aresample=${SR},${s.chain}`, s.file);
}

const stats = { piano: { n: 0, bytes: 0, worst: 0, at: 0 }, sax: { n: 0, bytes: 0, worst: 0, at: 0 } };
for (const { sound, m, file, maxSec } of made) {
  const size = statSync(file).size;
  if (size === 0) throw new Error(`${file}: empty`);
  const x = decode(file);
  const peak = x.reduce((p, v) => Math.max(p, Math.abs(v)), 0);
  if (!(peak > 0.01 && peak < 1)) throw new Error(`${file}: peak ${peak}`);
  if (maxSec && x.length > (maxSec + 0.1) * RATE) throw new Error(`${file}: ${(x.length / RATE).toFixed(2)} s`);
  if (sound === "sax") { // a held note: at least 1.5 s within 12 dB of its loudest 100 ms (a cut that misses the note leaves a decaying tail)
    const w = RATE / 10, db = [];
    for (let i = 0; i + w <= x.length; i += w) { let e = 0; for (let j = i; j < i + w; j++) e += x[j] * x[j]; db.push(10 * Math.log10(e / w + 1e-12)); }
    const held = db.filter((d) => d > Math.max(...db) - 12).length / 10;
    if (held < 1.5) throw new Error(`${file}: holds for only ${held} s`);
  }
  const want = 440 * 2 ** ((m - 69) / 12);
  let c = 1200 * Math.log2(pitch(x, want) / want);
  c = ((c % 1200) + 1800) % 1200 - 600; // [-600, 600): octave errors are fine, a split off by one note is not
  if (Math.abs(c) > 50) throw new Error(`${file}: ${c.toFixed(1)} cents off midi ${m}`);
  const s = stats[sound];
  s.n++; s.bytes += size;
  if (Math.abs(c) > s.worst) { s.worst = Math.abs(c); s.at = m; }
}
for (const [sound, s] of Object.entries(stats)) {
  if (s.bytes > 6e6) throw new Error(`${sound}: ${s.bytes} bytes, over the 6 MB budget`);
  console.log(`${sound}: ${s.n} files, ${(s.bytes / 1e6).toFixed(2)} MB, worst ${s.worst.toFixed(1)} cents (midi ${s.at})`);
}
