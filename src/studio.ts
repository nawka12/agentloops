// `agentloops studio`: local web UI for watching an outside harness build and run a song.
// Deviation from SPEC §13: Server-Sent Events (server -> browser) plus fetch POSTs (browser -> server) instead of a WebSocket.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { score } from "./cli.ts";
import { check, createHost, RANK } from "./host.ts";
import { eventsFile, refresh, studioFile } from "./sync.ts";
import { openTakes } from "./takes.ts";

const UI = new URL("../ui/", import.meta.url);
const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".ts": "text/javascript", ".js": "text/javascript" };
const VENDOR = new URL("../node_modules/", import.meta.url);

export async function studio(o: { file: string; port?: number }) {
  const file = resolve(o.file), dir = dirname(file), log = eventsFile(dir);
  mkdirSync(dirname(log), { recursive: true });
  const clients = new Set<ServerResponse>();
  const send = (type: string, data: any) => { const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(msg); };
  // The studio owns the project: its UI actions and every relayed MCP call go through this host (one undo stack, one set of runs).
  let host: ReturnType<typeof createHost>;
  try { host = createHost({ file, scope: "run", budget: null, notify: (t, d) => (t === "state" ? send("state", state()) : t === "tail" ? tail() : send(t, d)) }); }
  catch (e: any) { throw new Error(`cannot load ${o.file}: ${e.message}`); }
  const withTakes = <T>(fn: (t: ReturnType<typeof openTakes>) => T): T => { const t = openTakes(dir); try { return fn(t); } finally { t.close(); } };

  const readEvents = (from: number) => {
    const size = existsSync(log) ? statSync(log).size : 0;
    if (size <= from) return { size, lines: [] as any[] };
    const buf = Buffer.alloc(size - from), fd = openSync(log, "r");
    try { readSync(fd, buf, 0, buf.length, from); } finally { closeSync(fd); }
    const txt = buf.toString("utf8"), end = txt.lastIndexOf("\n") + 1; // keep a half-written last line for next time
    const lines = txt.slice(0, end).split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    return { size: from + Buffer.byteLength(txt.slice(0, end)), lines };
  };
  const recent = () => readEvents(Math.max(0, (existsSync(log) ? statSync(log).size : 0) - 600_000)).lines.slice(-1000); // ponytail: tail window (frame events make it busy), may drop a cut first line
  const state = () => {
    const s = host.cur();
    // ponytail: the latest take's frames (capped at 500) ride along with every state push; page them if takes get big
    const { takes, latest } = withTakes((t) => { const takes = t.list(10) as any[], g = takes[0] && t.get(takes[0].id); return { takes, latest: g && { ...g, frames: t.frames(takes[0].id).slice(-500) } }; });
    let sc = ""; try { sc = score(s.p); } catch (e: any) { sc = `cannot draw the score yet: ${e.message}`; }
    return { file: basename(s.file), project: s.p, errors: check(s.p), score: sc, takes, latest, running: playing() };
  };
  const playing = () => !!loop || [...host.runs.values()].some((r) => r.status === "running");
  // PAT Play loops until Stop, like FL: each repeat is a fresh paced run of the *current* project (edits land on the next repeat), cached voices replay free.
  // ponytail: the budget applies per repeat, nothing caps the loop's total spend; add a loop-wide cap if llm.agent loops get left running
  let loop: { stop: boolean } | null = null;
  async function patLoop(pattern: string, pace: unknown) {
    const me = (loop = { stop: false });
    try {
      for (let repeat = 1; !me.stop; repeat++) {
        const { runId } = await host.call("run_start", { pattern, cache: "prefer", pace, wait: false }, { source: "studio", repeat });
        const r = host.runs.get(runId);
        if (me.stop) r.ac.abort(); // Stop landed while this repeat was starting
        await r.promise;
        if (r.status !== "done") break; // stopped, failed or over budget: the loop ends with it
      }
    } catch {} finally { if (loop === me) loop = null; send("state", state()); } // ponytail: a repeat refused at start (validation errors) just ends the loop; the hint shows the first refusal only
  }

  // watch the project file (dir watch: atomic renames replace the inode) and tail the event log
  let t1: any, t2: any, offset = existsSync(log) ? statSync(log).size : 0;
  const w1 = watch(dir, (_e, f) => { if (f !== basename(file)) return; clearTimeout(t1); t1 = setTimeout(() => { const v = host.st!.ver; refresh(host.st!); if (host.st!.ver !== v) send("state", state()); }, 60); });
  function tail() {
    if (existsSync(log) && statSync(log).size < offset) offset = 0; // truncated or deleted by hand
    const r = readEvents(offset); offset = r.size;
    for (const e of r.lines) send("event", e);
    if (r.lines.some((e) => e.type === "run.end")) send("state", state()); // new take
  }
  const w2 = watch(dirname(log), (_e, f) => { if (f === basename(log)) { clearTimeout(t2); t2 = setTimeout(tail, 30); } });

  const body = (req: IncomingMessage) => new Promise<any>((ok, bad) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch { bad(new Error("body must be JSON")); } });
  });
  const json = (res: ServerResponse, code: number, v: any) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };

  const routes: Record<string, (req: IncomingMessage, res: ServerResponse, m: string[]) => any> = {
    "GET /api/state": (_q, res) => json(res, 200, { ...state(), events: recent() }),
    "GET /api/events": (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": hi\n\n"); clients.add(res); req.on("close", () => clients.delete(res));
    },
    "GET /api/take/(\\w+)": (_q, res, m) => withTakes((t) => { const g = t.get(m[1]); g ? json(res, 200, { ...g, frames: t.frames(m[1]) }) : json(res, 404, { error: "unknown take" }); }),
    // browser actions: the same tools an MCP client calls, as source "studio". The UI's Play sends pace: "project"; without it a run is unpaced
    "POST /api/patch": async (req, res) => {
      const a = await body(req), r = await host.call("project_patch", { ops: a.ops }, { source: "studio", summary: a.summary });
      json(res, 200, { ok: true, errors: r.errors });
    },
    "POST /api/run": async (req, res) => {
      const a = await body(req);
      if (playing()) return json(res, 409, { error: "a run is already playing" });
      if (a.pattern) {
        const errors = check(host.cur().p);
        if (errors.length) throw new Error(`fix the project first (${errors.length} errors)`);
        patLoop(a.pattern, a.pace);
        json(res, 202, { ok: true, loop: true });
      } else {
        await host.call("run_start", { arrangement: a.arrangement, cache: a.cache, pace: a.pace, wait: false }, { source: "studio" });
        json(res, 202, { ok: true });
      }
    },
    "POST /api/stop": async (_q, res) => { if (loop) loop.stop = true; if (host.runs.size) await host.call("run_stop", {}, { source: "studio" }); json(res, 200, { ok: true }); },
    "POST /api/tempo": async (req, res) => {
      const { bpm } = await body(req), p = host.cur().p;
      if (!(typeof bpm === "number" && bpm >= 10 && bpm <= 999)) throw new Error("bpm must be a number from 10 to 999");
      const r = await host.call("project_patch", { ops: [p.clock ? { op: "add", path: "/clock/bpm", value: bpm } : { op: "add", path: "/clock", value: { bpm } }] }, { source: "studio", summary: `tempo ${bpm} BPM` });
      json(res, 200, { ok: true, errors: r.errors });
    },
    "POST /api/undo": async (_q, res) => json(res, 200, { ok: true, undone: (await host.call("undo", {}, { source: "studio" })).undone }),
    "POST /api/view": async (req, res) => { const { panel, pattern, channel, voice, selection, windows } = await body(req); host.view = { panel, pattern, channel, voice, selection, windows }; json(res, 200, { ok: true }); },
    // the MCP relay: NDJSON {progress} lines, then {result} or {error}. The token is only in studio.json (0600), never sent to a browser.
    "POST /api/tool": async (req, res) => {
      const got = Buffer.from(req.headers.authorization ?? ""), want = Buffer.from(`Bearer ${token}`);
      if (got.length !== want.length || !timingSafeEqual(got, want)) return json(res, 401, { error: "unauthorized" });
      const a = await body(req), ac = new AbortController();
      res.on("close", () => { if (!res.writableFinished) ac.abort(); }); // the MCP client cancelled: the call's signal aborts (harness runs keep going)
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const line = (v: any) => res.write(JSON.stringify(v) + "\n");
      try {
        const result = await host.call(String(a.name), a.args, {
          source: `mcp:${a.client ?? "unknown"}`, signal: ac.signal, progress: (m) => line({ progress: m }),
          scope: a.scope in RANK ? a.scope : "read", budget: typeof a.budget === "number" ? a.budget : undefined, // fail closed on a missing scope
        });
        res.end(JSON.stringify({ result }) + "\n");
      } catch (e: any) { res.end(JSON.stringify({ error: e.message }) + "\n"); }
    },
    // Preact + htm ESM builds straight from node_modules (index.html maps the bare imports); no bundler
    "GET /vendor/((?:preact|htm)/(?:[\\w-]+/)*[\\w.-]+\\.js)": (_q, res, m) => {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "max-age=3600" }); res.end(readFileSync(new URL(m[1], VENDOR)));
    },
    "GET /(ui/[\\w-]+\\.(?:ts|css))?": (_q, res, m) => {
      const name = m[1]?.slice(3) ?? "index.html", ext = name.slice(name.lastIndexOf("."));
      let src = readFileSync(new URL(name, UI), "utf8");
      if (name === "index.html") src = src.replace("<!--boot-->", () => `<script id="boot" type="application/json">${JSON.stringify({ ...state(), events: recent() }).replace(/</g, "\\u003c")}</script>`); // first paint without a round trip
      if (ext === ".ts") src = stripTypeScriptTypes(src); // ponytail: re-stripped per request; cache by mtime if it ever shows up in a profile
      res.writeHead(200, { "content-type": TYPES[ext] + "; charset=utf-8", "cache-control": "no-store" }); res.end(src);
    },
  };

  let port = o.port ?? 4870;
  const token = randomBytes(24).toString("hex"); // fresh per start; only written to studio.json (0600)
  const server = createServer(async (req, res) => {
    // only this origin: block DNS rebinding (Host) and cross-site POSTs (a page elsewhere could otherwise patch in a script and run it)
    const host = `127.0.0.1:${port}`, origin = req.headers.origin;
    if (![host, `localhost:${port}`].includes(req.headers.host ?? "") || (origin && origin !== `http://${req.headers.host}`)
      || (req.method === "POST" && !String(req.headers["content-type"]).startsWith("application/json"))) return json(res, 403, { error: "forbidden" });
    const url = new URL(req.url ?? "/", "http://x");
    for (const [k, h] of Object.entries(routes)) {
      const [method, pat] = k.split(" "), m = new RegExp(`^${pat}$`).exec(url.pathname);
      if (method !== req.method || !m) continue;
      try { return await h(req, res, [...m]); } catch (e: any) { return res.headersSent ? res.end() : json(res, 400, { error: e.message }); }
    }
    json(res, 404, { error: "not found" });
  });
  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
  port = (server.address() as any).port;
  host.studioUrl = `http://127.0.0.1:${port}/`;
  const info = studioFile(dir);
  rmSync(info, { force: true });
  writeFileSync(info, JSON.stringify({ port, token, pid: process.pid, file: host.st!.file }), { mode: 0o600 });
  const unpublish = () => { try { if (JSON.parse(readFileSync(info, "utf8")).token === token) rmSync(info); } catch {} };
  process.on("exit", unpublish);
  const ping = setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 15000);
  return {
    url: host.studioUrl, port,
    async close() {
      clearInterval(ping); w1.close(); w2.close(); clearTimeout(t1); clearTimeout(t2); unpublish(); process.off("exit", unpublish);
      await Promise.all([...host.runs.values()].map((r) => (r.ac.abort(), r.promise))); // a run waiting on a harness would never end by itself
       for (const c of clients) c.end(); server.closeAllConnections(); await new Promise((ok) => server.close(ok));
    },
  };
}
