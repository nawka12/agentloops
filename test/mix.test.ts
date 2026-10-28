// Slice I, mixing: stems, the master limiter, a channel's `mix` (EQ, pan, compressor, reverb and delay sends) and the sidechain. The renders run in headless Chromium.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "alp-mix-test-")), file = join(dir, "song.alp.json");
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
const db = (v: number) => 20 * Math.log10(v + 1e-9);
/** RMS from `from` to `to` seconds, both sides (or one: "l" / "r") */
function rms(w: Pcm, from: number, to: number, side?: "l" | "r") {
  let sum = 0, n = 0;
  for (let i = Math.floor(from * w.rate); i < Math.min(w.n, to * w.rate); i++, n++) sum += side ? w[side][i] ** 2 : (w.l[i] ** 2 + w.r[i] ** 2) / 2;
  return Math.sqrt(sum / Math.max(1, n));
}
/** the power at hz (Goertzel, left side) from `from` to `to` seconds */
function tone(w: Pcm, hz: number, from: number, to: number) {
  const k = 2 * Math.cos((2 * Math.PI * hz) / w.rate); let s1 = 0, s2 = 0, n = 0;
  for (let i = Math.floor(from * w.rate); i < to * w.rate; i++, n++) { const s0 = w.l[i] + k * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) / n;
}
const ch = (id: string, sound: string, keys: number[], extra: any = {}) => ({ id, name: id, sound, polyphony: 8, generator: { plugin: "script", params: { code: "return 'x';" } }, keymap: keys.map((key) => ({ key, name: String(key), template: "x" })), ...extra });
const song = (o: any) => ({ format: "agentloops/1", name: "Mix", clock: { bpm: 120 }, arrangements: [{ id: "a", clips: [{ ref: "p", start: "1:01" }] }], ...o });

test("validator: bad mix values get a path, a message and a fix", () => {
  const p = song({
    channels: [ch("d", "rock", [36]), ch("s", "sub", [36], { mix: { pan: 2, eq: { highpass: 900, lowpass: 200, bands: [{ f: 5, db: 40 }, { q: 1 }], tilt: 1 }, comp: { ratio: 0.5, threshold: 3 }, reverb: -0.1, delay: "x", duck: 1.5, duckBy: "s", gain: 1 } }), ch("t", "triangle", [60], { mix: { duckBy: "nope" } })],
    patterns: [{ id: "p", notes: {} }], mix: { master: "loud", delay: { time: 0, feedback: 1 } },
  });
  const errs = validate(p), at = (path: string) => errs.find((e) => e.path === path);
  for (const [path, msg] of [
    ["/channels/1/mix/gain", /Unknown setting "gain"/], ["/channels/1/mix/pan", /-1 to 1/], ["/channels/1/mix/reverb", /0 to 1/], ["/channels/1/mix/delay", /0 to 1/], ["/channels/1/mix/duck", /0 to 1/],
    ["/channels/1/mix/duckBy", /not a drum kit/], ["/channels/2/mix/duckBy", /Unknown channel 'nope'/], ["/channels/1/mix/eq/tilt", /Unknown setting/], ["/channels/1/mix/eq/lowpass", /above highpass/],
    ["/channels/1/mix/eq/bands/0/f", /20 to 20000/], ["/channels/1/mix/eq/bands/0/db", /-24 to 24/], ["/channels/1/mix/eq/bands/1", /needs f/], ["/channels/1/mix/comp/ratio", /1 to 20/],
    ["/channels/1/mix/comp/threshold", /-60 to 0/], ["/mix/master", /Unknown master/], ["/mix/delay/time", /0.25 to 16/], ["/mix/delay/feedback", /0 to 0.95/],
  ] as const) { const e = at(path); assert.ok(e, `no error at ${path}: ${JSON.stringify(errs.map((x) => x.path))}`); assert.match(e.message, msg); assert.ok(e.fix, path); }
  assert.match(at("/channels/2/mix/duckBy")!.fix, /\bd\b/); // names the kits there are
  const ok = song({ channels: [ch("d", "drums", [36]), ch("s", "sub", [36], { mix: { pan: -0.3, eq: { highpass: 120, lowpass: 9000, bands: [{ f: 350, q: 1, db: -3 }] }, comp: { threshold: -18, ratio: 3, attack: 0.01, release: 0.15 }, reverb: 0.1, delay: 0.15, duck: 0.5, duckBy: "d" } })],
    patterns: [{ id: "p", notes: {} }], mix: { master: "compressor", delay: { time: 3, feedback: 0.35 } } });
  assert.deepEqual(validate(ok), []);
  assert.deepEqual(validate({ ...ok, mix: "x" }).map((e) => e.path), ["/mix"]);
});

/** 16-bit stereo silence with renderWav's 44-byte header */
function silence(seconds: number, rate = 44100) {
  const data = Math.round(seconds * rate) * 4, b = Buffer.alloc(44 + data);
  b.write("RIFF", 0); b.writeUInt32LE(36 + data, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(data, 40);
  return b;
}
test("stems via a connected tab: each upload lands as <nn>-<id>.wav, overwrite clears the old stems only", async () => {
  const { dir, file, s } = await setup(song({ channels: [ch("a", "triangle", [60]), ch("b/2", "triangle", [60])], patterns: [{ id: "p", notes: {} }] })), m = await mcp(file);
  const post = (path: string, body: any, type: string) => fetch(s.url + path, { method: "POST", headers: { "content-type": type }, body });
  const ac = new AbortController(), res = await fetch(s.url + "api/events", { signal: ac.signal }), rd = res.body!.getReader(); // the tab: answer each export event with two stems
  (async () => { let buf = ""; try { for (;;) { const { value, done } = await rd.read(); if (done) return; buf += Buffer.from(value).toString();
    for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) {
      const block = buf.slice(0, i), d = /^event: export\ndata: (.*)$/m.exec(block)?.[1]; if (!d) continue;
      const x = JSON.parse(d); assert.equal(x.stems, true);
      await post(`api/export/${x.id}/ack`, "{}", "application/json");
      for (const c of ["a", "b/2"]) assert.equal((await post(`api/export/${x.id}/stem?ch=${encodeURIComponent(c)}`, silence(1), "audio/wav")).status, 200);
      await post(`api/export/${x.id}`, JSON.stringify({ done: true }), "application/json");
    } } } catch {} })();
  try {
    const r = await m.call("audio_export", { stems: true, file: "parts" });
    assert.deepEqual([r.folder, r.renderedBy, r.seconds], [join(dir, "parts"), "tab", 1]);
    assert.deepEqual(readdirSync(r.folder).sort(), ["01-a.wav", "02-b-2.wav"]);
    writeFileSync(join(r.folder, "03-gone.wav"), "old stem"); writeFileSync(join(r.folder, "notes.txt"), "mine");
    await m.call("audio_export", { stems: true, file: "parts", overwrite: true });
    assert.deepEqual(readdirSync(r.folder).sort(), ["01-a.wav", "02-b-2.wav", "notes.txt"]);
    assert.equal((await post("api/export/deadbeef/stem?ch=a", silence(1), "audio/wav")).status, 404);
    assert.equal((await fetch(s.url + "api/export/deadbeef/stem?ch=a", { method: "POST", headers: { "content-type": "audio/wav", origin: "http://evil.example" }, body: silence(1) })).status, 403);
  } finally { ac.abort(); await m.client.close(); await s.close(); }
});

// One song for stems and the sidechain: kicks on beats 1 and 3 (drums), a rock kick between two of them, four held basses ducked four ways, a muted channel and a silent one.
// The mix has no master stage, so the stems must sum to it.
const beats = Array.from({ length: 4 }, (_, i) => ({ start: i * 192, len: 24, key: 36 })), held = (key: number) => [{ start: 0, len: 768, key }];
const SIDE = song({
  mix: { master: "none" },
  channels: [ch("drums", "drums", [36, 42], { gain: 0.3 }), ch("rock", "rock", [36], { gain: 0.3 }), ch("sub", "sub", [36, 40], { gain: 0.3 }), ch("flat", "sub", [43], { gain: 0.3, mix: { duck: 0 } }),
    ch("deep", "pad", [48], { gain: 0.3, mix: { duck: 0.9, pan: -0.5, reverb: 0.3 } }), ch("byrock", "sub", [45], { gain: 0.3, mix: { duckBy: "rock" } }), ch("muted", "triangle", [60], { mute: true }), ch("idle", "triangle", [60])],
  patterns: [{ id: "p", lengthSteps: 32, notes: { drums: [...beats, ...beats.map((n) => ({ ...n, key: 42, start: n.start + 48 }))], rock: [{ start: 288, len: 24, key: 36 }], sub: held(40), flat: held(43), deep: held(48), byrock: held(45), muted: held(60) } }],
});

test("stems: one per sounding channel, the mix's length, summing to the mix; the sidechain ducks each as set", { skip, timeout: 240_000 }, async (t) => {
  const { dir, file, s } = await setup(SIDE), m = await mcp(file);
  try {
    const mix = pcm((await m.call("audio_export", { file: "mix.wav" })).file), r = await m.call("audio_export", { stems: true });
    assert.equal(r.folder, join(dir, "mix-stems"));
    assert.deepEqual(r.stems.map((x: any) => x.file.slice(r.folder.length + 1)), ["01-drums.wav", "02-rock.wav", "03-sub.wav", "04-flat.wav", "05-deep.wav", "06-byrock.wav"]); // not the muted or the idle channel
    assert.deepEqual(readdirSync(r.folder).sort(), r.stems.map((x: any) => x.file.slice(r.folder.length + 1)));
    const st = Object.fromEntries(r.stems.map((x: any) => [x.channel, pcm(x.file)])) as Record<string, Pcm>;
    for (const [id, w] of Object.entries(st)) assert.equal(w.n, mix.n, `${id}: ${w.n} frames, the mix has ${mix.n}`);
    let res = 0, all = 0;
    for (let i = 0; i < mix.n; i++) for (const side of ["l", "r"] as const) { const sum = Object.values(st).reduce((a, w) => a + w[side][i], 0); res += (sum - mix[side][i]) ** 2; all += mix[side][i] ** 2; }
    t.diagnostic(`stems minus mix: ${(10 * Math.log10(res / all)).toFixed(1)} dB under the mix`);
    assert.ok(10 * Math.log10(res / all) < -30, "the stems do not sum to the mix");
    // the dip 14-38 ms after a kick, against the 50 ms before it: a drums kick at 2 s, the rock kick at 1.5 s
    const dip = (w: Pcm, k: number) => db(rms(w, k + 0.014, k + 0.038)) - db(rms(w, k - 0.06, k - 0.01)); // the duck is down from 12 to 40 ms
    const d = Object.fromEntries(Object.entries(st).map(([id, w]) => [id, [dip(w, 2), dip(w, 1.5)]]));
    t.diagnostic(Object.entries(d).filter(([id]) => !["drums", "rock"].includes(id)).map(([id, [a, b]]) => `${id}: ${a.toFixed(1)} dB at the kick, ${b.toFixed(1)} dB at the rock kick`).join("; "));
    assert.ok(d.sub[0] < -6, "a pumped sound ducks on the kick, though the kick is not in its stem");
    assert.ok(Math.abs(d.sub[1]) < 1, "the rock kick ducks nothing by default");
    assert.ok(Math.abs(d.flat[0]) < 1, "duck: 0 does not duck");
    assert.ok(d.deep[0] < d.sub[0] - 3, "duck: 0.9 ducks deeper than the default, even on a pad (its reverb return ducks by the default)");
    assert.ok(d.byrock[1] < -6 && Math.abs(d.byrock[0]) < 1, "duckBy: only that channel's kicks");
    // a pan of -0.5 on the channel: louder on the left
    assert.ok(db(rms(st.deep, 0.5, 3, "l")) - db(rms(st.deep, 0.5, 3, "r")) > 3, "the channel pan moves the pad left");
    await assert.rejects(m.call("audio_export", { stems: true }), /already exists.*overwrite/);
    await assert.rejects(m.call("audio_export", { stems: true, format: "mp3" }), /WAV only/);
    await assert.rejects(m.call("audio_export", { stems: true, file: "../out" }), /plain folder name/);
  } finally { await m.client.close(); await s.close(); }
});

test("master limiter: a hot mix stays under -1 dBFS, and a denser section is not quieter than a sparser one", { skip, timeout: 120_000 }, async (t) => {
  const chord = (keys: number[], from: number) => keys.map((key) => ({ start: from, len: 768, key })), bar = 384;
  const { file, s } = await setup(song({
    channels: [ch("pad", "pad", [57, 60, 64]), ch("saw", "supersaw", [57, 60, 64, 69]), ch("drums", "drums", [36, 42])],
    patterns: [{ id: "p", lengthSteps: 64, notes: { // bars 1-2: a pad, a supersaw chord and hats; bars 3-4: the same plus a kick on every 8th. The old master compressor gets them within 0.3 dB of each other
      pad: [...chord([57, 60, 64], 0), ...chord([57, 60, 64], 2 * bar)], saw: [...chord([57, 60, 64, 69], 0), ...chord([57, 60, 64, 69], 2 * bar)],
      drums: [...Array.from({ length: 32 }, (_, i) => ({ start: i * 48, len: 24, key: 42 })), ...Array.from({ length: 16 }, (_, i) => ({ start: 2 * bar + i * 48, len: 24, key: 36 }))] } }],
  }));
  const m = await mcp(file);
  try {
    const w = pcm((await m.call("audio_export", { file: "hot.wav" })).file);
    let peak = 0; for (let i = 0; i < w.n; i++) peak = Math.max(peak, Math.abs(w.l[i]), Math.abs(w.r[i]));
    const sparse = db(rms(w, 1, 4)), dense = db(rms(w, 5, 8));
    t.diagnostic(`peak ${db(peak).toFixed(2)} dBFS; sparse ${sparse.toFixed(1)} dB, dense ${dense.toFixed(1)} dB`);
    assert.ok(db(peak) <= -0.9, `peak ${db(peak).toFixed(2)} dBFS`);
    assert.ok(dense > sparse + 1, "the denser section came out quieter");
  } finally { await m.client.close(); await s.close(); }
});

test("a channel's mix changes the sound: highpass, pan, compressor, reverb, delay", { skip, timeout: 120_000 }, async (t) => {
  // 120 BPM, no master stage; each channel plays one beat-long note (0.5 s) in its own 2 s bar. The delay repeats a beat (4 steps) later
  const one = (bar: number, key: number) => [{ start: bar * 384, len: 96, key }];
  const { file, s } = await setup(song({
    mix: { master: "none", delay: { time: 4, feedback: 0.3 } },
    channels: [ch("ref", "saw", [45]), ch("hp", "saw", [45], { mix: { eq: { highpass: 1500 } } }), ch("left", "saw", [45], { mix: { pan: -1 } }), ch("tri", "triangle", [60]),
      ch("comp", "triangle", [60], { mix: { comp: { threshold: -45, ratio: 20, attack: 0.002, release: 0.05 } } }), ch("wet", "triangle", [60], { mix: { reverb: 1 } }),
      ch("clave", "drums", [75]), ch("echo", "drums", [75], { mix: { delay: 1 } })],
    patterns: [{ id: "p", lengthSteps: 128, notes: { ref: one(0, 45), hp: one(1, 45), left: one(2, 45), tri: one(3, 60), comp: one(4, 60), wet: one(5, 60), clave: one(6, 75), echo: one(7, 75) } }],
  }));
  const m = await mcp(file);
  try {
    const w = pcm((await m.call("audio_export", { file: "fx.wav" })).file), at = (bar: number) => bar * 2;
    const low = [0, 1].map((b) => db(tone(w, 110, at(b) + 0.05, at(b) + 0.45)));
    const lr = [db(rms(w, at(2) + 0.05, at(2) + 0.45, "l")), db(rms(w, at(2) + 0.05, at(2) + 0.45, "r"))];
    const contrast = [3, 4].map((b) => db(rms(w, at(b) + 0.01, at(b) + 0.04)) - db(rms(w, at(b) + 0.38, at(b) + 0.45))); // the attack's bump over the held level
    const tail = [3, 5].map((b) => db(rms(w, at(b) + 1.2, at(b) + 1.9)));
    const echo = [6, 7].map((b) => db(rms(w, at(b) + 0.5, at(b) + 0.56)) - db(rms(w, at(b) + 0.25, at(b) + 0.31))); // a beat after the clave, against half a beat after it
    t.diagnostic(`110 Hz: ${low.map((x) => x.toFixed(1)).join(" → ")} dB; pan L ${lr[0].toFixed(1)} R ${lr[1].toFixed(1)}; attack bump ${contrast.map((x) => x.toFixed(1)).join(" → ")} dB; tail ${tail.map((x) => x.toFixed(1)).join(" → ")} dB; echo ${echo.map((x) => x.toFixed(1)).join(" → ")} dB`);
    assert.ok(low[1] < low[0] - 20, "the highpass keeps the 110 Hz fundamental");
    assert.ok(lr[0] - lr[1] > 20, "pan -1 is not on the left");
    assert.ok(contrast[1] < contrast[0] - 3, "the compressor does not even out the attack");
    assert.ok(tail[1] > tail[0] + 20, "the reverb send leaves no tail");
    assert.ok(echo[0] < 3 && echo[1] > 15, "the delay has no repeat a beat later");
  } finally { await m.client.close(); await s.close(); }
});
