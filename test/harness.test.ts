import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { render } from "../src/engine.ts";
import { MANUAL, validate } from "../src/project.ts";
import { studio as startStudio } from "../src/studio.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "alp-h-"));
const H = (params: any = {}) => ({ plugin: "harness", params });
const NO_BRIDGE = /run started from your harness over Studio MCP/;

/** Spawn `agentloops mcp --scope run`, open `p` from a temp file. `call` throws on isError and parses JSON text. */
async function harnessSession(p: any) {
  const dir = tmp(), file = join(dir, "song.alp.json");
  writeFileSync(file, JSON.stringify(p));
  assert.deepEqual(validate(p), []);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--disable-warning=ExperimentalWarning", join(root, "src/cli.ts"), "mcp", "--scope", "run"] }));
  const call = async (name: string, a: any = {}, opts?: any): Promise<any> => {
    const r: any = await client.callTool({ name, arguments: a }, undefined, opts);
    if (r.isError) throw new Error(r.content[0].text);
    try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; }
  };
  await call("project_open", { path: file });
  return { client, call, dir, file };
}
const reply = (call: any, runId: string, ...replies: any[]) => call("voice_reply", { runId, replies });

/** Small project: one harness channel `h` (keymap/params/bus overrides) playing `texts` as a chord at 1:01. */
const chordProject = (texts: string[], extra: { keymap?: any[]; params?: any; buses?: any[]; output?: string } = {}) => ({
  format: "agentloops/1", name: "h",
  channels: [{ id: "h", name: "H", generator: H(extra.params), keymap: extra.keymap ?? [{ key: 60, name: "Do", template: "do {{note.text}}" }], output: extra.output }],
  patterns: [{ id: "p", notes: { h: texts.map((text) => ({ start: "1:01", len: 24, text })) } }],
  arrangements: [{ id: "m", clips: [{ ref: "p", start: "1:01" }] }],
  ...(extra.buses ? { mixer: { buses: extra.buses } } : {}),
});

// P1 from the manual: the Writer becomes a harness channel (the manual's variant block), the Critic stays script and approves on pass 1.
const blocks = [...MANUAL.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
const p1 = () => {
  const p = structuredClone(blocks[0]);
  p.channels[0].generator = blocks[1];
  p.channels[1].generator.params.code = p.channels[1].generator.params.code.replace("n >= 2", "n >= 1");
  p.patterns[0].loop.max = 3;
  return p;
};

test("P1 with a harness Writer: run_start waits, voice_reply feeds the loop, 2 passes, one Master frame; then the cache replays without asking", async () => {
  const { client, call } = await harnessSession(p1());
  try {
    const first = await call("run_start", { input: { topic: "CRDTs" } });
    assert.equal(first.status, "waiting");
    assert.equal(first.waiting.length, 1);
    const w0 = first.waiting[0];
    assert.equal(w0.channel, "writer");
    assert.equal(w0.instruction, "Draft");
    assert.equal(w0.prompt, "Write a draft about: CRDTs");
    assert.match(w0.instructions, /careful technical writer/);
    assert.deepEqual([w0.pass, w0.attempt, w0.runId], [0, 1, first.runId]);
    assert.equal((await call("run_status", { runId: first.runId })).status, "waiting"); // run_status shows it too

    const second = await reply(call, first.runId, { voiceId: w0.voiceId, text: "Draft one" });
    assert.equal(second.status, "waiting");
    const w1 = second.waiting[0];
    assert.equal(second.pass, 1);
    assert.equal(w1.instruction, "Revise");
    assert.equal(w1.pass, 1);
    assert.equal(w1.inputs.review.json.approved, false);
    assert.match(w1.prompt, /^Revise the draft using this review:\nNeeds more detail/);
    assert.deepEqual(w1.history.map((m: any) => m.role), ["user", "assistant"]); // slide: the Draft conversation continues
    assert.equal(w1.inputs.review.trust, undefined); // nothing untrusted here

    await assert.rejects(reply(call, first.runId, { voiceId: w0.voiceId, text: "again" }), /not waiting/); // already answered
    await assert.rejects(reply(call, first.runId, { voiceId: 999, text: "x" }), /not waiting/);
    const done = await reply(call, first.runId, { voiceId: w1.voiceId, text: "Final draft" });
    assert.equal(done.status, "done");
    assert.equal(done.passes, 2);
    assert.equal(done.master.length, 1);
    assert.equal(done.master[0].text, "Final draft");
    assert.equal(done.costUsd, 0);

    const frames = await call("take_get", { id: first.runId, frames: true, channel: "writer" });
    assert.deepEqual(frames.map((f: any) => f.meta.harness), ["test", "test"]); // the MCP client name

    // cache: "prefer" replays both passes, nothing to ask
    const again = await call("run_start", { input: { topic: "CRDTs" }, cache: "prefer" });
    assert.equal(again.status, "done");
    assert.equal(again.cacheHits, 4);
    assert.equal(again.master[0].text, "Final draft");
  } finally { await client.close(); }
});

test("chord: three harness notes arrive in one waiting list; partial answers return the rest at once", async () => {
  const { client, call } = await harnessSession(chordProject(["a", "b", "c"]));
  try {
    const w = await call("run_start", {});
    assert.equal(w.status, "waiting");
    assert.deepEqual(w.waiting.map((r: any) => r.noteText).sort(), ["a", "b", "c"]);
    assert.equal(new Set(w.waiting.map((r: any) => r.voiceId)).size, 3);
    const [x, y, z] = w.waiting;
    const t0 = Date.now();
    const rest = await reply(call, w.runId, { voiceId: x.voiceId, text: "X" }, { voiceId: y.voiceId, text: "Y" });
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(rest.status, "waiting");
    assert.deepEqual(rest.waiting.map((r: any) => r.voiceId), [z.voiceId]);
    const done = await reply(call, w.runId, { voiceId: z.voiceId, text: "Z" });
    assert.equal(done.status, "done");
    assert.equal(done.master.length, 3);
  } finally { await client.close(); }
});

test("schema and validator: a mismatching json is rejected by voice_reply; a validator rejection re-asks with attempt 2 and feedback; error declines", async () => {
  const keymap = [{ key: 60, name: "Rate", template: "rate it", schema: { type: "object", required: ["score"], properties: { score: { type: "number" } } } }];
  const buses = [{ id: "out", slots: [{ plugin: "fx.validator", params: { onFail: "retry", schema: { type: "object", required: ["score", "why"] } } }] }];
  const { client, call } = await harnessSession(chordProject(["r"], { keymap, buses, output: "out" }));
  try {
    const w = await call("run_start", {});
    assert.deepEqual(w.waiting[0].schema, keymap[0].schema);
    const id = w.waiting[0].voiceId;
    await assert.rejects(reply(call, w.runId, { voiceId: id, json: {} }), /score: required/);
    await assert.rejects(reply(call, w.runId, { voiceId: id, text: "prose" }), /schema/); // json is required with a schema
    assert.equal((await call("run_status", { runId: w.runId })).waiting.length, 1); // still waiting: the voice did not fail
    const retry = await reply(call, w.runId, { voiceId: id, json: { score: 1 } });
    assert.equal(retry.status, "waiting");
    assert.equal(retry.waiting[0].attempt, 2);
    assert.match(retry.waiting[0].feedback, /validator.*why: required/);
    const done = await reply(call, w.runId, { voiceId: id, json: { score: 2, why: "ok" } });
    assert.equal(done.status, "done");
    assert.deepEqual(done.master[0].json, { score: 2, why: "ok" });
  } finally { await client.close(); }

  // declining fails the voice through onFail: stop
  const s = await harnessSession(chordProject(["r"]));
  try {
    const w = await s.call("run_start", {});
    const r = await reply(s.call, w.runId, { voiceId: w.waiting[0].voiceId, error: "cannot do that" });
    assert.equal(r.status, "stopped");
    assert.match(r.stopped, /harness declined: cannot do that/);
  } finally { await s.client.close(); }
});

test("run_stop while waiting ends the run as stopped", async () => {
  const { client, call } = await harnessSession(chordProject(["a", "b"]));
  try {
    const w = await call("run_start", {});
    assert.equal(w.waiting.length, 2);
    const stopped = await call("run_stop", { runId: w.runId });
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.waiting, undefined);
    await assert.rejects(reply(call, w.runId, { voiceId: w.waiting[0].voiceId, text: "late" }), /not waiting/);
  } finally { await client.close(); }
});

test("cancelling run_start leaves a harness run going; voice_reply with no replies resumes the wait", async () => {
  const p: any = chordProject(["x"]);
  p.channels.push({ id: "s", name: "S", generator: { plugin: "script", params: { code: "await new Promise(r => setTimeout(r, 400)); return 'slow';" } }, keymap: [{ key: 60, name: "go", template: "go" }] });
  p.patterns[0].notes.s = [{ start: "1:01", len: 24 }];
  p.patterns[0].notes.h = [{ start: "1:05", len: 24, text: "late" }]; // after the slow script's barrier
  const { client, call } = await harnessSession(p);
  try {
    const ac = new AbortController();
    const started = call("run_start", {}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    await assert.rejects(started);
    const w = await call("voice_reply", { replies: [] }); // latest run
    assert.equal(w.status, "waiting");
    assert.equal(w.waiting[0].noteText, "late");
    const done = await reply(call, w.runId, { voiceId: w.waiting[0].voiceId, text: "ok" });
    assert.equal(done.status, "done");
  } finally { await client.close(); }
});

test("two calls blocked on the same run both wake up when it waits again", async () => {
  const p: any = chordProject(["a"]);
  p.channels.push({ id: "s", name: "S", generator: { plugin: "script", params: { code: "await new Promise(r => setTimeout(r, 400)); return 'slow';" } }, keymap: [{ key: 60, name: "go", template: "go" }] });
  p.patterns[0].notes.s = [{ start: "1:01", len: 24 }]; // keeps the run busy after `a` is answered
  p.patterns[0].notes.h.push({ start: "1:05", len: 24, text: "c" });
  const { client, call } = await harnessSession(p);
  try {
    const w = await call("run_start", {});
    assert.deepEqual(w.waiting.map((x: any) => x.noteText), ["a"]);
    const first = reply(call, w.runId, { voiceId: w.waiting[0].voiceId, text: "ok" }); // blocks: nothing waits until `c`
    await new Promise((r) => setTimeout(r, 50));
    const second = call("voice_reply", { runId: w.runId, replies: [] }); // blocks on the same run
    const [x, y] = await Promise.all([first, second]); // a single wake-up slot lost one of these: a deadlock
    for (const r of [x, y]) { assert.equal(r.status, "waiting"); assert.equal(r.waiting[0].noteText, "c"); }
    assert.equal((await reply(call, w.runId, { voiceId: x.waiting[0].voiceId, text: "ok" })).status, "done");
  } finally { await client.close(); }
});

test("no bridge: render() fails a harness voice with the run_start message; a bridge sees the full request, trust, and times out", async () => {
  const p: any = chordProject(["a"]);
  const r = await render({ p, dir: tmp() }, {});
  assert.match(String(r.stopped), NO_BRIDGE);

  // two harness channels in a chain: B reads A's bus, where A's frame is untrusted
  const q: any = chordProject(["a"], { output: "raw", buses: [{ id: "raw", sends: [] }] });
  q.channels.push({ id: "b", name: "B", generator: H({ instructions: "be B" }), keymap: [{ key: 60, name: "Use", template: "use {{inputs.raw}}" }], inputs: [{ bus: "raw", as: "raw" }, { bus: "raw", as: "also" }] });
  q.patterns[0].notes.b = [{ start: "1:09", len: 24 }];
  const seen: any[] = [];
  const r2 = await render({ p: q, dir: tmp() }, { harness: async (req) => { seen.push(req); return [req.channel === "h" ? { text: "web data", trust: "untrusted" } : { text: "done" }]; } });
  assert.equal(r2.stopped, null);
  assert.equal(r2.costUsd, 0);
  assert.equal(seen[1].prompt, "use web data");
  assert.deepEqual(seen[1].inputs.raw, { text: "web data", json: null, trust: "untrusted" });
  assert.equal(seen[1].instructions, "be B");
  assert.equal(seen[0].inputs.raw, undefined);
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(seen[1]))).sort(), // what goes over the wire
    ["attempt", "channel", "channelName", "history", "inputs", "instruction", "instructions", "noteText", "pass", "prompt", "runId", "voiceId"]);

  // timeoutMs: the voice fails and the bridge is told to let go
  let aborted = false;
  const t: any = chordProject(["a"], { params: { timeoutMs: 50 } });
  const r3 = await render({ p: t, dir: tmp() }, { harness: (_req, sig) => new Promise((_, rej) => sig.addEventListener("abort", () => { aborted = true; rej(sig.reason); })) });
  assert.match(String(r3.stopped), /did not reply within 50 ms/);
  assert.ok(aborted);
});

test("studio Play refuses a project with harness channels and says why", async () => {
  const dir = tmp(), file = join(dir, "song.alp.json");
  writeFileSync(file, JSON.stringify(chordProject(["a"])));
  const s = await startStudio({ file, port: 0 });
  try {
    const r = await fetch(s.url + "api/run", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as any).error, NO_BRIDGE);
  } finally { await s.close(); }
});
