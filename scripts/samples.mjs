// Rebuilds the note samples in ui/samples/{piano,sax,upright,vibes,trombone,trumpet,ride}: Salamander Grand Piano V3
// (CC BY 3.0, Alexander Holm) and University of Iowa Musical Instrument Samples. The MP3s are committed; this script only
// exists so they can be rebuilt. Needs ffmpeg, curl, tar.
// Usage: node scripts/samples.mjs [cacheDir [sound...]] (no sounds = all; the others' MP3s are left alone).
// Downloads land in cacheDir and are only read by ffmpeg/tar, never run.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cache = process.argv[2] ?? join(tmpdir(), "agentloops-samples");
const only = process.argv.slice(3), wanted = (sound) => !only.length || only.includes(sound);
const out = fileURLToPath(new URL("../ui/samples/", import.meta.url));
const SR = 44100;
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const roots = (a, b) => Array.from({ length: (b - a) / 3 + 1 }, (_, i) => a + 3 * i);
// Piano stops at 105: the Salamander C8 recording measures ~+125 cents sharp, so it fails the pitch check. C8 plays root 105 pitched up.
const PIANO_ROOTS = roots(21, 105);
const PIANO_URL = "https://freepats.zenvoid.org/Piano/SalamanderGrandPiano/SalamanderGrandPianoV3+20161209_44khz16bit.tar.xz";
const PIANO_DIR = "SalamanderGrandPianoV3_44.1khz16bit/44.1khz16bit/";
const IOWA = "https://theremin.music.uiowa.edu/sound%20files/MIS/";
const DECAY = (sec, db = -50) => `silenceremove=start_periods=1:start_threshold=${db}dB:start_silence=0,atrim=duration=${sec},afade=t=out:st=${sec * 0.75}:d=${sec * 0.25}`;
const ENC = ["-ac", "1", "-ar", String(SR), "-c:a", "libmp3lame", "-b:a", "80k"];
const PIANO_CHAIN = "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0,atrim=duration=8,afade=t=out:st=6.5:d=1.5";
const HORN = (db = -40) => `silenceremove=start_periods=1:start_threshold=${db}dB:start_silence=0,areverse,afade=t=in:d=0.05,areverse`;
// Iowa sets. files: [range, first midi, notes in file, lo, hi]; only roots in [lo, hi) (default: the whole file) come from it.
// A struck note rings down into the tape noise, so those sets split at a much lower level (sil). fix["layer.range"] = [sil, shortest
// note, midi notes the file lacks] for a file with noise blips that would pass for notes, or a note that was never recorded.
// horn = a held note (held check, retuned to equal temperament); decay = struck, cut at sec with a fade (attack check).
// tune = cents off at which a note is retuned; pitch false = unpitched.
const SETS = {
  sax: { kind: "horn", tune: 3, roots: roots(49, 79), url: (l, r) => `${IOWA}Woodwinds/altosaxophone/AltoSax.Vib.${l}.${r}.aiff`,
    files: [["Db3B3", 49, 11], ["C4B4", 60, 12], ["C5Ab5", 72, 9]] },
  trombone: { kind: "horn", tune: 3, sil: "-45dB:d=0.25", start: -60, // quiet: mf notes near -46 dB, pp lower
    roots: roots(40, 70), url: (l, r) => `${IOWA}Brass/tenortrombone/TenorTrombone.${l}.${r}.aiff`,
    files: [[" E2B2", 40, 8], ["C3B3", 48, 12], ["C4B4", 60, 12]] }, // the file name really has a space before E2B2
  trumpet: { kind: "horn", tune: 3, roots: roots(52, 85), url: (l, r) => `${IOWA}Brass/Bbtrumpet/Trumpet.vib.${l}.${r}.aiff`,
    files: [["E3B3", 52, 8], ["C4B4", 60, 12], ["C5B5", 72, 12], ["C6D6", 84, 3]] },
  // Each root comes from the string where it sits low on the neck: E 28-32, A 33-37, D 38-42, G 43-67.
  upright: { kind: "decay", sec: 4, tune: 10, sil: "-80dB:d=0.25", fix: {
    "mf.sulE.E1B1": ["-50dB:d=0.5"], "pp.sulE.E1B1": ["-50dB:d=0.5"], // noisy floor
    "pp.sulD.D2B2": ["-52dB:d=0.25", 1.1] }, // a finger-noise blip before the pp E2 is a segment of its own
    roots: roots(28, 67), url: (l, r) => `${IOWA}Strings/doublebass/Bass.pizz.${l}.${r}.aiff`,
    files: [["sulE.E1B1", 28, 8, 28, 33], ["sulA.A1B1", 33, 3], ["sulA.C2B2", 36, 12, 36, 38], ["sulD.D2B2", 38, 10, 38, 43],
      ["sulG.G2B2", 43, 5], ["sulG.C3B3", 48, 12], ["sulG.C4G4", 60, 8]] },
  vibes: { kind: "decay", sec: 6, tune: 10, hp: 80, start: -80, // the rumble below 100 Hz hides the silences, so the recordings are highpassed once
    sil: "-80dB:d=0.25", fix: { "mf.C3B3": [, 1], "pp.C3B3": [, 1], "pp.C4B4": [, 1], "mf.C6F6": [, 2], "pp.C6F6": [, , [85]] }, // the pp C6F6 file skips C#6
    roots: roots(48, 87), url: (l, r) => `${IOWA}Percussion/Vibraphone/Vibraphone.sustain.${l}.${r}.aif`,
    files: [["C3B3", 48, 12], ["C4B4", 60, 12], ["C5B5", 72, 12], ["C6F6", 84, 6]] },
  // One file per hit type, each holding `count` hits; the first is used. 51 is the bow, 53 the bell.
  ride: { kind: "decay", sec: 4, pitch: false, hp: 150, start: -95, loud: -40, sil: "-100dB:d=0.25", // the pp cymbal is quieter than the rumble
    roots: [51, 53], url: (l, r) => `${IOWA}Percussion/cymbals/suspended%20cymbals/stick/21ride.stick.${r}.${l}.aif`,
    files: [["normal", 51, 1], ["bell", 53, 1]] },
};

const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}): ${r.stderr.toString().slice(-500)}`);
  return r;
};
const ff = (args) => sh("ffmpeg", ["-hide_banner", "-nostats", "-y", ...args]);
const pianoName = (m) => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;

function fetchTo(url, name = decodeURIComponent(url.split("/").pop())) {
  const dest = join(cache, name);
  if (!existsSync(dest)) {
    mkdirSync(cache, { recursive: true });
    sh("curl", ["-sSfL", "-o", `${dest}.part`, url.replaceAll(" ", "%20")]);
    renameSync(`${dest}.part`, dest);
  }
  return dest;
}

// Two passes: volumedetect finds the peak, then the gain brings it to -3 dBFS. The cut goes before -i: as an output
// option it would apply after the filters, and silenceremove has already shifted the timeline by then.
// `loud` sets the mean level (dB) instead: a stick's click sets a cymbal hit's peak, so peak-normalized rides came out with pp 10 dB over mf.
function encode(src, cut, chain, dest, loud) {
  const input = [...cut, "-i", src];
  const det = ff([...input, "-af", `${chain},volumedetect`, "-f", "null", "-"]).stderr.toString();
  const peak = +/max_volume: (-?[\d.]+) dB/.exec(det)[1], gain = loud == null ? -3 - peak : loud - +/mean_volume: (-?[\d.]+) dB/.exec(det)[1];
  if (peak + gain > -1) throw new Error(`${dest}: would peak at ${(peak + gain).toFixed(1)} dBFS`);
  ff([...input, "-af", `${chain},volume=${gain.toFixed(2)}dB`, ...ENC, dest]);
}

// Rumble under the notes is cut from the whole recording once: a highpass started at each cut would begin with a step
// (the 50 ms fade-in hides the one at the start of the file).
function highpassed(file, hz) {
  const dest = `${file}.hp.wav`;
  if (hz && !existsSync(dest)) ff(["-i", file, "-af", `highpass=f=${hz},afade=t=in:d=0.05`, "-ac", "1", "-c:a", "pcm_s24le", dest]);
  return hz ? dest : file;
}

// Note = the sound between two silences (silencedetect, by default -40 dB for 0.25 s). Asserts the expected count.
function regions(file, want, det = "-40dB:d=0.25", min = 0.5) {
  const log = sh("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", `silencedetect=noise=${det}`, "-f", "null", "-"]).stderr.toString();
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
    if (x.s - t > min) segs.push([t, x.s]);
    t = x.e;
  }
  if (dur - t > min) segs.push([t, dur]);
  if (segs.length !== want) throw new Error(`${file}: ${segs.length} notes found, want ${want}`);
  return segs;
}

// Piano: extract only the 58 layer files needed, in one pass over the 412 MB archive.
const pianoDir = join(cache, "piano-src");
const pianoWav = (m, layer) => `${PIANO_DIR}${pianoName(m)}${layer}.wav`;
const needed = (wanted("piano") ? PIANO_ROOTS : []).flatMap((m) => [pianoWav(m, "v10"), pianoWav(m, "v5")]).filter((p) => !existsSync(join(pianoDir, p)));
if (needed.length) {
  mkdirSync(pianoDir, { recursive: true });
  sh("tar", ["-xJf", fetchTo(PIANO_URL, "piano.tar.xz"), "-C", pianoDir, ...needed]);
}

const made = [];
const emit = (sound, m, suffix, src, cut, chain, maxSec, loud) => {
  const dest = join(out, sound, `${m}${suffix}.mp3`);
  encode(src, cut, chain, dest, loud);
  made.push({ sound, m, file: dest, maxSec, src, cut, chain });
};

const fresh = (sound) => { rmSync(join(out, sound), { recursive: true, force: true }); mkdirSync(join(out, sound), { recursive: true }); };
if (wanted("piano")) {
  fresh("piano");
  for (const m of PIANO_ROOTS) {
    emit("piano", m, "", join(pianoDir, pianoWav(m, "v10")), [], PIANO_CHAIN, 8); // mf
    emit("piano", m, "-p", join(pianoDir, pianoWav(m, "v5")), [], PIANO_CHAIN, 8); // soft
  }
}

for (const [sound, S] of Object.entries(SETS)) {
  if (!wanted(sound)) continue;
  fresh(sound);
  for (const [layer, suffix] of [["mf", ""], ["pp", "-p"]]) {
    for (const [range, first, count, lo = first, hi = first + count] of S.files) {
      const rs = S.roots.filter((m) => m >= lo && m < hi);
      if (!rs.length) continue;
      const file = highpassed(fetchTo(S.url(layer, range)), S.hp);
      const [sil = S.sil, min, gone = []] = S.fix?.[`${layer}.${range}`] ?? [];
      const segs = regions(file, count - gone.length, sil, min);
      for (const m of rs) {
        const seg = segs[m - first - gone.filter((g) => g < m).length];
        const cut = ["-ss", String(seg[0]), "-to", String(seg[1])];
        emit(sound, m, suffix, file, cut, S.kind === "horn" ? HORN(S.start) : DECAY(S.sec, S.start), S.kind === "horn" ? 0 : S.sec, S.loud);
      }
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

// Struck sounds ring with sympathetic strings and hum (the soft bass notes carry a steady ~300 Hz tone) that fool the
// autocorrelation, so take the strongest partial within +-80 cents of the note instead: the hum sits further away than that.
// A split off by a semitone puts the peak on the edge of the range, which fails the +-50 cent check.
function tone(x, want) {
  const a = Math.round(0.15 * RATE), n = Math.min(Math.round(0.5 * RATE), x.length - a);
  let best = 0, at = 0;
  for (let c = -80; c <= 80; c += 2) {
    const k = 2 * Math.PI * want * 2 ** (c / 1200) / RATE;
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) { const v = x[a + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n)); re += v * Math.cos(k * i); im += v * Math.sin(k * i); }
    if (re * re + im * im > best) { best = re * re + im * im; at = c; }
  }
  return want * 2 ** (at / 1200);
}
const measure = (kind) => (kind === "decay" ? tone : pitch);

// The Iowa horn player drifts sharp up high (+20 to +50 cents from G4 up): retune each horn note to equal temperament from its pitch
// mid-note (struck notes too, once they are more than 10 cents off). asetrate moves pitch and length together, by a few percent
// at most. The piano's sharp top is stretch tuning, so it stays.
for (const s of made.filter((s) => SETS[s.sound]?.tune)) {
  const want = 440 * 2 ** ((s.m - 69) / 12), x = decode(s.file), kind = SETS[s.sound].kind;
  const r = want / measure(kind)(kind === "decay" ? x : x.subarray(Math.round(0.45 * RATE)), want);
  if (Math.abs(1200 * Math.log2(r)) > SETS[s.sound].tune) encode(s.src, s.cut, `asetrate=${(SR * r).toFixed(1)},aresample=${SR},${s.chain}`, s.file);
}

const stats = {};
for (const { sound, m, file, maxSec } of made) {
  const kind = SETS[sound]?.kind, s = (stats[sound] ??= { n: 0, bytes: 0, worst: 0, at: 0 });
  const size = statSync(file).size;
  if (size === 0) throw new Error(`${file}: empty`);
  const x = decode(file);
  const peak = x.reduce((p, v) => Math.max(p, Math.abs(v)), 0);
  if (!(peak > 0.01 && peak < 1)) throw new Error(`${file}: peak ${peak}`);
  if (maxSec && x.length > (maxSec + 0.1) * RATE) throw new Error(`${file}: ${(x.length / RATE).toFixed(2)} s`);
  if (kind === "horn") { // a held note: at least 1.5 s within 12 dB of its loudest 100 ms (a cut that misses the note leaves a decaying tail)
    const w = RATE / 10, db = [];
    for (let i = 0; i + w <= x.length; i += w) { let e = 0; for (let j = i; j < i + w; j++) e += x[j] * x[j]; db.push(10 * Math.log10(e / w + 1e-12)); }
    const held = db.filter((d) => d > Math.max(...db) - 12).length / 10;
    if (held < 1.5) throw new Error(`${file}: holds for only ${held} s`);
  }
  if (kind === "decay") { // a struck note: its loudest 10 ms is in the first 0.3 s (a cut that starts mid-tail has no attack; the low vibes bars swell for 0.2 s)
    const w = RATE / 100;
    let top = 0, at = 0;
    for (let i = 0; i + w <= x.length; i += w) { let e = 0; for (let j = i; j < i + w; j++) e += x[j] * x[j]; if (e > top) { top = e; at = i / RATE; } }
    if (at > 0.3) throw new Error(`${file}: loudest 10 ms at ${at.toFixed(2)} s, no attack at the start`);
  }
  s.n++; s.bytes += size;
  if (SETS[sound]?.pitch === false) continue;
  const want = 440 * 2 ** ((m - 69) / 12);
  let c = 1200 * Math.log2(measure(kind)(x, want) / want);
  c = ((c % 1200) + 1800) % 1200 - 600; // [-600, 600): octave errors are fine, a split off by one note is not
  if (Math.abs(c) > 50) throw new Error(`${file}: ${c.toFixed(1)} cents off midi ${m}`);
  if (Math.abs(c) > s.worst) { s.worst = Math.abs(c); s.at = m; }
}
for (const [sound, s] of Object.entries(stats)) {
  const budget = sound === "piano" ? 6e6 : 2e6;
  if (s.bytes > budget) throw new Error(`${sound}: ${s.bytes} bytes, over the ${budget / 1e6} MB budget`);
  console.log(`${sound}: ${s.n} files, ${(s.bytes / 1e6).toFixed(2)} MB${SETS[sound]?.pitch === false ? "" : `, worst ${s.worst.toFixed(1)} cents (midi ${s.at})`}`);
}
