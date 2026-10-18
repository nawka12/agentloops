import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { render } from "../src/engine.ts";
import { MANUAL, validate } from "../src/project.ts";
import { openTakes } from "../src/takes.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "alp-"));
const p1 = () => JSON.parse(readFileSync(join(root, "examples/p1.alp.json"), "utf8"));

async function studio(...args: string[]) {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--disable-warning=ExperimentalWarning", join(root, "src/cli.ts"), "mcp", ...args] }));
  /** Call a tool; throws on isError; parses JSON when the text is JSON. */
  const call = async (name: string, a: any = {}, opts?: any): Promise<any> => {
    const r: any = await client.callTool({ name, arguments: a }, undefined, opts);
    const t = r.content[0].text;
    if (r.isError) throw new Error(t);
    try { return JSON.parse(t); } catch { return t; }
  };
  return { client, call };
}

test("Studio MCP round trip: build P1 from scratch with tools, run it, read the take, undo", async () => {
  const dir = tmp(), file = join(dir, "song.alp.json");
  const { client, call } = await studio("--scope", "run");
  try {
    const src = p1();
    const created = await call("project_create", { path: file, name: "P1", starter: false });
    assert.equal(created.ok, true);
    assert.equal(created.errorCount, 1); // an empty skeleton has nothing to render

    // editing passes through invalid states: channels route to buses that do not exist yet
    for (const channel of src.channels) delete channel.color;
    const r1 = await call("channel_upsert", { channel: src.channels[0] });
    assert.ok(r1.errorCount > 0 && r1.errors.every((e: any) => e.path && e.message && e.fix), JSON.stringify(r1));
    await call("channel_upsert", { channel: src.channels[1] });
    for (const bus of src.mixer.buses) await call("bus_upsert", { bus });
    await call("bus_upsert", { bus: { id: "master", ...src.mixer.master } });
    const pat = src.patterns[0];
    pat.notes.writer.forEach((n: any) => (n.start = "1:01")); // "bar:step" strings
    await call("pattern_upsert", { pattern: pat });
    const last = await call("arrangement_upsert", { arrangement: src.arrangements[0] });
    assert.equal(last.errorCount, 0, JSON.stringify(last.errors));
    assert.deepEqual(await call("project_validate"), { ok: true, errors: [] });
    assert.equal(JSON.parse(readFileSync(file, "utf8")).patterns[0].notes.critic[0].start, "1:09"); // saved as pretty JSON

    // upserts shallow-merge by id
    const up = await call("channel_upsert", { channel: { id: "writer", polyphony: 2 } });
    assert.equal(up.action, "updated");
    const w = (await call("project_get")).channels[0];
    assert.equal(w.polyphony, 2);
    assert.equal(w.name, "Writer");
    assert.match(await call("score_view"), /ARRANGEMENT Main/);
    assert.equal((await call("project_get", { summary: true })).channels.length, 2);
    assert.ok((await call("plugin_search", { query: "gate" })).some((x: any) => x.id === "fx.gate"));

    // run (with progress notifications), then the take
    let progress = 0;
    const run = await call("run_start", { input: { topic: "CRDTs" } }, { onprogress: () => progress++ });
    assert.equal(run.status, "done");
    assert.equal(run.passes, 3);
    assert.equal(run.master.length, 1);
    assert.match(run.master[0].text, /^Revision \(pass 2\)/);
    assert.ok(progress >= 3, `progress notifications: ${progress}`);
    const take = await call("take_get", { id: run.runId });
    assert.equal(take.passes, 3);
    assert.equal(take.voices.length, 6);
    assert.match(take.master[0].text, /^Revision \(pass 2\)/);
    assert.equal((await call("take_get", { id: run.runId, frames: true, channel: "critic" })).length, 3);
    assert.equal((await call("take_list")).length, 1);
    const again = await call("run_start", { input: { topic: "CRDTs" }, cache: "prefer" });
    assert.equal(again.cacheHits, 6);

    // wait:false + run_status
    const bg = await call("run_start", { wait: false });
    assert.equal(bg.status, "running");
    let st: any;
    for (let i = 0; i < 100 && (st = await call("run_status", { runId: bg.runId })).status === "running"; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(st.status, "done");

    // undo reverts exactly the last edit; a malformed patch is rejected and changes nothing
    const patched = await call("project_patch", { ops: [{ op: "replace", path: "/name", value: "Renamed" }, { op: "test", path: "/name", value: "Renamed" }] });
    assert.equal((await call("project_get")).name, "Renamed");
    await assert.rejects(call("project_patch", { ops: [{ op: "replace", path: "/name", value: "X" }, { op: "remove", path: "/nope/x" }] }), /op 1/);
    await assert.rejects(call("project_patch", { ops: [{ op: "frobnicate", path: "/name" }] }), /unknown op/);
    await assert.rejects(call("channel_upsert", { channel: { name: "no id" } }), /string id/);
    const undone = await call("undo");
    assert.equal(undone.undoDepth, patched.undoDepth - 1);
    assert.equal((await call("project_get")).name, "P1");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).name, "P1");
    assert.equal((await call("project_get")).channels[0].polyphony, 2); // the earlier edit survived
  } finally { await client.close(); }
});

test("cancelling run_start stops the run at the next barrier", async () => {
  const dir = tmp(), file = join(dir, "song.alp.json");
  const { client, call } = await studio("--scope", "run");
  try {
    await call("project_create", { path: file, starter: false });
    await call("channel_upsert", { channel: { id: "s", name: "S", generator: { plugin: "script", params: { code: "await new Promise(r => setTimeout(r, 400)); return 'slow';" } }, keymap: [{ key: 60, name: "go", template: "go" }] } });
    await call("pattern_upsert", { pattern: { id: "p", notes: { s: [{ start: "1:01", len: 24 }, { start: "1:05", len: 24 }] } } });
    await call("arrangement_upsert", { arrangement: { id: "a", clips: [{ ref: "p", start: "1:01" }] } });
    const ac = new AbortController();
    const started = call("run_start", {}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    await assert.rejects(started);
    let st: any;
    for (let i = 0; i < 100 && (st = await call("run_status")).status === "running"; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(st.status, "stopped");
    assert.equal(st.stopped, "aborted");
    assert.equal(st.voicesRun, 1); // the second note never started
  } finally { await client.close(); }
});

test("scopes: read lists no edit or run tools; edit has no run tools", async () => {
  const names = async (scope: string) => {
    const { client } = await studio("--scope", scope);
    try { return (await client.listTools()).tools.map((t) => t.name); } finally { await client.close(); }
  };
  const read = await names("read"), edit = await names("edit");
  assert.ok(read.includes("project_get") && read.includes("score_view") && read.includes("take_get"));
  for (const n of ["project_create", "project_patch", "channel_upsert", "undo", "run_start", "run_stop"]) assert.ok(!read.includes(n), n);
  assert.ok(edit.includes("project_patch") && edit.includes("undo"));
  for (const n of ["run_start", "run_status", "run_stop"]) assert.ok(!edit.includes(n), n);
  // the default scope is edit
  const { client } = await studio();
  try {
    assert.ok(!(await client.listTools()).tools.some((t) => t.name === "run_start"));
    assert.match((await client.readResource({ uri: "agentloops://manual" })).contents[0].text as string, /^# AgentLoops manual/);
  } finally { await client.close(); }
});

test("llm.agent runs a tool loop through MCP against a fake Anthropic API", async () => {
  const calls: any[] = [];
  const api = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const body = JSON.parse(b);
      calls.push(body);
      const lastMsg = body.messages.at(-1), result = Array.isArray(lastMsg.content) && lastMsg.content.find((c: any) => c.type === "tool_result");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "msg_1", type: "message", role: "assistant", model: body.model, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 },
        stop_reason: result ? "end_turn" : "tool_use",
        content: result ? [{ type: "text", text: `final: ${result.content}` }] : [{ type: "tool_use", id: "toolu_1", name: "echo__echo", input: { text: "hello" } }],
      }));
    });
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(api.address() as any).port}`;
  process.env.ANTHROPIC_API_KEY = "test-key";
  const dir = tmp(), log = join(dir, "echo.log");
  const p: any = {
    format: "agentloops/1", name: "agent",
    tools: { echo: { mcp: { command: process.execPath, args: ["--disable-warning=ExperimentalWarning", join(root, "test/fixtures/echo-mcp.ts")], env: { ECHO_LOG: log } } } },
    channels: [{ id: "a", name: "A", generator: { plugin: "llm.agent", params: { model: "claude-sonnet-5-5", tools: ["echo.echo"] } }, keymap: [{ key: 60, name: "go", template: "use the tool" }] }],
    patterns: [{ id: "p", notes: { a: [{ start: "1:01", len: 24 }, { start: "1:01", len: 24 }] } }], // a chord: two voices share one connection
    arrangements: [{ id: "m", clips: [{ ref: "p", start: "1:01" }] }],
  };
  try {
    assert.deepEqual(validate(p), []);
    const r = await render({ p, dir }, {});
    assert.equal(r.stopped, null, String(r.stopped));
    assert.equal(r.master.length, 2);
    assert.equal(r.master[0].text, "final: echo: hello");
    assert.ok(r.costUsd > 0);
    assert.equal(calls.length, 4); // 2 voices x (tool_use, final)
    assert.deepEqual(calls[0].tools.map((t: any) => t.name), ["echo__echo"]); // `secret` is not allow-listed
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1); // one connection for the run

    const t = openTakes(dir);
    const frames = t.frames(r.takeId, { channel: "a" });
    t.close();
    assert.deepEqual(frames.map((f) => f.kind).sort(), ["message", "message", "tool_call", "tool_call", "tool_result", "tool_result"]);
    const tr = frames.find((f) => f.kind === "tool_result");
    assert.equal(tr.trust, "untrusted");
    assert.equal(tr.text, "echo: hello");
    assert.equal(frames.filter((f) => f.final).length, 2);

    // maxTurns bounds the loop: the fake API would keep asking for the tool, so one turn cannot finish
    const q = structuredClone(p);
    q.channels[0].generator.params.maxTurns = 1;
    q.channels[0].onFail = "skip"; q.channels[0].retries = 0;
    const r2 = await render({ p: q, dir });
    const t2 = openTakes(dir), errs = t2.frames(r2.takeId, { kind: "error" });
    t2.close();
    assert.match(errs[0].text, /maxTurns=1/);
  } finally { api.close(); }
});

test("validate: unknown tool servers and bad references are errors; the old 'not supported yet' error is gone", () => {
  const ch = (tools: any, plugin = "llm.agent") => ({ id: "a", name: "A", generator: { plugin, params: { tools, ...(plugin === "script" ? { code: "return 1" } : {}) } }, keymap: [{ key: 60, name: "go", template: "x" }] });
  const base = (channel: any, tools?: any) => ({ format: "agentloops/1", name: "t", tools, channels: [channel], patterns: [{ id: "p", notes: { a: [{ start: "1:01" }] } }], arrangements: [{ id: "m", clips: [{ ref: "p" }] }] });
  const srv = { web: { mcp: { command: "x", args: ["y"] } } };
  assert.deepEqual(validate(base(ch(["web", "web.search"]), srv)), []);
  const errs = validate(base(ch(["nope", "web.", 3]), srv));
  assert.deepEqual(errs.map((e) => e.path), ["/channels/0/generator/params/tools/0", "/channels/0/generator/params/tools/1", "/channels/0/generator/params/tools/2"]);
  assert.match(errs[0].message, /Unknown tool server 'nope'/);
  assert.ok(validate(base(ch(["web"], "script"), srv)).some((e) => /do not use tools/.test(e.message)));
  assert.ok(validate(base(ch([]), { "bad.name": { mcp: { command: "x" } }, nocmd: {} })).length >= 2);
  assert.ok(!validate(base(ch(["web"]), srv)).some((e) => /not supported yet/.test(e.message)));
});

test("the manual's example project is valid and renders to the approved pass-2 draft", async () => {
  const json = /```json\n([\s\S]*?)\n```/.exec(MANUAL)![1];
  const p = JSON.parse(json);
  assert.deepEqual(validate(p), []);
  const r = await render({ p, dir: tmp() }, { input: { topic: "CRDTs" } });
  assert.equal(r.passes, 3);
  assert.match(r.master[0].text, /^Revision \(pass 2\)/);
});
