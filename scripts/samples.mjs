// Rebuilds the note samples in ui/samples/: Salamander Grand Piano V3 (CC BY 3.0, Alexander Holm), University of Iowa Musical
// Instrument Samples, VSCO 2 Community Edition (CC0), and the Musyng Kite guitars (CC BY-SA 3.0). The MP3s are committed; this script only exists so they can be rebuilt.
// Needs ffmpeg, curl, tar.
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
const SR = 44100, RATE = 4 * SR; // RATE: the checks decode at 4x, so high notes have enough lag resolution
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const roots = (a, b) => Array.from({ length: (b - a) / 3 + 1 }, (_, i) => a + 3 * i);
// Piano stops at 105: the Salamander C8 recording measures ~+125 cents sharp, so it fails the pitch check. C8 plays root 105 pitched up.
const PIANO_ROOTS = roots(21, 105);
const PIANO_URL = "https://freepats.zenvoid.org/Piano/SalamanderGrandPiano/SalamanderGrandPianoV3+20161209_44khz16bit.tar.xz";
const PIANO_DIR = "SalamanderGrandPianoV3_44.1khz16bit/44.1khz16bit/";
const IOWA = "https://theremin.music.uiowa.edu/sound%20files/MIS/";
const VSCO = (path) => `https://raw.githubusercontent.com/sgossner/VSCO-2-CE/master/${path.split("/").map(encodeURIComponent).join("/")}`;
const MK = (inst) => (m) => `https://gleitz.github.io/midi-js-soundfonts/MusyngKite/${inst}-mp3/${["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"][m % 12]}${Math.floor(m / 12) - 1}.mp3`;
const low = (m) => pianoName(m - 12); // the VSCO section and glock folders name every note an octave below how it sounds (measured; see oct)
const hzOf = (m) => 440 * 2 ** ((m - 69) / 12);
const TAIL = (sec) => `atrim=duration=${sec},afade=t=out:st=${sec * 0.75}:d=${sec * 0.25}`;
const DECAY = (sec, db = -50) => `silenceremove=start_periods=1:start_threshold=${db}dB:start_silence=0,${TAIL(sec)}`;
const ENC = ["-ac", "1", "-ar", String(SR), "-c:a", "libmp3lame", "-b:a", "80k"];
const PIANO_CHAIN = "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0,atrim=duration=8,afade=t=out:st=6.5:d=1.5";
// Iowa sets. files: [range, first midi, notes in file, lo, hi]; only roots in [lo, hi) (default: the whole file) come from it.
// A struck note rings down into the tape noise, so those sets split at a much lower level (sil). fix["layer.range"] = [sil, shortest
// note, midi notes the file lacks] for a file with noise blips that would pass for notes, or a note that was never recorded.
// held = a held note, looped (see held()), retuned to equal temperament; decay = struck, cut at sec with a fade (attack check).
// tune = cents off at which a note is retuned; pitch false = unpitched. loop: [ls, le] s, the loop window of every file of a held sound.
// VSCO sets have one file per note: src(midi, layer) is its path (a full URL for any other host: the Musyng Kite guitars). layers: which of mf ("<root>.mp3") and pp ("<root>-p.mp3") exist.
// flat: no attack check. oct: also check the octave (see f0), "harm" for harmonic sounds, "peak" for the glock and timpani.
const SETS = {
  sax: { kind: "held", loop: [1, 2.2], tune: 3, roots: roots(49, 79), url: (l, r) => `${IOWA}Woodwinds/altosaxophone/AltoSax.Vib.${l}.${r}.aiff`,
    files: [["Db3B3", 49, 11], ["C4B4", 60, 12], ["C5Ab5", 72, 9]] },
  trombone: { kind: "held", loop: [0.5, 1.4], tune: 3, sil: "-45dB:d=0.25", // quiet: mf notes near -46 dB, pp lower; the shortest note lasts 1.6 s
    roots: roots(40, 70), url: (l, r) => `${IOWA}Brass/tenortrombone/TenorTrombone.${l}.${r}.aiff`,
    files: [[" E2B2", 40, 8], ["C3B3", 48, 12], ["C4B4", 60, 12]] }, // the file name really has a space before E2B2
  trumpet: { kind: "held", loop: [1, 3.4], tune: 3, roots: roots(52, 85), url: (l, r) => `${IOWA}Brass/Bbtrumpet/Trumpet.vib.${l}.${r}.aiff`,
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
  // Kit cymbals, stick on the bow, loudness-matched like the ride: 49 an 18" crash, 52 a 16" china, 55 a splash.
  cymbals: { kind: "decay", sec: 4, pitch: false, hp: 150, start: -95, loud: -40, sil: "-100dB:d=0.25",
    roots: [49, 52, 55], url: (l, r) => `${IOWA}Percussion/cymbals/suspended%20cymbals/stick/${r}.stick.normal.${l}.aif`,
    files: [["18crash", 49, 1], ["16chinese", 52, 1], ["splash", 55, 1]] },
  // One sound from three sections: cellos C2-C4, violas D4-A4, violins C5-D6 (the recorded notes, 2-4 semitones apart). The cello set has v1 and v3, no v2.
  strings: { kind: "held", loop: [2.5, 5], tune: 10, oct: "harm", roots: [36, 40, 43, 47, 50, 53, 57, 60, 62, 65, 69, 72, 76, 79, 83, 86],
    src: (m, l) => m <= 60 ? `Strings/Cello Section/susvib/susvib_${low(m)}_${l === "mf" ? "v3" : "v1"}_1.wav`
      : m <= 69 ? `Strings/Viola Section/susvib/ViolaEns_susvib_${low(m)}_${l === "mf" ? "v2" : "v1"}_1.wav`
      : `Strings/Violin Section/susVib/VlnEns_susVib_${low(m)}_${l === "mf" ? "v2" : "v1"}.wav` },
  // The loop starts late: the player changes bow (C5 p has a 100 ms gap at 3.6 s), and the high p notes are still swelling at 2.5 s.
  violin: { kind: "held", loop: [4, 6.5], tune: 10, oct: "harm", roots: [55, 57, 60, 64, 67, 69, 72, 76, 79, 81, 84, 88, 91, 93, 96],
    src: (m, l) => `Strings/Solo Violin/Arco Vib/LLVln_ArcoVib_${pianoName(m)}_${l === "mf" ? "f" : "p"}.wav` },
  // Plucked, first round-robin. Above A5 only f was recorded, so those roots have one dynamic. The C7 file reads as C6 in the octave check, so A6 covers the top.
  pizz: { kind: "decay", sec: 1.5, tune: 10, oct: "harm", roots: [55, 57, 60, 64, 67, 69, 72, 76, 79, 81, 88, 93],
    src: (m, l) => `Strings/Solo Violin/Pizz/LLVln_Pizz_${pianoName(m)}_${l === "mf" || m > 81 ? "f" : "p"}_RR1.wav` },
  // One dynamic per note (a few only exist as f). G1 (mp) is left out: noise bursts at 2.3 and 3.7 s as loud as the note; E1 covers it.
  harp: { kind: "decay", sec: 4, tune: 10, oct: "harm", layers: ["mf"],
    roots: [28, 35, 38, 41, 45, 48, 52, 55, 59, 62, 65, 69, 72, 76, 79, 83, 86, 89, 93, 95, 98, 101],
    src: (m) => `Strings/Harp/KSHarp_${pianoName(m)}_${{ 28: "f", 98: "f", 101: "f" }[m] ?? "mf"}.wav` },
  glock: { kind: "decay", sec: 4, tune: 10, oct: "peak", layers: ["mf"], roots: [79, 84, 91, 96, 103, 108],
    src: (m) => `Percussion/Glock/glock_medium_${low(m)}.wav` },
  // Five drums, each at its measured pitch (the (1,1) mode: F2 +46, B2 -20, C#3 +48, E3 +43, G3 -45 cents), retuned to the nearest note.
  timpani: { kind: "decay", sec: 4, tune: 3, oct: "peak", roots: [41, 47, 49, 52, 55],
    src: (m, l) => `Percussion/Timpani/Timpani${[41, 47, 49, 52, 55].indexOf(m) + 1}_Hit_${l === "mf" ? "v3" : "v1"}_rr1_Sum.wav` },
  // Recorded electric guitars: one 3.1 s render per key of a chromatic soundfont (Musyng Kite, mf), every minor third E2-E6.
  heavy: { kind: "decay", sec: 3, to: -9, flat: true, layers: ["mf"], roots: roots(40, 88), src: MK("distortion_guitar") },
  crunch: { kind: "decay", sec: 3, to: -9, flat: true, layers: ["mf"], roots: roots(40, 88), src: MK("overdriven_guitar") },
  chug: { kind: "decay", sec: 3, to: -9, flat: true, layers: ["mf"], roots: roots(40, 88), src: MK("electric_guitar_muted") },
  clean: { kind: "decay", sec: 3, to: -9, flat: true, layers: ["mf"], roots: roots(40, 88), src: MK("electric_guitar_clean") },
};

const sh = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { maxBuffer: 1 << 28, input });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}): ${r.stderr.toString().slice(-500)}`);
  return r;
};
const ff = (args, input) => sh("ffmpeg", ["-hide_banner", "-nostats", "-y", ...args], input);
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
// `to` (a set's, default -3) is the peak the gain brings it to: the clipped guitars overshoot between samples, so they sit lower.
// `loud` sets the mean level (dB) instead: a stick's click sets a cymbal hit's peak, so peak-normalized rides came out with pp 10 dB over mf.
function encode(src, cut, chain, dest, loud, to = -3) {
  const input = [...cut, "-i", src];
  const det = ff([...input, "-af", `${chain},volumedetect`, "-f", "null", "-"]).stderr.toString();
  const peak = +/max_volume: (-?[\d.]+) dB/.exec(det)[1], gain = loud == null ? to - peak : loud - +/mean_volume: (-?[\d.]+) dB/.exec(det)[1];
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
const emit = (sound, m, suffix, src, cut, chain, maxSec, loud, to) => {
  const dest = join(out, sound, `${m}${suffix}.mp3`);
  encode(src, cut, chain, dest, loud, to);
  made.push({ sound, m, file: dest, maxSec, src, cut, chain });
};

// The first sample within 40 dB of the peak, less 5 ms: VSCO files and soft notes sit far below any fixed silence level.
const onset = (x, rate) => { let p = 0; for (const v of x) p = Math.max(p, Math.abs(v)); return Math.max(0, x.findIndex((v) => Math.abs(v) > p / 100) - Math.round(rate / 200)); };

// A held note, looped: retuned to equal temperament from its pitch at ls, cut from its onset to le. A gain ramp across the loop brings
// its last 0.5 s to the level of its first (players swell and fade), then the last XF s before le crossfade (equal power) into the
// audio from just before ls, so ls..le played on repeat has no seam; nothing after le is ever played. Chromium's
// decodeAudioData (live and export) and ffmpeg both drop LAME's encoder delay (1105 samples) and padding, so these times hold in the decoded buffer.
const XF = 0.25, LOOPDB = 6, GAPDB = 12, DRIFT = 3;
function held(sound, m, suffix, src, cut, S) {
  const [ls, le] = S.loop, want = hzOf(m), x4 = decode(src, cut);
  const r = want / pitch(x4.subarray(onset(x4, RATE) + Math.round((ls - 0.15) * RATE)), want);
  const x = decode(src, cut, SR, Math.abs(1200 * Math.log2(r)) > S.tune ? `asetrate=${(SR * r).toFixed(1)},aresample=${SR}` : undefined);
  const on = onset(x, SR), E = Math.round(le * SR), L = Math.round((le - ls) * SR), F = Math.round(XF * SR), y = x.slice(on, on + E);
  if (y.length < E) throw new Error(`${src} (midi ${m}): ${(y.length / SR).toFixed(2)} s from its onset, the loop ends at ${le} s`);
  for (let i = 0; i < SR / 200; i++) y[i] *= i / (SR / 200); // the 5 ms before the onset fade in
  const S0 = E - L, rms = (a) => { let e = 0; for (let i = a; i < a + SR / 2; i++) e += y[i] * y[i]; return Math.sqrt(e); }, tilt = rms(S0) / rms(E - SR / 2);
  for (let i = S0; i < E; i++) y[i] *= tilt ** ((i - S0) / L);
  for (let i = E - F; i < E; i++) { const t = (i - (E - F) + 0.5) / F; y[i] = y[i] * Math.cos(t * Math.PI / 2) + y[i - L] * Math.sin(t * Math.PI / 2); }
  let p = 0; for (const v of y) p = Math.max(p, Math.abs(v));
  for (let i = 0; i < E; i++) y[i] *= 10 ** (-3 / 20) / p;
  const dest = join(out, sound, `${m}${suffix}.mp3`);
  ff(["-f", "f32le", "-ar", String(SR), "-ac", "1", "-i", "-", ...ENC, dest], Buffer.from(y.buffer, y.byteOffset, y.byteLength));
  made.push({ sound, m, file: dest, maxSec: le });
}

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
  for (const [layer, suffix] of [["mf", ""], ["pp", "-p"]].filter(([l]) => (S.layers ?? ["mf", "pp"]).includes(l))) {
    const note = (m, file, cut) => S.kind === "held" ? held(sound, m, suffix, file, cut, S) : emit(sound, m, suffix, file, cut, S.src ? TAIL(S.sec) : DECAY(S.sec, S.start), S.sec, S.loud, S.to);
    for (const m of S.src ? S.roots : []) {
      const path = S.src(m, layer), file = path.startsWith("http") ? fetchTo(path, `${sound}-${m}.mp3`) : fetchTo(VSCO(path));
      note(m, file, S.kind === "held" ? [] : ["-ss", (onset(decode(file, [], SR), SR) / SR).toFixed(4)]);
    }
    for (const [range, first, count, lo = first, hi = first + count] of S.files ?? []) {
      const rs = S.roots.filter((m) => m >= lo && m < hi);
      if (!rs.length) continue;
      const file = highpassed(fetchTo(S.url(layer, range)), S.hp);
      const [sil = S.sil, min, gone = []] = S.fix?.[`${layer}.${range}`] ?? [];
      const segs = regions(file, count - gone.length, sil, min);
      for (const m of rs) {
        const seg = segs[m - first - gone.filter((g) => g < m).length];
        const cut = ["-ss", String(seg[0]), "-to", String(seg[1])];
        note(m, file, cut);
      }
    }
  }
}

// Self-check: decode each MP3 and compare its pitch class to the midi number in its name.
// The lag search is +-10% around the expected period (a note a semitone off still lands inside it and fails; anything further out fails with no peak).
function decode(file, cut = [], rate = RATE, af) {
  const b = sh("ffmpeg", ["-hide_banner", "-v", "error", ...cut, "-i", file, ...(af ? ["-af", af] : []), "-f", "f32le", "-ac", "1", "-ar", String(rate), "-"]).stdout;
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

// Octave check: the midi a note sounds at, from m - 12, m and m + 12, on a Hann-windowed 0.5 s from 0.15 s of the spectrum. The checks
// above fold octaves away on purpose, and VSCO names some folders an octave off. E(h): the strongest bin within +-50 cents of h times the
// note. harm (harmonic sounds): a note an octave lower than its name has odd partials of half the note (0.5, 1.5, 2.5) within 20 dB
// of the even ones (1, 2, 3); one an octave higher has no odd partials of its own (1, 3, 5 over 20 dB under 2, 4, 6).
// peak (glock and timpani overtones are not harmonic, and a timpani's (2,1) mode sits at 1.5): the note's partial is within 10 dB of the
// strongest from 1.5 octaves below to 2.5 above, and nothing an octave below it comes within 10 dB of it (timpani pick up the other
// drums' pitches, so it need not be the lowest strong partial).
function f0(x, want, how) {
  const a = Math.round(0.15 * RATE), w = Float64Array.from({ length: Math.min(SR / 2, (x.length - a) >> 2) }, (_, i) => x[a + 4 * i]);
  const m = 69 + 12 * Math.log2(want / 440);
  const N = 1 << 15, re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < w.length; i++) re[i] = w[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / w.length));
  for (let i = 1, j = 0; i < N; i++) { let b = N >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= N; len <<= 1) for (let i = 0; i < N; i += len) for (let k = 0; k < len / 2; k++) {
    const c = Math.cos(-2 * Math.PI * k / len), s = Math.sin(-2 * Math.PI * k / len), p = i + k + len / 2, tr = re[p] * c - im[p] * s, ti = re[p] * s + im[p] * c;
    re[p] = re[i + k] - tr; im[p] = im[i + k] - ti; re[i + k] += tr; im[i + k] += ti;
  }
  const band = (a, b) => { let t = 0; for (let k = Math.round(a * N / SR); k <= Math.min(N / 2, Math.round(b * N / SR)); k++) t = Math.max(t, re[k] ** 2 + im[k] ** 2); return t; };
  const E = (h, c = 50) => band(want * h / 2 ** (c / 1200), want * h * 2 ** (c / 1200));
  const odd = (p) => E(p) + E(3 * p) + E(5 * p), even = (p) => E(2 * p) + E(4 * p) + E(6 * p);
  if (how === "harm") return m + (odd(0.5) > even(0.5) / 100 ? -12 : odd(1) < even(1) / 100 ? 12 : 0);
  return m + (E(0.5, 80) > E(1, 80) / 10 ? -12 : E(1, 80) < band(want / 2 ** 1.5, want * 2 ** 2.5) / 10 ? 12 : 0);
}

// Struck notes are retuned to equal temperament once they are more than `tune` cents off (held notes already were, in held(): the Iowa
// horn player drifts sharp up high, +20 to +50 cents from G4 up). asetrate moves pitch and length together, by a few percent at most.
// The piano's sharp top is stretch tuning, so it stays.
for (const s of made.filter((s) => SETS[s.sound]?.tune && SETS[s.sound].kind === "decay")) {
  const want = hzOf(s.m), x = decode(s.file);
  const r = want / tone(x, want);
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
  if (kind === "held") { // the file ends at le, the seam is no bigger than a step inside the loop, and the level holds over [ls - XF, le]:
    // every 250 ms within LOOPDB of their mean, every 100 ms within GAPDB (a bow change), and the loop's last 0.5 s within DRIFT of its
    // first (a cut that misses the note, or a swell, fade or gap in the loop, would pulse on every repeat)
    const [ls, le] = SETS[sound].loop, a = Math.round(ls * RATE), b = Math.round(le * RATE);
    if (Math.abs(x.length - b) > RATE / 100) throw new Error(`${file}: ${(x.length / RATE).toFixed(3)} s, the loop ends at ${le} s`);
    let step = 0; for (let i = a; i + 4 < b; i++) step = Math.max(step, Math.abs(x[i + 4] - x[i])); // one 44.1 kHz step
    const seam = Math.abs(x[a] - x[b - 4]);
    if (seam > step) throw new Error(`${file}: a ${seam.toFixed(3)} jump at the loop seam, steps inside the loop are at most ${step.toFixed(3)}`);
    const level = (i, n) => { let e = 0; for (let j = i; j < i + n; j++) e += x[j] * x[j]; return 10 * Math.log10(e / n + 1e-12); };
    const mean = level(Math.round((ls - XF) * RATE), b - Math.round((ls - XF) * RATE)), drift = Math.abs(level(b - RATE / 2, RATE / 2) - level(a, RATE / 2));
    const off = (w) => { let o = 0; for (let i = Math.round((ls - XF) * RATE); i + w <= b; i += w) o = Math.max(o, Math.abs(level(i, w) - mean)); return o; };
    const [off4, off10] = [off(RATE / 4), off(RATE / 10)];
    if (off4 > LOOPDB) throw new Error(`${file}: a 250 ms in the loop is ${off4.toFixed(1)} dB off its mean`);
    if (off10 > GAPDB) throw new Error(`${file}: a 100 ms in the loop is ${off10.toFixed(1)} dB off its mean`);
    if (drift > DRIFT) throw new Error(`${file}: the loop ends ${drift.toFixed(1)} dB off its start`);
    s.loopdb = Math.max(s.loopdb ?? 0, off4); s.gap = Math.max(s.gap ?? 0, off10); s.drift = Math.max(s.drift ?? 0, drift);
  }
  if (kind === "decay" && !SETS[sound].flat) { // (flat: a sustained soundfont render, whose loudest 10 ms is anywhere) a struck note: its loudest 10 ms is in the first 0.3 s (a cut that starts mid-tail has no attack; the low vibes bars swell for 0.2 s)
    const w = RATE / 100;
    let top = 0, at = 0;
    for (let i = 0; i + w <= x.length; i += w) { let e = 0; for (let j = i; j < i + w; j++) e += x[j] * x[j]; if (e > top) { top = e; at = i / RATE; } }
    if (at > 0.3) throw new Error(`${file}: loudest 10 ms at ${at.toFixed(2)} s, no attack at the start`);
  }
  s.n++; s.bytes += size;
  if (SETS[sound]?.pitch === false) continue;
  const want = hzOf(m), y = x.subarray(Math.round(((SETS[sound]?.loop?.[0] ?? 0.15) - 0.15) * RATE)); // held notes are measured in the loop
  if (SETS[sound]?.oct) { const k = f0(y, want, SETS[sound].oct); if (!(Math.abs(k - m) < 0.5)) throw new Error(`${file}: sounds at midi ${k?.toFixed(2)}, not ${m}`); }
  let c = 1200 * Math.log2(measure(kind)(y, want) / want);
  c = ((c % 1200) + 1800) % 1200 - 600; // [-600, 600): octave errors are fine, a split off by one note is not
  if (Math.abs(c) > 50) throw new Error(`${file}: ${c.toFixed(1)} cents off midi ${m}`);
  if (Math.abs(c) > s.worst) { s.worst = Math.abs(c); s.at = m; }
}
for (const [sound, s] of Object.entries(stats)) {
  const budget = sound === "piano" ? 6e6 : 2e6;
  if (s.bytes > budget) throw new Error(`${sound}: ${s.bytes} bytes, over the ${budget / 1e6} MB budget`);
  console.log(`${sound}: ${s.n} files, ${(s.bytes / 1e6).toFixed(2)} MB${SETS[sound]?.pitch === false ? "" : `, worst ${s.worst.toFixed(1)} cents (midi ${s.at})`}${s.loopdb ? `, loop level within ${s.loopdb.toFixed(1)} dB (${s.gap.toFixed(1)} per 100 ms), drift ${s.drift.toFixed(1)} dB` : ""}`);
}
