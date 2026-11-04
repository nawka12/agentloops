// Slice 17, pitch bends and supersaw motion: a note's `bend` (validation, and the pitch it renders), and a held supersaw that no longer sits still. The renders run in headless Chromium.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { studio } from "../src/studio.ts";
import { which } from "../src/export.ts";
import { validate } from "../src/project.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const chromium = which("chromium", "chromium-browser", "google-chrome", "google-chrome-stable"), skip = chromium ? false : "chromium is not installed";

async function setup(project: any) {
  const dir = mkdtempSync(join(tmpdir(), "alp-bend-test-")), file = join(dir, "song.alp.json");
  writeFileSync(file, JSON.stringify(project));
  return { dir, file, s: await studio({ file, port: 0 }) };
}
async function mcp(file: string) {
  const client = new Client({ name: "claude-code", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--disable-warning=ExperimentalWarning", join(root, "src/cli.ts"), "mcp", "--project", file, "--scope", "edit"] }));
  const call = async (name: string, a: any = {}): Promise<any> => {
    const r: any = await client.callTool({ name, arguments: a });
    if (r.isError) throw new Error(r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  return { client, call };
}
/** a 16-bit stereo WAV as [left, right] floats */
function pcm(file: string) {
  const b = readFileSync(file), rate = b.readUInt32LE(24), n = (b.length - 44) / 4, l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) { l[i] = b.readInt16LE(44 + i * 4) / 32768; r[i] = b.readInt16LE(46 + i * 4) / 32768; }
  return { rate, l, r, n };
}
type Pcm = ReturnType<typeof pcm>;
const hz = (key: number) => 440 * 2 ** ((key - 69) / 12);
const ch = (id: string, sound: string, keys: number[], extra: any = {}) => ({ id, name: id, sound, polyphony: 8, generator: { plugin: "script", params: { code: "return 'x';" } }, keymap: keys.map((key) => ({ key, name: String(key), template: "x" })), ...extra });
const song = (o: any) => ({ format: "agentloops/1", name: "Bend", clock: { bpm: 120 }, arrangements: [{ id: "a", clips: [{ ref: "p", start: "1:01" }] }], ...o });

test("validator: a bad bend gets a path, a message and a fix", () => {
  const notes = (...ns: any[]) => song({ channels: [ch("c", "sine", [60])], patterns: [{ id: "p", notes: { c: ns } }] });
  const bad = (n: any) => validate(notes(n));
  for (const [n, path, msg] of [
    [{ start: 0, len: 96, bend: 5 }, "/patterns/0/notes/c/0/bend", /Bad bend/],
    [{ start: 0, len: 96, bend: [] }, "/patterns/0/notes/c/0/bend", /Bad bend/],
    [{ start: 0, len: 96, bend: [[0, 0], [24]] }, "/patterns/0/notes/c/0/bend", /Bad bend/],
    [{ start: 0, len: 96, bend: [[0, "x"]] }, "/patterns/0/notes/c/0/bend", /Bad bend/],
    [{ start: 0, len: 96, bend: [[0, 0], [24, 1], [24, 2]] }, "/patterns/0/notes/c/0/bend/2/0", /Bad bend tick/],
    [{ start: 0, len: 96, bend: [[0, 0], [48, 1], [24, 2]] }, "/patterns/0/notes/c/0/bend/2/0", /Bad bend tick/],
    [{ start: 0, len: 96, bend: [[-1, 0]] }, "/patterns/0/notes/c/0/bend/0/0", /Bad bend tick/],
    [{ start: 0, len: 96, bend: [[1.5, 0]] }, "/patterns/0/notes/c/0/bend/0/0", /Bad bend tick/],
    [{ start: 0, len: 96, bend: [[0, 0], [97, 1]] }, "/patterns/0/notes/c/0/bend/1/0", /past the note's length \(96\)/],
    [{ start: 0, bend: [[0, 0], [25, 1]] }, "/patterns/0/notes/c/0/bend/1/0", /past the note's length \(24\)/], // no len: one step
    [{ start: 0, len: 96, bend: [[0, 49]] }, "/patterns/0/notes/c/0/bend/0/1", /out of range/],
    [{ start: 0, len: 96, bend: [[0, 0], [48, -48.5]] }, "/patterns/0/notes/c/0/bend/1/1", /out of range/],
  ] as const) {
    const e = bad(n).find((x) => x.path === path);
    assert.ok(e, `no error at ${path} for ${JSON.stringify(n.bend)}: ${JSON.stringify(bad(n).map((x) => x.path))}`);
    assert.match(e.message, msg); assert.ok(e.fix, path);
  }
  assert.deepEqual(validate(notes({ start: 0, len: 96, bend: [[0, -2], [24, 0]] }, { start: 96, len: 96, bend: [[72, 0], [96, 5.5]] }, { start: 192, len: 96, bend: [[0, 12]] }, { start: 288, len: 24, bend: [[0, -48], [24, 48]] })), []);
});

/** the pitch (Hz, left side) of the `len` seconds from `from`: autocorrelation, the shortest lag that peaks nearly as high as the best (not an octave down) */
function pitch(w: Pcm, from: number, len: number, lo: number, hi: number) {
  const i0 = Math.floor(from * w.rate), n = Math.floor(len * w.rate), a = Math.floor(w.rate / hi), b = Math.ceil(w.rate / lo), r = new Float64Array(b + 2);
  for (let l = a - 1; l <= b + 1; l++) { let s = 0; for (let i = 0; i < n; i++) s += w.l[i0 + i] * w.l[i0 + i + l]; r[l] = s; }
  let best = 0; for (let l = a; l <= b; l++) best = Math.max(best, r[l]);
  for (let l = a; l <= b; l++) if (r[l] >= 0.9 * best && r[l] >= r[l - 1] && r[l] >= r[l + 1]) return w.rate / (l + (r[l - 1] - r[l + 1]) / (2 * (r[l - 1] - 2 * r[l] + r[l + 1]))); // parabolic peak
  return NaN;
}
const semis = (f: number, key: number) => 12 * Math.log2(f / hz(key));
/** the upward zero crossings (seconds, interpolated) from `from` to `to`, left side */
function crossings(w: Pcm, from: number, to: number) {
  const out: number[] = [];
  for (let i = Math.floor(from * w.rate); i < to * w.rate; i++) if (w.l[i] < 0 && w.l[i + 1] >= 0) out.push((i + -w.l[i] / (w.l[i + 1] - w.l[i])) / w.rate);
  return out;
}
/** how far the held spectrum drifts: the level of each partial of the chord (dB, 0.2 s windows every 0.1 s) smoothed over 1 s, then its std over time; the median over partials */
function drift(w: Pcm, keys: number[], from: number, to: number) {
  const amp = (f: number, t: number, len: number) => {
    const k = 2 * Math.cos((2 * Math.PI * f) / w.rate), n = Math.round(len * w.rate), i0 = Math.round(t * w.rate); let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) { const s0 = (w.l[i0 + i] + w.r[i0 + i]) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)) + k * s1 - s2; s2 = s1; s1 = s0; }
    return Math.sqrt(Math.max(1e-18, s1 * s1 + s2 * s2 - k * s1 * s2));
  }, sd: number[] = [];
  for (const key of keys) for (let h = 1; hz(key) * h < 6000; h++) {
    const tr: number[] = []; for (let t = from; t + 0.2 <= to; t += 0.1) tr.push(20 * Math.log10(amp(hz(key) * h, t, 0.2)));
    const sm = tr.slice(0, tr.length - 9).map((_, i) => tr.slice(i, i + 10).reduce((a, b) => a + b) / 10), m = sm.reduce((a, b) => a + b) / sm.length;
    sd.push(Math.sqrt(sm.reduce((a, b) => a + (b - m) ** 2, 0) / sm.length));
  }
  return sd.sort((a, b) => a - b)[sd.length >> 1];
}

// One song, 120 BPM (a bar is 2 s), no master stage: a sine and a piano each rise an octave over a 1 s note, a chip lead sits an octave up on a constant bend, a supersaw chord is held 4 bars.
const bar = 384, CHORD = [59, 64, 67, 71, 76];
test("bend: the pitch follows the curve in a synth and a sampled sound, an LFO is not bent, and a held supersaw moves", { skip, timeout: 240_000 }, async (t) => {
  const { file, s } = await setup(song({
    mix: { master: "none" },
    channels: [ch("sine", "sine", [57]), ch("piano", "piano", [52]), ch("chip", "chip", [57]), ch("saw", "supersaw", CHORD)],
    patterns: [{ id: "p", lengthSteps: 128, notes: {
      sine: [{ start: 0, len: 192, key: 57, bend: [[0, 0], [192, 12]] }], piano: [{ start: bar, len: 192, key: 52, bend: [[0, 0], [192, 12]] }],
      chip: [{ start: 2 * bar, len: 288, key: 57, bend: [[0, 12]] }], saw: CHORD.map((key) => ({ start: 3 * bar, len: 4 * bar, key })) } }],
  }));
  const m = await mcp(file);
  try {
    const w = pcm((await m.call("audio_export", { file: "bend.wav" })).file);
    for (const [name, key, at] of [["sine", 57, 0], ["piano", 52, 2]] as const) {
      const st = [0.02, 0.45, 0.8].map((from) => semis(pitch(w, at + from, 0.1, hz(key) / 1.5, hz(key) * 2.5), key)); // 0.07 s: +0.8, 0.5 s: +6, 0.85 s: +10.2
      t.diagnostic(`${name}: ${st.map((x) => x.toFixed(2)).join(" → ")} semitones from the key`);
      assert.ok(Math.abs(st[0] - 0.8) < 0.8, `${name} does not start at its key: ${st[0]}`);
      assert.ok(Math.abs(st[1] - 6) < 1.2, `${name} is not halfway up in the middle: ${st[1]}`);
      assert.ok(Math.abs(st[2] - 10.2) < 1.2, `${name} does not end near an octave up: ${st[2]}`);
    }
    // chip: a constant +12 puts its centre an octave up, and its 6 Hz vibrato stays 6 Hz (a bent LFO would run at 12 Hz)
    const cx = crossings(w, 4 + 0.4, 4 + 1.3), cents = cx.slice(1).map((c, i) => 1200 * Math.log2(1 / (c - cx[i]) / hz(69)));
    const mid = cents.reduce((a, b) => a + b) / cents.length, at = (f: number) => { let a = 0, b = 0; cx.slice(1).forEach((c, i) => { a += (cents[i] - mid) * Math.sin(2 * Math.PI * f * c); b += (cents[i] - mid) * Math.cos(2 * Math.PI * f * c); }); return Math.hypot(a, b) / cents.length * 2; };
    t.diagnostic(`chip: centre ${mid.toFixed(1)} cents from 440 Hz; vibrato at 6 Hz ${at(6).toFixed(1)} cents, at 12 Hz ${at(12).toFixed(1)} cents`);
    assert.ok(Math.abs(mid) < 30, `the chip's centre is ${mid} cents from the octave up`);
    assert.ok(at(6) > 8 && at(6) > 3 * at(12), "the vibrato LFO is not at 6 Hz");
    // supersaw: the old one (static detunes and filter) scored 0.23 dB, the new one 3.2
    const mv = drift(w, CHORD, 6 + 1.5, 6 + 7);
    t.diagnostic(`supersaw: partial levels drift ${mv.toFixed(2)} dB (the old sound: 0.23)`);
    assert.ok(mv > 1, `the held supersaw does not move: ${mv} dB`);
  } finally { await m.client.close(); await s.close(); }
});
