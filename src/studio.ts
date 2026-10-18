// `agentloops studio`: local web UI for watching an outside harness build and run a song.
// Deviation from SPEC §13: Server-Sent Events (server -> browser) plus fetch POSTs (browser -> server) instead of a WebSocket.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, watch } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { score } from "./cli.ts";
import { applyPatch, check } from "./mcp.ts";
import { appendEvent, eventsFile, loggedRender, refresh, writeJson } from "./sync.ts";
import { openTakes } from "./takes.ts";

const UI = new URL("../ui/", import.meta.url);
const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".ts": "text/javascript" };

export async function studio(o: { file: string; port?: number }) {
  const s = refresh({ file: resolve(o.file), p: null as any, ver: null as string | null });
  if (!s.p) throw new Error(`cannot load ${o.file}`);
  const dir = dirname(s.file), log = eventsFile(dir);
  mkdirSync(dirname(log), { recursive: true });
  const clients = new Set<ServerResponse>();
  const send = (type: string, data: any) => { const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(msg); };
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
  const recent = () => readEvents(Math.max(0, (existsSync(log) ? statSync(log).size : 0) - 200_000)).lines.slice(-300); // ponytail: tail window, may drop a cut first line
  const state = () => {
    refresh(s);
    // ponytail: the latest take's frames (capped at 500) ride along with every state push; page them if takes get big
    const { takes, latest } = withTakes((t) => { const takes = t.list(10) as any[], g = takes[0] && t.get(takes[0].id); return { takes, latest: g && { ...g, frames: t.frames(takes[0].id).slice(-500) } }; });
    let sc = ""; try { sc = score(s.p); } catch (e: any) { sc = `cannot draw the score yet: ${e.message}`; }
    return { file: basename(s.file), project: s.p, errors: check(s.p), score: sc, takes, latest, running: !!run };
  };

  // watch the project file (dir watch: atomic renames replace the inode) and tail the event log
  let t1: any, t2: any, offset = existsSync(log) ? statSync(log).size : 0;
  const w1 = watch(dir, (_e, f) => { if (f !== basename(s.file)) return; clearTimeout(t1); t1 = setTimeout(() => { const v = s.ver; refresh(s); if (s.ver !== v) send("state", state()); }, 60); });
  const tail = () => {
    if (existsSync(log) && statSync(log).size < offset) offset = 0; // truncated or deleted by hand
    const r = readEvents(offset); offset = r.size;
    for (const e of r.lines) send("event", e);
    if (r.lines.some((e) => e.type === "run.end")) send("state", state()); // new take
  };
  const w2 = watch(dirname(log), (_e, f) => { if (f === basename(log)) { clearTimeout(t2); t2 = setTimeout(tail, 30); } });

  let run: { ac: AbortController; promise: Promise<any> } | null = null;
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
    "POST /api/patch": async (req, res) => {
      const a = await body(req);
      refresh(s);
      const next = applyPatch(structuredClone(s.p), a.ops);
      if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("the project must stay a JSON object");
      s.p = next; s.ver = writeJson(s.file, next);
      appendEvent(dir, { type: "edit", source: "studio", tool: "project_patch", summary: String(a.summary ?? a.ops.map((x: any) => `${x.op} ${x.path}`).join(", ")).slice(0, 200) });
      send("state", state());
      json(res, 200, { ok: true, errors: check(next) });
    },
    "POST /api/run": async (req, res) => {
      const a = await body(req);
      if (run) return json(res, 409, { error: "a run is already playing" });
      refresh(s);
      const errors = check(s.p);
      if (errors.length) return json(res, 400, { error: `fix the project first (${errors.length} errors)`, errors });
      if (a.cache != null && !["fresh", "prefer"].includes(a.cache)) return json(res, 400, { error: 'cache must be "fresh" or "prefer"' });
      const ac = new AbortController();
      const promise = loggedRender({ p: structuredClone(s.p), dir }, { pattern: a.pattern, arrangement: a.arrangement, cache: a.cache, signal: ac.signal }, "studio")
        .catch(() => {}).finally(() => { run = null; tail(); }); // tail now: don't wait on the watcher for run.end
      run = { ac, promise };
      json(res, 202, { ok: true });
    },
    "POST /api/stop": async (_q, res) => { if (run) { run.ac.abort(); await run.promise; } json(res, 200, { ok: true }); },
    "GET /(ui/[\\w-]+\\.(?:ts|css))?": (_q, res, m) => {
      const name = m[1]?.slice(3) ?? "index.html", ext = name.slice(name.lastIndexOf("."));
      let src = readFileSync(new URL(name, UI), "utf8");
      if (name === "index.html") src = src.replace("<!--boot-->", () => `<script id="boot" type="application/json">${JSON.stringify({ ...state(), events: recent() }).replace(/</g, "\\u003c")}</script>`); // first paint without a round trip
      if (ext === ".ts") src = stripTypeScriptTypes(src); // ponytail: re-stripped per request; cache by mtime if it ever shows up in a profile
      res.writeHead(200, { "content-type": TYPES[ext] + "; charset=utf-8", "cache-control": "no-store" }); res.end(src);
    },
  };

  let port = o.port ?? 4870;
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
  const ping = setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 15000);
  return {
    url: `http://127.0.0.1:${port}/`, port,
    async close() { clearInterval(ping); w1.close(); w2.close(); clearTimeout(t1); clearTimeout(t2); await run?.promise; for (const c of clients) c.end(); server.closeAllConnections(); await new Promise((ok) => server.close(ok)); },
  };
}
