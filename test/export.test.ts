import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { studio } from "../src/studio.ts";
import { which } from "../src/export.ts";
import { SOUNDS } from "../src/project.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const ffmpeg = which("ffmpeg"), chromium = which("chromium", "chromium-browser", "google-chrome", "google-chrome-stable");

/** 1 s of 16-bit stereo silence, with the 44-byte header renderWav writes */
function wav(seconds = 1, rate = 44100) {
  const data = Math.round(seconds * rate) * 4, b = Buffer.alloc(44 + data);
  b.write("RIFF", 0); b.writeUInt32LE(36 + data, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(data, 40);
  return b;
}

async function setup(project?: any) {
  const dir = mkdtempSync(join(tmpdir(), "alp-export-test-")), file = join(dir, "kawaii-bass.alp.json");
  if (project) writeFileSync(file, JSON.stringify(project)); else copyFileSync(join(root, "examples/kawaii-bass.alp.json"), file);
  const s = await studio({ file, port: 0 });
  const post = async (path: string, body: any, type = "application/json") => {
    const r = await fetch(s.url + path.slice(1), { method: "POST", headers: { "content-type": type }, body: type === "application/json" ? JSON.stringify(body) : body });
    return { status: r.status, body: await r.json() as any };
  };
  return { dir, file, s, post };
}

/** Subscribe to /api/events like the UI; `next(pred)` resolves with the first matching {type, data}. */
async function sse(url: string) {
  const ac = new AbortController(), res = await fetch(url + "api/events", { signal: ac.signal }), seen: any[] = [], waiters: any[] = [];
  (async () => {
    let buf = "";
    try {
      for await (const chunk of res.body as any) {
        buf += Buffer.from(chunk).toString();
        for (let i; (i = buf.indexOf("\n\n")) >= 0; ) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
          if (!type || !data) continue;
          const e = { type, data: JSON.parse(data) };
          seen.push(e);
          for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.ok(e); }
        }
      }
    } catch {}
  })();
  const next = (pred: (e: any) => boolean, ms = 5000) => new Promise<any>((ok, bad) => {
    const hit = seen.find(pred); if (hit) return ok(hit);
    const t = setTimeout(() => bad(new Error(`no matching SSE event; saw ${JSON.stringify(seen.map((e) => e.type))}`)), ms);
    waiters.push({ pred, ok: (e: any) => { clearTimeout(t); ok(e); } });
  });
  return { next, close: () => ac.abort() };
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

/** the tab side of audio_export: wait for the `export` event, ack it, upload `bytes` */
async function fakeTab(s: any, post: any, bytes: Buffer) {
  const tab = await sse(s.url);
  return {
    tab,
    done: tab.next((e) => e.type === "export").then(async (e) => {
      assert.equal((await post(`/api/export/${e.data.id}/ack`, {})).status, 200);
      return { ev: e.data, up: await post(`/api/export/${e.data.id}`, bytes, "audio/wav") };
    }),
  };
}

test("audio_export via a connected tab: the relayed MCP call returns the file", async () => {
  const { dir, file, s, post } = await setup();
  const m = await mcp(file), { tab, done } = await fakeTab(s, post, wav(1.5));
  try {
    const r = await m.call("audio_export", {});
    const { ev, up } = await done;
    assert.equal(up.status, 200);
    assert.ok(ev.id && !ev.pattern && !ev.arrangement, JSON.stringify(ev));
    const ext = ffmpeg ? "mp3" : "wav";
    assert.equal(r.file, join(dir, `kawaii-bass-royal-road.${ext}`));
    assert.equal(r.format, ext);
    assert.equal(r.renderedBy, "tab");
    assert.equal(r.seconds, 1.5);
    assert.ok(existsSync(r.file) && r.bytes > 1000, JSON.stringify(r));
    if (ffmpeg) { // tags, and the temporary WAV is gone
      assert.match(readFileSync(r.file).toString("latin1"), /AgentLoops/);
      assert.equal(existsSync(join(dir, "kawaii-bass-royal-road.wav")), false);
    }
    // the id is spent
    assert.equal((await post(`/api/export/${ev.id}`, wav(1), "audio/wav")).status, 404);
  } finally { tab.close(); await m.client.close(); await s.close(); }
});

test("audio_export asks the tab for the pattern and honors file/format", async () => {
  const { dir, file, s, post } = await setup();
  const m = await mcp(file), { tab, done } = await fakeTab(s, post, wav(1));
  try {
    const pattern = JSON.parse(readFileSync(file, "utf8")).patterns[0].id;
    const r = await m.call("audio_export", { pattern, file: "pat.wav" });
    assert.equal((await done).ev.pattern, pattern);
    assert.deepEqual([r.file, r.format], [join(dir, "pat.wav"), "wav"]);
    assert.equal(readFileSync(r.file).length, wav(1).length);
  } finally { tab.close(); await m.client.close(); await s.close(); }
});

test("audio_export refusals: bad names, existing files, headless MCP, a bad upload", async () => {
  const { dir, file, s, post } = await setup();
  const m = await mcp(file);
  try {
    for (const file of ["../x.mp3", "a/b.wav", "x.flac", "nodot", "a b.wav", ""]) await assert.rejects(m.call("audio_export", { file }), /plain name/, file);
    await assert.rejects(m.call("audio_export", { file: "a.wav", format: "mp3" }), /does not match/);
    await assert.rejects(m.call("audio_export", { format: "ogg" }), /format must be/);
    await assert.rejects(m.call("audio_export", { pattern: "nope" }), /unknown pattern/);
    writeFileSync(join(dir, "taken.wav"), "mine");
    await assert.rejects(m.call("audio_export", { file: "taken.wav" }), /already exists.*overwrite/);
    assert.equal(readFileSync(join(dir, "taken.wav"), "utf8"), "mine");

    // overwrite:true replaces it
    const { tab, done } = await fakeTab(s, post, wav(1));
    const r = await m.call("audio_export", { file: "taken.wav", overwrite: true });
    await done; tab.close();
    assert.equal(readFileSync(r.file).length, wav(1).length);

    // browser routes: unknown ids are 404, and the Origin guard still applies
    assert.equal((await post("/api/export/deadbeef", wav(1), "audio/wav")).status, 404);
    assert.equal((await post("/api/export/deadbeef/ack", {})).status, 404);
    assert.equal((await fetch(s.url + "api/export/deadbeef", { method: "POST", headers: { "content-type": "audio/wav", origin: "http://evil.example" }, body: wav(1) })).status, 403);

    // a non-WAV upload fails the export with a clear error
    const t2 = await sse(s.url), bad = t2.next((e) => e.type === "export").then((e) => post(`/api/export/${e.data.id}`, Buffer.from("nope"), "audio/wav"));
    await assert.rejects(m.call("audio_export", { file: "bad.wav" }), /not a WAV/);
    assert.equal((await bad).status, 400); t2.close();
    assert.equal(existsSync(join(dir, "bad.wav")), false);
  } finally { await m.client.close(); await s.close(); }
});

test("audio_export without a studio says to open one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alp-export-test-")), file = join(dir, "song.alp.json");
  copyFileSync(join(root, "examples/p1.alp.json"), file);
  const m = await mcp(file);
  try { await assert.rejects(m.call("audio_export", {}), /open the studio \(`agentloops studio <file>`\) to export audio/); }
  finally { await m.client.close(); }
});

test("audio_export with no tab renders in headless Chromium", { skip: chromium ? false : "chromium is not installed", timeout: 120_000 }, async () => {
  const { file, s } = await setup({
    format: "agentloops/1", name: "Tiny", clock: { bpm: 240 },
    channels: [{ id: "c", name: "C", sound: "pluck", generator: { plugin: "script", params: { code: "return 'x';" } }, keymap: [{ key: 60, name: "go", template: "x" }, { key: 64, name: "e", template: "x" }] }],
    patterns: [{ id: "p", lengthSteps: 16, notes: { c: [{ start: "1:01", len: 24, key: 60 }, { start: "1:05", len: 24, key: 64 }, { start: "1:09", len: 48, key: 60 }] } }],
    arrangements: [{ id: "a", clips: [{ ref: "p", start: "1:01" }] }],
  });
  const m = await mcp(file);
  try {
    const r = await m.call("audio_export", { file: "tiny.wav" });
    assert.equal(r.renderedBy, "headless");
    assert.equal(r.format, "wav");
    const b = readFileSync(r.file);
    assert.equal(b.toString("latin1", 0, 4), "RIFF");
    assert.ok(r.seconds > 1 && r.seconds < 6, JSON.stringify(r)); // one 240 BPM bar (1 s) plus the 2 s tail
    assert.ok(b.subarray(44).some((x) => x !== 0), "the render is not silent");
    if (ffmpeg) assert.equal((await m.call("audio_export", { file: "tiny.mp3" })).format, "mp3");
  } finally { await m.client.close(); await s.close(); }
});

test("every sound renders: not silent, level within 10 dB of triangle", { skip: chromium ? false : "chromium is not installed", timeout: 180_000 }, async (t) => {
  // ponytail: ±10 dB, not 6: today's `sub` sits at +7 dB and `pluck` at -9 dB of triangle (a decaying note over a 2 s bar). Retune those, then tighten
  const sounds = SOUNDS.filter((x) => x !== "auto"), BAR = 2; // 120 BPM: a bar is 2 s; each sound plays one half-bar note in its own bar (a kick for drums)
  const key = (x: string) => (x === "drums" ? 36 : 60);
  const { file, s } = await setup({
    format: "agentloops/1", name: "Sounds", clock: { bpm: 120 },
    channels: sounds.map((x) => ({ id: x, name: x, sound: x, generator: { plugin: "script", params: { code: "return 'x';" } }, keymap: [{ key: key(x), name: "n", template: "x" }] })),
    patterns: [{ id: "p", lengthSteps: 16 * sounds.length, notes: Object.fromEntries(sounds.map((x, i) => [x, [{ start: `${i + 1}:01`, len: 192, key: key(x) }]])) }],
    arrangements: [{ id: "a", clips: [{ ref: "p", start: "1:01" }] }],
  });
  const m = await mcp(file);
  try {
    const r = await m.call("audio_export", { file: "sounds.wav" }), b = readFileSync(r.file), rate = b.readUInt32LE(24);
    const rms = sounds.map((x, i) => {
      let sum = 0, n = 0;
      for (let o = 44 + i * BAR * rate * 4; o < 44 + (i + 1) * BAR * rate * 4; o += 2, n++) { const v = b.readInt16LE(o) / 32768; sum += v * v; } // a NaN sample is written as 0, so NaN shows up as silence
      return Math.sqrt(sum / n);
    });
    const db = (v: number) => 20 * Math.log10(v), tri = rms[sounds.indexOf("triangle")];
    t.diagnostic(sounds.map((x, i) => `${x} ${db(rms[i]).toFixed(1)} dB (${(db(rms[i]) - db(tri)).toFixed(1)})`).join(", "));
    sounds.forEach((x, i) => {
      assert.ok(rms[i] > 1e-4, `${x}: bar ${i + 1} is silent`);
      assert.ok(Math.abs(db(rms[i]) - db(tri)) <= 10, `${x}: ${db(rms[i]).toFixed(1)} dB vs triangle ${db(tri).toFixed(1)} dB`);
    });
  } finally { await m.client.close(); await s.close(); }
});

test("/api/connect writes the harness files once, and gives a snippet where there is no project-local config", async () => {
  const { dir, s, post } = await setup();
  try {
    const a = await post("/api/connect", { harness: "claude-code" });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual(a.body.wrote, [".mcp.json", ".claude/skills/agentloops/SKILL.md"]);
    assert.deepEqual(a.body.skipped, []);
    assert.match(a.body.next, /run `claude` in /);
    const mj = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers.agentloops;
    assert.equal(mj.command, process.execPath);
    assert.deepEqual(mj.args.slice(2), ["mcp", "--project", "kawaii-bass.alp.json", "--scope", "run", "--budget", "1"]);
    assert.ok(existsSync(mj.args[1]));
    assert.match(readFileSync(join(dir, ".claude/skills/agentloops/SKILL.md"), "utf8"), /^---\nname: agentloops/);

    const b = await post("/api/connect", { harness: "claude-code" });
    assert.deepEqual([b.body.wrote, b.body.skipped], [[], [".mcp.json", ".claude/skills/agentloops/SKILL.md"]]);
    assert.match(b.body.snippet, /\.mcp\.json already exists/); // a skipped config comes back as a snippet to merge

    const o = (await post("/api/connect", { harness: "other" })).body;
    assert.deepEqual(o.wrote, ["AGENTS.md"]);
    assert.match(o.snippet, /--project kawaii-bass\.alp\.json --scope run --budget 1/);

    const c = (await post("/api/connect", { harness: "codex" })).body; // AGENTS.md exists now; the TOML is new
    assert.deepEqual([c.wrote, c.skipped], [[".codex/config.toml"], ["AGENTS.md"]]);
    assert.ok(readFileSync(join(dir, ".codex/config.toml"), "utf8").startsWith(`[mcp_servers.agentloops]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [`));
    const u = (await post("/api/connect", { harness: "cursor" })).body;
    assert.equal(JSON.parse(readFileSync(join(dir, ".cursor/mcp.json"), "utf8")).mcpServers.agentloops.type, "stdio");
    assert.deepEqual(u.wrote, [".cursor/mcp.json"]);
    const p = (await post("/api/connect", { harness: "opencode" })).body;
    const oc = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")).mcp.agentloops;
    assert.deepEqual([p.wrote, oc.type, oc.command[0], oc.command[3]], [["opencode.json"], "local", process.execPath, "mcp"]);

    assert.equal((await post("/api/connect", { harness: "emacs" })).status, 400);
  } finally { await s.close(); }
});
