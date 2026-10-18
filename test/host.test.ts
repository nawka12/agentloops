import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { studio } from "../src/studio.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "alp-host-"));

/** A temp project (P1 by default) with a studio on port 0. */
async function setup(p?: any) {
  const dir = tmp(), file = join(dir, "song.alp.json");
  if (p) writeFileSync(file, JSON.stringify(p)); else copyFileSync(join(root, "examples/p1.alp.json"), file);
  const s = await studio({ file, port: 0 });
  const get = async (path: string) => (await fetch(s.url + path.slice(1))).json() as any;
  const post = async (path: string, body: any = {}) => { const r = await fetch(s.url + path.slice(1), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; };
  return { dir, file, s, get, post, info: () => JSON.parse(readFileSync(join(dir, ".agentloops/studio.json"), "utf8")) };
}

/** `agentloops mcp --project file`, as the client "claude-code". `call` throws on isError and parses JSON text. */
async function mcp(file: string, scope = "run") {
  const client = new Client({ name: "claude-code", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--disable-warning=ExperimentalWarning", join(root, "src/cli.ts"), "mcp", "--project", file, "--scope", scope] }));
  const call = async (name: string, a: any = {}, opts?: any): Promise<any> => {
    const r: any = await client.callTool({ name, arguments: a }, undefined, opts);
    if (r.isError) throw new Error(r.content[0].text);
    try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; }
  };
  return { client, call };
}

/** Collect /api/events; `next(pred)` resolves with the first matching {type, data}. */
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
  const next = (pred: (e: any) => boolean, ms = 3000) => new Promise<any>((ok, bad) => {
    const hit = seen.find(pred); if (hit) return ok(hit);
    const t = setTimeout(() => bad(new Error(`no matching SSE event; saw ${JSON.stringify(seen.map((e) => e.type))}`)), ms);
    waiters.push({ pred, ok: (e: any) => { clearTimeout(t); ok(e); } });
  });
  return { next, close: () => ac.abort() };
}

const slow = { plugin: "script", params: { code: "await new Promise(r => setTimeout(r, 400)); return 'slow';" } };
const H = { plugin: "harness", params: {} };
const song = (generator: any, notes: any[]) => ({
  format: "agentloops/1", name: "t",
  channels: [{ id: "c", name: "C", generator, keymap: [{ key: 60, name: "go", template: "go {{note.text}}" }] }],
  patterns: [{ id: "p", notes: { c: notes } }], arrangements: [{ id: "a", clips: [{ ref: "p", start: "1:01" }] }],
});

test("relay: with a studio open, an MCP edit lands in the studio host's state at once, labelled with the client", async () => {
  const { s, file, get } = await setup();
  const m = await mcp(file);
  try {
    assert.deepEqual(await m.call("studio_status"), { host: "studio", studioUrl: s.url, file, scope: "run" });
    await m.call("channel_upsert", { channel: { id: "critic", polyphony: 3 } });
    const st = await get("/api/state"); // no waiting for the file watcher or an SSE push
    assert.equal(st.project.channels[1].polyphony, 3);
    const e = st.events.findLast((e: any) => e.type === "edit");
    assert.deepEqual([e.source, e.tool, e.summary], ["mcp:claude-code", "channel_upsert", "critic"]);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).channels[1].polyphony, 3);
  } finally { await m.client.close(); await s.close(); }
});

test("shared undo: one stack for the studio and MCP, each entry says who made it", async () => {
  const { s, file, get, post } = await setup();
  const m = await mcp(file);
  try {
    await post("/api/patch", { ops: [{ op: "replace", path: "/name", value: "By studio" }], summary: "renamed" });
    const u = await m.call("undo"); // an MCP undo reverts the studio's edit
    assert.deepEqual(u.undone, { source: "studio", tool: "project_patch", summary: "renamed" });
    assert.equal((await get("/api/state")).project.name, "Draft-Critique-Revise");

    await m.call("channel_upsert", { channel: { id: "writer", polyphony: 2 } });
    const r = await post("/api/undo"); // and the studio's undo reverts an MCP edit
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.undone, { source: "mcp:claude-code", tool: "channel_upsert", summary: "writer" });
    assert.equal((await get("/api/state")).project.channels[0].polyphony, 1); // back to P1's original
    const ev = (await get("/api/state")).events.filter((e: any) => e.tool === "undo");
    assert.deepEqual(ev.map((e: any) => e.source), ["mcp:claude-code", "studio"]);
    assert.equal((await post("/api/undo")).status, 400); // nothing left
  } finally { await m.client.close(); await s.close(); }
});

test("a run started with Play in the studio can use harness channels: the relayed voice_reply picks up its waiting voice", async () => {
  const { s, file, get, post } = await setup(song(H, [{ start: "1:01", len: 24, text: "hello" }]));
  const m = await mcp(file);
  try {
    assert.equal((await post("/api/run", {})).status, 202);
    const w = await m.call("voice_reply", { replies: [] }); // latest run = the studio's
    assert.equal(w.status, "waiting");
    assert.equal(w.waiting[0].noteText, "hello");
    assert.equal((await get("/api/state")).running, true);
    const done = await m.call("voice_reply", { runId: w.runId, replies: [{ voiceId: w.waiting[0].voiceId, text: "hi" }] });
    assert.equal(done.status, "done");
    assert.equal(done.master[0].text, "hi");
    assert.equal((await get("/api/state")).events.find((e: any) => e.type === "run.start").source, "studio");
  } finally { await m.client.close(); await s.close(); }
});

test("studio_focus emits a focus event; studio_view returns what the UI posted; both error when headless", async () => {
  const { s, file, post } = await setup();
  const ev = await sse(s.url), m = await mcp(file);
  try {
    assert.deepEqual((await m.call("studio_view")).voice, null);
    await m.call("studio_focus", { panel: "tracer", voice: 2 });
    assert.deepEqual((await ev.next((e) => e.type === "focus")).data, { panel: "tracer", voice: 2 });
    await assert.rejects(m.call("studio_focus", { channel: "nope" }), /unknown channel 'nope'/);
    await assert.rejects(m.call("studio_focus", { panel: "sidebar" }), /panel must be one of/);
    const view = { panel: "tracer", pattern: "loop", channel: "critic", voice: 2, selection: "voice:2" };
    await post("/api/view", view); // what the UI does when the selection changes
    assert.deepEqual(await m.call("studio_view"), view);
  } finally { ev.close(); await m.client.close(); await s.close(); }

  const dir = tmp(), file2 = join(dir, "song.alp.json");
  copyFileSync(join(root, "examples/p1.alp.json"), file2);
  const h = await mcp(file2); // no studio for this file
  try {
    assert.equal((await h.call("studio_status")).host, "headless");
    await assert.rejects(h.call("studio_focus", { panel: "mixer" }), /no studio open: run `agentloops studio <file>` to see it/);
    await assert.rejects(h.call("studio_view"), /no studio open/);
  } finally { await h.client.close(); }
});

test("/api/tool needs the bearer token and enforces the caller's scope; the browser never sees the token", async () => {
  const { s, dir, info, get } = await setup();
  const tool = (headers: any, body: any) => fetch(s.url + "api/tool", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    const { token } = info();
    assert.equal(statSync(join(dir, ".agentloops/studio.json")).mode & 0o777, 0o600);
    assert.equal((await tool({}, { name: "project_get" })).status, 401);
    assert.equal((await tool({ authorization: "Bearer nope" }, { name: "project_get" })).status, 401);
    assert.equal((await tool({ authorization: `Bearer ${token}x` }, { name: "project_get" })).status, 401);
    const ok = await tool({ authorization: `Bearer ${token}` }, { name: "project_get", args: { summary: true }, client: "x", scope: "read" });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse((await ok.text()).trim()).result.name, "Draft-Critique-Revise");
    const bad = await tool({ authorization: `Bearer ${token}` }, { name: "channel_upsert", args: { channel: { id: "z" } }, scope: "read" }); // a read-scope caller cannot edit
    assert.match(JSON.parse((await bad.text()).trim()).error, /unknown tool 'channel_upsert' \(scope read\)/);
    assert.ok(!(await (await fetch(s.url)).text()).includes(token));
    assert.ok(!JSON.stringify(await get("/api/state")).includes(token));
  } finally { await s.close(); }
  assert.ok(!existsSync(join(dir, ".agentloops/studio.json"))); // removed on close
});

test("stale studio.json (dead pid, or nothing listening) is ignored and deleted: mcp falls back to headless", async () => {
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid!; // exited: the pid is free
  const port = await new Promise<number>((ok) => { const l = createServer().listen(0, "127.0.0.1", () => { const p = (l.address() as any).port; l.close(() => ok(p)); }); });
  for (const [label, pid] of [["dead pid", dead], ["refused connection", process.pid]] as const) {
    const dir = tmp(), file = join(dir, "song.alp.json"), info = join(dir, ".agentloops/studio.json");
    copyFileSync(join(root, "examples/p1.alp.json"), file);
    mkdirSync(join(dir, ".agentloops"));
    writeFileSync(info, JSON.stringify({ port, token: "t", pid, file }));
    const m = await mcp(file);
    try {
      assert.equal((await m.call("studio_status")).host, "headless", label);
      assert.ok(!existsSync(info), label);
      assert.equal((await m.call("project_get", { summary: true })).name, "Draft-Critique-Revise");
    } finally { await m.client.close(); }
  }
});

test("relayed run_start streams progress notifications; cancelling a non-harness relayed run stops it", async () => {
  const { s, file } = await setup(song(slow, [{ start: "1:01", len: 24 }, { start: "1:05", len: 24 }]));
  const m = await mcp(file);
  try {
    let progress = 0;
    const run = await m.call("run_start", {}, { onprogress: () => progress++ });
    assert.equal(run.status, "done");
    assert.ok(progress >= 2, `progress notifications: ${progress}`);

    const ac = new AbortController();
    const started = m.call("run_start", {}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    await assert.rejects(started);
    let st: any;
    for (let i = 0; i < 100 && (st = await m.call("run_status")).status === "running"; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(st.status, "stopped");
    assert.equal(st.stopped, "aborted");
    assert.equal(st.voicesRun, 1); // the second note never started
  } finally { await m.client.close(); await s.close(); }
});

test("project_replace: a whole song in one undoable edit; malformed projects are refused", async () => {
  const dir = tmp(), file = join(dir, "song.alp.json");
  copyFileSync(join(root, "examples/p1.alp.json"), file);
  const h = await mcp(file);
  try {
    const song = JSON.parse(readFileSync(join(root, "examples/kawaii-bass.alp.json"), "utf8"));
    const r = await h.call("project_replace", { project: song });
    assert.equal(r.errorCount, 0);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).name, song.name); // saved
    await assert.rejects(h.call("project_replace", { project: { name: "no format" } }), /format/);
    const u = await h.call("undo");
    assert.match(u.undone.summary, /replaced the song: Kawaii Bass/);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).name, "Draft-Critique-Revise"); // back to before
  } finally { await h.client.close(); }
});
