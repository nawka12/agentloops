import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { studio } from "../src/studio.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "alp-studio-")), file = join(dir, "p1.alp.json");
  copyFileSync(join(root, "examples/p1.alp.json"), file);
  const s = await studio({ file, port: 0 });
  const get = async (path: string) => (await fetch(s.url + path.slice(1))).json() as any;
  const post = async (path: string, body: any) => { const r = await fetch(s.url + path.slice(1), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; };
  return { dir, file, s, get, post };
}

/** Subscribe to /api/events; `next(pred)` resolves with the first matching {type, data} or rejects after ms. */
async function sse(url: string) {
  const ac = new AbortController(), res = await fetch(url + "api/events", { signal: ac.signal });
  const seen: any[] = [], waiters: { pred: (e: any) => boolean; ok: (e: any) => void }[] = [];
  (async () => {
    let buf = "";
    try {
      for await (const chunk of res.body as any) {
        buf += Buffer.from(chunk).toString();
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
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
  const next = (pred: (e: any) => boolean, ms = 2500) => new Promise<any>((ok, bad) => {
    const hit = seen.find(pred); if (hit) return ok(hit);
    const t = setTimeout(() => bad(new Error(`no matching SSE event within ${ms} ms; saw ${JSON.stringify(seen.map((e) => e.type + ":" + (e.data.type ?? "")))}`)), ms);
    waiters.push({ pred, ok: (e) => { clearTimeout(t); ok(e); } });
  });
  return { next, seen, close: () => ac.abort() };
}

async function mcp(file: string) {
  const client = new Client({ name: "claude-code", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--disable-warning=ExperimentalWarning", join(root, "src/cli.ts"), "mcp", "--project", file] }));
  const call = async (name: string, a: any = {}) => { const r: any = await client.callTool({ name, arguments: a }); if (r.isError) throw new Error(r.content[0].text); return JSON.parse(r.content[0].text); };
  return { client, call };
}

test("studio serves state and type-stripped UI modules", async () => {
  const { s, get } = await setup();
  try {
    const st = await get("/api/state");
    assert.equal(st.project.name, "Draft-Critique-Revise");
    assert.deepEqual(st.errors, []);
    assert.match(st.score, /PATTERN Draft loop/);
    const js = await (await fetch(s.url + "ui/main.ts")).text();
    assert.match(js, /export const esc/);
    assert.doesNotMatch(js, /\(s: any\)|: HTMLElement|type Run =/);
    const html = await (await fetch(s.url)).text();
    assert.match(html, /<script id="boot"/);
    const evil = await fetch(s.url + "api/run", { method: "POST", headers: { "content-type": "text/plain", origin: "http://evil.example" }, body: "{}" });
    assert.equal(evil.status, 403);
  } finally { await s.close(); }
});

test("SSE pushes state when the project file changes on disk", async () => {
  const { s, file } = await setup();
  const ev = await sse(s.url);
  try {
    await new Promise((r) => setTimeout(r, 100));
    const p = JSON.parse(readFileSync(file, "utf8")); p.name = "Edited by hand";
    writeFileSync(file, JSON.stringify(p, null, 2));
    const e = await ev.next((e) => e.type === "state" && e.data.project.name === "Edited by hand", 2000);
    assert.equal(e.data.errors.length, 0);
  } finally { ev.close(); await s.close(); }
});

test("cross-process: an MCP edit reaches the studio as state + an mcp:* event, and keeps studio edits", async () => {
  const { s, file, post } = await setup();
  const ev = await sse(s.url);
  const m = await mcp(file);
  try {
    await m.call("project_get"); // the MCP server now holds a copy of the file
    // studio edit after that read: the MCP copy is stale
    const r = await post("/api/patch", { ops: [{ op: "replace", path: "/channels/0/name", value: "Author" }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await m.call("channel_upsert", { channel: { id: "critic", polyphony: 2 } });
    const e = await ev.next((e) => e.type === "event" && e.data.type === "edit" && e.data.source.startsWith("mcp:"));
    assert.equal(e.data.source, "mcp:claude-code");
    assert.equal(e.data.tool, "channel_upsert");
    const st = await ev.next((e) => e.type === "state" && e.data.project.channels[1].polyphony === 2);
    assert.equal(st.data.project.channels[0].name, "Author", "the MCP upsert must not overwrite the studio's edit");
    const disk = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(disk.channels[0].name, "Author");
    assert.equal(disk.channels[1].polyphony, 2);
  } finally { await m.client.close(); ev.close(); await s.close(); }
});

test("POST /api/run streams run events ending in run.end with 3 passes", async () => {
  const { s, post } = await setup();
  const ev = await sse(s.url);
  try {
    const r = await post("/api/run", {});
    assert.equal(r.status, 202);
    const end = await ev.next((e) => e.type === "event" && e.data.type === "run.end", 5000);
    assert.equal(end.data.summary.passes, 3);
    assert.equal(end.data.source, "studio");
    const types = ev.seen.filter((e) => e.type === "event").map((e) => e.data.type);
    assert.equal(types[0], "run.start");
    assert.ok(types.includes("barrier") && types.includes("pass") && types.includes("voice"));
    const v = ev.seen.find((e) => e.data.type === "voice" && e.data.phase === "end").data;
    assert.equal(v.bus, "draft"); assert.equal(v.frames, 1); assert.match(v.text, /Draft \(pass 1\)/);
    const st = await ev.next((e) => e.type === "state" && e.data.latest?.run.id === end.data.runId);
    assert.equal(st.data.latest.voices.length, 6);
    const take = await (await fetch(s.url + `api/take/${end.data.runId}`)).json() as any;
    assert.equal(take.frames.length, 6);
  } finally { ev.close(); await s.close(); }
});
