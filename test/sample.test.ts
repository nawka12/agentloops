// The `sample` sound: a channel that plays audio files from the song's folder. Validation, the file route and the versions in state/score run in Node;
// the renders (pitch, timing, a rewritten file, a missing file) run in headless Chromium.
import { test } from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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

/** a mono 16-bit WAV of a sine */
function sine(hz: number, seconds = 0.5, amp = 0.5, rate = 44100) {
  const n = Math.round(seconds * rate), b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin((2 * Math.PI * hz * i) / rate)), 44 + i * 2);
  return b;
}
const ch = (id: string, sound: string, keys: number[], extra: any = {}) => ({ id, name: id, sound, polyphony: 8, generator: { plugin: "script", params: { code: "return 'x';" } }, keymap: keys.map((key) => ({ key, name: String(key), template: "x" })), ...extra });
const song = (o: any) => ({ format: "agentloops/1", name: "Sfx", clock: { bpm: 120 }, arrangements: [{ id: "a", clips: [{ ref: "p", start: "1:01" }] }], ...o });
/** a song folder with sfx/riser.wav (a 440 Hz sine) and a `fx` sample channel mapping key 60 to it */
async function setup(extra: any = {}, notes: any[] = [{ start: "2:01", len: 96, key: 60 }]) {
  const dir = mkdtempSync(join(tmpdir(), "alp-sample-test-")), file = join(dir, "song.alp.json");
  mkdirSync(join(dir, "sfx")); writeFileSync(join(dir, "sfx/riser.wav"), sine(440));
  writeFileSync(file, JSON.stringify(song({ mix: { master: "none" }, channels: [ch("fx", "sample", [60, 62, 64, 72], { samples: { "60": "sfx/riser.wav" }, ...extra })], patterns: [{ id: "p", lengthSteps: 64, notes: { fx: notes } }] })));
  return { dir, file, s: await studio({ file, port: 0 }) };
}
const json = async (url: string) => (await fetch(url)).json() as Promise<any>;
/** GET with the path exactly as written (fetch would normalise `..`) */
const rawGet = (base: string, path: string) => new Promise<{ status: number; type?: string; cache?: string; body: Buffer }>((ok, bad) => {
  const u = new URL(base);
  get({ host: u.hostname, port: u.port, path }, (r) => { const cs: Buffer[] = []; r.on("data", (c) => cs.push(c)); r.on("end", () => ok({ status: r.statusCode!, type: r.headers["content-type"], cache: r.headers["cache-control"] as string, body: Buffer.concat(cs) })); }).on("error", bad);
});

test("validator: a sample channel needs samples; samples need the sample sound; keys and paths are checked", () => {
  const v = (c: any) => validate(song({ channels: [{ ...ch("c", "sample", [60]), ...c }], patterns: [{ id: "p" }] }));
  const at = (errs: any[], path: string) => errs.find((e) => e.path === path);
  assert.deepEqual(v({ samples: { "60": "sfx/riser.wav", "0": "a.ogg", "127": "dir/b.FLAC", "36": "x/y z/c.mp3" } }), []);
  for (const c of [{}, { samples: {} }, { samples: [] }, { samples: "sfx/a.wav" }]) {
    const e = at(v(c), "/channels/0/samples");
    assert.ok(e?.message.includes("needs samples") && e.fix, JSON.stringify(c));
  }
  const other = validate(song({ channels: [ch("c", "sine", [60], { samples: { "60": "a.wav" } })], patterns: [{ id: "p" }] }));
  assert.match(at(other, "/channels/0/samples")?.message, /only work with "sound": "sample"/); assert.ok(at(other, "/channels/0/samples").fix);
  assert.ok(at(validate(song({ channels: [{ ...ch("c", "auto", [60]), sound: undefined, samples: { "60": "a.wav" } }], patterns: [{ id: "p" }] })), "/channels/0/samples"));
  for (const k of ["-1", "128", "60.5", "060", "c4", "", "1e1"]) {
    const e = at(v({ samples: { [k]: "a.wav" } }), `/channels/0/samples/${k}`);
    assert.ok(e?.message.includes("bad key") && e.fix, `key ${JSON.stringify(k)}`);
  }
  for (const f of ["/etc/a.wav", "C:/a.wav", "../a.wav", "sfx/../../a.wav", "sfx/./a.wav", "sfx//a.wav", "sfx\\a.wav", "a.txt", "a", "a.wav/b", "", 5, null]) {
    const e = at(v({ samples: { "60": f } }), "/channels/0/samples/60");
    assert.ok(e?.message.includes("bad sample file") && e.fix, `path ${JSON.stringify(f)}: ${JSON.stringify(e)}`);
  }
});

test("GET /api/file serves the song folder's audio and nothing else", async () => {
  const { dir, s } = await setup(), out = mkdtempSync(join(tmpdir(), "alp-sample-out-"));
  try {
    writeFileSync(join(dir, "sfx/a.ogg"), "x"); writeFileSync(join(dir, "sfx/b.flac"), "x"); writeFileSync(join(dir, "sfx/c.mp3"), "x"); writeFileSync(join(dir, "sfx/my riser.wav"), sine(220)); writeFileSync(join(dir, "notes.txt"), "secret");
    writeFileSync(join(out, "evil.wav"), sine(100)); symlinkSync(join(out, "evil.wav"), join(dir, "sfx/link.wav")); symlinkSync(out, join(dir, "sfx/outdir")); symlinkSync(join(dir, "song.alp.json"), join(dir, "sfx/song.wav")); // out of the folder, a folder out of it, and a song disguised as audio
    const ok = await rawGet(s.url, "/api/file/sfx/riser.wav?v=1");
    assert.equal(ok.status, 200); assert.equal(ok.type, "audio/wav"); assert.equal(ok.cache, "no-store"); assert.deepEqual(ok.body, readFileSync(join(dir, "sfx/riser.wav")));
    for (const [f, type] of [["a.ogg", "audio/ogg"], ["b.flac", "audio/flac"], ["c.mp3", "audio/mpeg"]]) { const r = await rawGet(s.url, `/api/file/sfx/${f}`); assert.equal(r.status, 200, f); assert.equal(r.type, type); }
    assert.deepEqual((await rawGet(s.url, "/api/file/sfx/my%20riser.wav")).body, readFileSync(join(dir, "sfx/my riser.wav")), "a name with a space, encoded");
    const bad = ["/api/file/../song.alp.json", "/api/file/sfx/../../etc/passwd", "/api/file/%2e%2e/song.alp.json", "/api/file/%2e%2e/%2e%2e/etc/passwd", "/api/file/sfx/%2e%2e/%2e%2e/etc/passwd", "/api/file/..%2fsong.alp.json", "/api/file/sfx%2f..%2f..%2fetc%2fpasswd.wav",
      "/api/file//etc/passwd", "/api/file/%2fetc%2fpasswd", "/api/file/%2Fetc%2Fpasswd.wav", "/api/file/sfx%5C..%5Criser.wav", "/api/file/notes.txt", "/api/file/song.alp.json", "/api/file/sfx/missing.wav?v=missing", "/api/file/sfx", "/api/file/sfx/",
      "/api/file/sfx/link.wav", "/api/file/sfx/outdir/evil.wav", "/api/file/sfx/song.wav", "/api/file/sfx/%E0%A4%A.wav", "/api/file/"];
    for (const path of bad) { const r = await rawGet(s.url, path); assert.equal(r.status, 404, `${path} -> ${r.status}`); assert.ok(!r.body.includes("secret") && !r.body.includes("agentloops/1"), path); }
  } finally { await s.close(); }
});

test("state and score carry each sample file's URL, versioned by the file: a rewrite changes it, a missing file gets ?v=missing", async () => {
  const { dir, s } = await setup({ samples: { "60": "sfx/riser.wav", "62": "sfx/none.wav" } });
  try {
    const urls = async () => ((await json(s.url + "api/state")).sampleUrls.fx), score = async () => (await json(s.url + "api/score?arrangement=a")).channels[0].samples;
    const a = await urls();
    assert.match(a["60"], /^\/api\/file\/sfx\/riser\.wav\?v=[\d.]+-44144$/); assert.equal(a["62"], "/api/file/sfx/none.wav?v=missing");
    assert.deepEqual(await score(), a); assert.equal((await rawGet(s.url, a["60"])).status, 200); assert.equal((await rawGet(s.url, a["62"])).status, 404);
    assert.deepEqual(await urls(), a, "unchanged while the file is");
    const boot = /<script id="boot" type="application\/json">(.*?)<\/script>/.exec(await (await fetch(s.url)).text())![1];
    assert.deepEqual(JSON.parse(boot).sampleUrls.fx, a, "the first paint has them too");
    writeFileSync(join(dir, "sfx/riser.wav"), sine(660, 0.25)); // a different size
    const b = await urls(); assert.notEqual(b["60"], a["60"]); assert.deepEqual(await score(), b);
    const t = new Date(Date.now() + 5000); utimesSync(join(dir, "sfx/riser.wav"), t, t); // the same size, a later time
    const c = await urls(); assert.notEqual(c["60"], b["60"]);
    writeFileSync(join(dir, "sfx/none.wav"), sine(100)); assert.match((await urls())["62"], /^\/api\/file\/sfx\/none\.wav\?v=[\d.]+-\d+$/, "a file that turns up gets a real version");
    assert.equal((await json(s.url + "api/state")).sampleUrls.other, undefined);
  } finally { await s.close(); }
});

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
  return { rate, l, r };
}
type Pcm = ReturnType<typeof pcm>;
/** the frequency of the `len` seconds from `from`: upward zero crossings, first to last */
function freq(w: Pcm, from: number, len: number) {
  const cx: number[] = [];
  for (let i = Math.floor(from * w.rate); i < (from + len) * w.rate; i++) if (w.l[i] < 0 && w.l[i + 1] >= 0) cx.push(i - w.l[i] / (w.l[i + 1] - w.l[i]));
  return ((cx.length - 1) * w.rate) / (cx.at(-1)! - cx[0]);
}
const peak = (w: Pcm, from: number, to: number) => { let m = 0; for (let i = Math.floor(from * w.rate); i < to * w.rate; i++) m = Math.max(m, Math.abs(w.l[i])); return m; };

// 120 BPM, a bar is 2 s: key 60 at 2 s (the file as it is), key 72 at 4 s (an octave up, repitched)
test("sample: the file plays at its note, an octave up for key 72, a rewritten file is heard at the next export, a missing one fails the export by name", { skip, timeout: 300_000 }, async (t) => {
  const { dir, file, s } = await setup({}, [{ start: "2:01", len: 24, key: 60 }, { start: "3:01", len: 24, key: 72 }]);
  const m = await mcp(file);
  try {
    const w = pcm((await m.call("audio_export", { file: "a.wav" })).file);
    const f60 = freq(w, 2.05, 0.4), f72 = freq(w, 4.05, 0.2);
    t.diagnostic(`key 60: ${f60.toFixed(1)} Hz, key 72: ${f72.toFixed(1)} Hz, peak ${peak(w, 2, 2.5).toFixed(3)}, silence before: ${peak(w, 0, 1.99).toExponential(1)}, after the 0.5 s file: ${peak(w, 2.6, 3.9).toExponential(1)}`);
    assert.ok(Math.abs(f60 - 440) < 3, `key 60 plays the file as recorded: ${f60}`);
    assert.ok(Math.abs(f72 - 880) < 6, `key 72 is an octave up: ${f72}`);
    assert.ok(peak(w, 0, 1.99) < 1e-4, "silent before the note");
    assert.ok(peak(w, 2.6, 3.9) < 1e-4, "silent after the file ends (a 24-tick note, but the file plays whole) and before the next note");
    const p = peak(w, 2, 2.5); assert.ok(p > 0.38 && p < 0.42, `played at the level it was recorded (0.5), times the render's 0.8 master volume: ${p}`);
    // the onset is on the note: within 10 ms of 2.0 s
    let on = 0; while (Math.abs(w.l[on]) < 0.01 || on < 1.9 * w.rate) on++;
    assert.ok(Math.abs(on / w.rate - 2) < 0.01, `onset at ${on / w.rate} s`);

    writeFileSync(join(dir, "sfx/riser.wav"), sine(660)); // rewritten in place
    const w2 = pcm((await m.call("audio_export", { file: "b.wav" })).file), g60 = freq(w2, 2.05, 0.4), g72 = freq(w2, 4.05, 0.2);
    t.diagnostic(`after the rewrite: key 60 ${g60.toFixed(1)} Hz, key 72 ${g72.toFixed(1)} Hz`);
    assert.ok(Math.abs(g60 - 660) < 4, `the new file is heard: ${g60}`); assert.ok(Math.abs(g72 - 1320) < 9, `and repitched: ${g72}`);

    await m.call("project_patch", { ops: [{ op: "add", path: "/channels/0/samples/60", value: "sfx/gone.wav" }] });
    await assert.rejects(m.call("audio_export", { file: "c.wav" }), /sample files failed to load: sfx\/gone\.wav/);
  } finally { await m.client.close(); await s.close(); }
});

test("sample: several keys are a kit (the nearest mapped key's file, repitched), vel sets the level, pan and mix apply, a bend bends it", { skip, timeout: 300_000 }, async (t) => {
  const { dir, file, s } = await setup({ samples: { "60": "sfx/riser.wav", "64": "sfx/high.wav" }, mix: { pan: 1, reverb: 0 } }, [
    { start: "1:01", len: 24, key: 64 }, { start: "2:01", len: 24, key: 62 }, { start: "3:01", len: 24, key: 60, vel: 1 }, { start: "4:01", len: 24, key: 60, bend: [[0, 12]] }]);
  writeFileSync(join(dir, "sfx/high.wav"), sine(1000));
  const m = await mcp(file);
  try {
    const wp = pcm((await m.call("audio_export", { file: "kit.wav" })).file), wr = { ...wp, l: wp.r }; // panned right (mix.pan 1): the left side is silent, so the right is read
    const f64 = freq(wr, 0.05, 0.3), f62 = freq(wr, 2.05, 0.3), f60 = freq(wr, 4.05, 0.3), fb = freq(wr, 6.1, 0.3);
    t.diagnostic(`64 (own file): ${f64.toFixed(1)}, 62 (nearest: 60's file, tie to the lower, +2): ${f62.toFixed(1)}, 60: ${f60.toFixed(1)}, bent +12: ${fb.toFixed(1)}`);
    assert.ok(Math.abs(f64 - 1000) < 7, `the key's own file: ${f64}`);
    assert.ok(Math.abs(f62 - 440 * 2 ** (2 / 12)) < 4, `62 is 2 and 2 from 60 and 64: the lower wins, 2 semitones up: ${f62}`);
    assert.ok(Math.abs(fb - 880) < 8, `a +12 bend: ${fb}`);
    // vel 1 is 1.5x the level of vel 0.5
    const loud = peak(wr, 4, 4.5), soft = peak(wr, 2, 2.5);
    t.diagnostic(`right peaks: vel 1 ${loud.toFixed(3)}, vel 0.5 ${soft.toFixed(3)}; left ${peak(wp, 4, 4.5).toExponential(1)}`);
    assert.ok(peak(wp, 4, 4.5) < 1e-3, "panned hard right: the left is silent");
    assert.ok(loud / soft > 1.3 && loud / soft < 1.7, `vel 1 is 1.5x vel 0.5: ${loud / soft}`);
  } finally { await m.client.close(); await s.close(); }
});
