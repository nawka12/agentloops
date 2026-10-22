// `agentloops studio`: local web UI for watching an outside harness build and run a song.
// Deviation from SPEC §13: Server-Sent Events (server -> browser) plus fetch POSTs (browser -> server) instead of a WebSocket.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { score } from "./cli.ts";
import { harnessFiles, HARNESSES } from "./connect.ts";
import { exporter, MAX_WAV, wavSeconds } from "./export.ts";
import { applyPatch, check, createHost, PLUGINS, RANK } from "./host.ts";
import { compile, starter } from "./project.ts";
import { appendEvent, eventsFile, refresh, studioFile, writeJson } from "./sync.ts";
import { openTakes } from "./takes.ts";

const UI = new URL("../ui/", import.meta.url);
const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".ts": "text/javascript", ".js": "text/javascript" };
// where npm put them (hoisted or nested): the package folder is the entry file's path up to `/<name>/`
const VENDOR = Object.fromEntries(["preact", "htm"].map((n) => { const f = createRequire(import.meta.url).resolve(n); return [n, pathToFileURL(f.slice(0, f.lastIndexOf(`${sep}${n}${sep}`) + n.length + 2))]; }));
const DEMOS = new URL("../examples/", import.meta.url), PRESETS = new URL("../presets/", import.meta.url);
const SONG = /^[\w.-]+\.alp\.json$/;
/** `*.alp.json` files in a folder, with their song names */
const songs = (d: string) => readdirSync(d).filter((f) => SONG.test(f)).sort().map((f) => { let name = f; try { name = JSON.parse(readFileSync(resolve(d, f), "utf8")).name ?? f; } catch {} return { file: f, name }; });
const presets = () => readdirSync(PRESETS).filter((f) => f.endsWith(".json")).sort().map((f) => ({ id: f.slice(0, -5), ...JSON.parse(readFileSync(new URL(f, PRESETS), "utf8")) }));

export async function studio(o: { file: string; port?: number; onClosed?: () => void; graceMs?: number }) {
  let file = resolve(o.file);
  const dir = dirname(file), log = eventsFile(dir);
  mkdirSync(dirname(log), { recursive: true });
  if (!existsSync(file)) writeJson(file, starter(basename(file).replace(/\.alp\.json$|\.json$/, ""))); // `studio <new-file>` starts a song instead of erroring
  const clients = new Set<ServerResponse>();
  let gone: ReturnType<typeof setTimeout> | undefined; // the grace timer armed when the last tab leaves
  const sse = (type: string, data: any) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const send = (type: string, data: any) => { const msg = sse(type, data); for (const c of clients) c.write(msg); };
  // The studio owns the project: its UI actions and every relayed MCP call go through this host (one undo stack, one set of runs).
  let host: ReturnType<typeof createHost>;
  try { host = createHost({ file, scope: "run", budget: null, notify: (t, d) => (t === "state" ? send("state", state()) : t === "tail" ? tail() : send(t, d)) }); }
  catch (e: any) { throw new Error(`cannot load ${o.file}: ${e.message}`); }
  // audio_export: the newest connected tab renders the WAV, else headless Chromium; the bytes come back through POST /api/export/:id
  const ex = exporter({ last: () => [...clients].at(-1) ?? null, send: (c: ServerResponse, t, d) => void c.write(sse(t, d)), url: () => host.studioUrl! });
  host.render = ex.render;
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
    return { file: basename(s.file), project: s.p, errors: check(s.p), score: sc, takes, latest, running: playing(), loop: loopInfo };
  };
  const playing = () => !!loop || [...host.runs.values()].some((r) => r.status === "running");
  // PAT Play loops until Stop, like FL: each repeat is a fresh paced run of the *current* project (edits land on the next repeat), cached voices replay free.
  // A loop-wide spend cap (default 3 x budgets.runUsd, else $1) and an optional repeat count end it too; each repeat's budget is what is left of the cap.
  let loop: { stop: boolean } | null = null, loopInfo: any = null;
  async function patLoop(pattern: string, pace: unknown, o: { cap?: number; repeats?: number; cache?: string }) {
    const me = (loop = { stop: false }), rb = host.cur().p.budgets?.runUsd;
    const info = (loopInfo = { pattern, capUsd: o.cap! > 0 ? o.cap! : rb > 0 ? rb * 3 : 1, repeats: o.repeats! > 0 ? Math.floor(o.repeats!) : null, spentUsd: 0, repeat: 0, running: true, reason: null as string | null });
    send("loop", info);
    try {
      for (let repeat = 1; !me.stop; repeat++) {
        if (info.repeats && repeat > info.repeats) { info.reason = `played ${info.repeats} repeat${info.repeats > 1 ? "s" : ""}`; break; }
        info.repeat = repeat;
        const { runId } = await host.call("run_start", { pattern, cache: o.cache ?? "prefer", pace, wait: false, budget: info.capUsd - info.spentUsd }, { source: "studio", repeat });
        const r = host.runs.get(runId);
        if (me.stop) r.ac.abort(); // Stop landed while this repeat was starting
        await r.promise;
        info.spentUsd += r.result?.costUsd ?? r.costUsd;
        send("loop", info); // the toolbar's loop meter
        if (me.stop) break;
        if (info.spentUsd >= info.capUsd) { info.reason = `loop spend cap reached: $${info.spentUsd.toFixed(4)} of $${info.capUsd.toFixed(2)}`; break; }
        if (r.status !== "done") { info.reason = r.status === "failed" ? `repeat ${repeat} failed: ${r.error}` : `repeat ${repeat} stopped${r.result?.stopped ? `: ${r.result.stopped}` : ""}`; break; }
      }
      info.reason ??= "stopped";
    } catch (e: any) { info.reason = `repeat refused: ${String(e.message).split("\n")[0]}`; } // e.g. validation errors on a later repeat
    finally {
      info.running = false;
      if (loop === me) loop = null;
      try { appendEvent(dir, { type: "loop.end", source: "studio", pattern, reason: info.reason, spentUsd: info.spentUsd, capUsd: info.capUsd, repeats: info.repeat }); } catch {}
      tail(); send("state", state());
    }
  }
  const publish = () => { rmSync(infoFile, { force: true }); writeFileSync(infoFile, JSON.stringify({ port, token, pid: process.pid, file: host.st!.file }), { mode: 0o600 }); };

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
  /** a request body of raw bytes, refused past `max` */
  const raw = (req: IncomingMessage, max: number) => new Promise<Buffer>((ok, bad) => {
    const big = new Error(`upload larger than ${Math.round(max / 1e6)} MB`);
    if (+(req.headers["content-length"] ?? 0) > max) return bad(big);
    const cs: Buffer[] = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > max) { bad(big); req.destroy(); } else cs.push(c); });
    req.on("end", () => ok(Buffer.concat(cs))); req.on("error", bad);
  });
  const json = (res: ServerResponse, code: number, v: any) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };

  const routes: Record<string, (req: IncomingMessage, res: ServerResponse, m: string[]) => any> = {
    "GET /api/state": (_q, res) => json(res, 200, { ...state(), events: recent() }),
    "GET /api/events": (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": hi\n\n"); clients.add(res); clearTimeout(gone);
      // ponytail: a page reload slower than graceMs, or the browser dropping the window, quits the studio
      req.on("close", () => { clients.delete(res); if (!clients.size && o.onClosed) gone = setTimeout(o.onClosed, o.graceMs ?? 5000); });
    },
    // the score as written, for audio export: every note at its absolute tick. Mute/solo apply; `when`/`pass` conditions and loops
    // are not evaluated (the score plays once, as notated). ponytail: evaluate conditions by bouncing a take when songs need it
    "GET /api/score": (req, res) => {
      const q = new URL(req.url ?? "/", "http://x").searchParams, p = host.st!.p, chs: any[] = p.channels ?? [], solo = chs.some((c) => c.solo);
      const plan = compile(p, { pattern: q.get("pattern") || undefined, arrangement: q.get("arrangement") || undefined });
      const on = new Set(chs.filter((c) => !c.mute && (!solo || c.solo)).map((c) => c.id));
      const notes = plan.clips.flatMap((c: any) => c.notes).filter((n: any) => on.has(n.ch)).map((n: any) => ({ ch: n.ch, key: n.key, start: n.start, len: n.len, vel: n.vel, pan: n.pan, text: n.text }));
      json(res, 200, { name: p.name, bpm: p.clock?.bpm ?? 120, end: Math.max(0, ...plan.clips.map((c: any) => c.start + c.len)), notes,
        channels: chs.map((c) => ({ id: c.id, plugin: c.generator?.plugin, sound: c.sound, gain: c.gain })) });
    },
    // the browser's half of audio_export: ack = "I am rendering it" (no ack in 10 s and the host goes headless); the upload is the WAV, or JSON {error}
    "POST /api/export/(\\w+)/ack": async (_q, res, m) => { const j = ex.jobs.get(m[1]); if (!j) return json(res, 404, { error: "unknown or expired export" }); j.acked(); json(res, 200, { ok: true }); },
    "POST /api/export/(\\w+)": async (req, res, m) => {
      const j = ex.jobs.get(m[1]);
      if (!j) return json(res, 404, { error: "unknown or expired export" });
      try {
        if (req.headers["content-type"]?.startsWith("application/json")) { const a = await body(req); j.bad(new Error(`the browser could not render the audio: ${a.error ?? "unknown error"}`)); return json(res, 200, { ok: true }); }
        const wav = await raw(req, MAX_WAV);
        if (!(wavSeconds(wav) >= 0)) throw new Error("not a WAV file");
        j.ok(wav); json(res, 200, { ok: true });
      } catch (e: any) { j.bad(e); throw e; }
    },
    // the UI's Shift+⤓: the same path as the MCP tool, saved as an MP3 in the project folder
    "POST /api/export": async (req, res) => { const a = await body(req); json(res, 200, await host.call("audio_export", { arrangement: a.arrangement, pattern: a.pattern, format: a.format, overwrite: a.overwrite }, { source: "studio" })); },
    // "Connect a harness": write the project-local files for the chosen harness (never clobbering)
    "POST /api/connect": async (req, res) => {
      const { harness } = await body(req);
      if (!HARNESSES.some((x) => x.id === harness)) throw new Error(`harness must be one of ${HARNESSES.map((x) => x.id).join(", ")}`);
      json(res, 200, harnessFiles(dir, harness, basename(file)));
    },
    "GET /api/harnesses": (_q, res) => json(res, 200, HARNESSES),
    "GET /api/take/(\\w+)": (_q, res, m) => withTakes((t) => { const g = t.get(m[1]); g ? json(res, 200, { ...g, frames: t.frames(m[1]) }) : json(res, 404, { error: "unknown take" }); }),
    // browser actions: the same tools an MCP client calls, as source "studio". The UI's Play sends pace: "project"; without it a run is unpaced
    "POST /api/patch": async (req, res) => {
      const a = await body(req);
      if (a.refuse) { // refuse an edit that would add a validation error containing this text (the mixer's routing refuses cycles)
        const had = new Set(check(host.cur().p).map((e) => e.message)), bad = check(applyPatch(structuredClone(host.cur().p), a.ops)).find((e) => e.message.includes(a.refuse) && !had.has(e.message));
        if (bad) throw new Error(bad.message);
      }
      const r = await host.call("project_patch", { ops: a.ops }, { source: "studio", summary: a.summary });
      json(res, 200, { ok: true, errors: r.errors });
    },
    "POST /api/run": async (req, res) => {
      const a = await body(req);
      if (playing()) return json(res, 409, { error: "a run is already playing" });
      if (a.pattern) {
        const errors = check(host.cur().p);
        if (errors.length) throw new Error(`fix the project first (${errors.length} errors)`);
        patLoop(a.pattern, a.pace, { cap: a.capUsd, repeats: a.repeats, cache: a.cache });
        json(res, 202, { ok: true, loop: true });
      } else {
        await host.call("run_start", { arrangement: a.arrangement, cache: a.cache, pace: a.pace, wait: false }, { source: "studio" });
        json(res, 202, { ok: true });
      }
    },
    "POST /api/stop": async (_q, res) => { if (loop) loop.stop = true; if (host.runs.size) await host.call("run_stop", {}, { source: "studio" }); json(res, 200, { ok: true }); },
    "GET /api/catalog": (_q, res) => json(res, 200, { plugins: PLUGINS, presets: presets() }),
    "GET /api/songs": (_q, res) => json(res, 200, { current: basename(file), demos: songs(fileURLToPath(DEMOS)), local: songs(dir) }),
    // switch the studio's song: a bundled demo is copied into the project folder first (never clobbering), so demos are never edited in place
    "POST /api/open": async (req, res) => {
      const a = await body(req), name = String(a.demo ?? a.file ?? "");
      if (!SONG.test(name)) throw new Error("pick a *.alp.json song");
      if (playing()) return json(res, 409, { error: "stop playback before opening another song" });
      let target = resolve(dir, name);
      if (a.demo != null) {
        const src = new URL(name, DEMOS), stem = name.replace(/\.alp\.json$/, "");
        if (!existsSync(src)) throw new Error(`no demo ${name}`);
        for (let i = 1; ; i++) {
          target = resolve(dir, i === 1 ? name : `${stem}-${i}.alp.json`);
          try { copyFileSync(src, target, constants.COPYFILE_EXCL); break; } catch (e: any) { if (e.code !== "EEXIST") throw e; }
        }
      } else if (!existsSync(target)) throw new Error(`no song ${name} in ${dir}`);
      await host.call("project_open", { path: target }, { source: "studio" }); // resets the undo stack
      file = host.st!.file; loopInfo = null; publish();
      appendEvent(dir, { type: "song.open", source: "studio", file: basename(file) });
      tail(); send("state", state());
      json(res, 200, { ok: true, file: basename(file) });
    },
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
    // Preact + htm ESM builds straight from their npm folders (index.html maps the bare imports); no bundler
    "GET /vendor/(preact|htm)/((?:[\\w-]+/)*[\\w.-]+\\.js)": (_q, res, m) => {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "max-age=3600" }); res.end(readFileSync(new URL(m[2], VENDOR[m[1]])));
    },
    // installable-app bits (the app window and "Install" in a browser use them); behind the same Host/Origin guard as everything else
    "GET /manifest.webmanifest": (_q, res) => {
      res.writeHead(200, { "content-type": "application/manifest+json", "cache-control": "no-store" });
      res.end(JSON.stringify({ name: "AgentLoops", short_name: "AgentLoops", display: "standalone", start_url: "./", background_color: "#1d2226", theme_color: "#1d2226", icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }] }));
    },
    // sampled instruments (ui/samples/<sound>/<root>[-p].mp3); the [\w-] check keeps requests inside that folder
    "GET /ui/samples/([\\w-]+)/([\\w-]+)\\.mp3": (_q, res, m) => {
      let b: Buffer; try { b = readFileSync(new URL(`samples/${m[1]}/${m[2]}.mp3`, UI)); } catch { return json(res, 404, { error: "not found" }); }
      res.writeHead(200, { "content-type": "audio/mpeg", "cache-control": "no-store" }); res.end(b);
    },
    "GET /icon.svg": (_q, res) => { res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" }); res.end(readFileSync(new URL("icon.svg", UI))); },
    "GET /(ui/[\\w-]+\\.(?:ts|css))?": (_q, res, m) => {
      const name = m[1]?.slice(3) ?? "index.html", ext = name.slice(name.lastIndexOf("."));
      let src = readFileSync(new URL(name, UI), "utf8");
      if (name === "index.html") src = src.replace("<!--boot-->", () => `<script id="boot" type="application/json">${JSON.stringify({ ...state(), events: recent() }).replace(/</g, "\\u003c")}</script>`); // first paint without a round trip
      if (ext === ".ts") src = stripTypeScriptTypes(src); // ponytail: re-stripped per request; cache by mtime if it ever shows up in a profile
      res.writeHead(200, { "content-type": TYPES[ext] + "; charset=utf-8", "cache-control": "no-store" }); res.end(src);
    },
  };

  let port = o.port ?? 4870;
  const token = randomBytes(24).toString("hex"), infoFile = studioFile(dir); // fresh per start; only written to studio.json (0600)
  const server = createServer(async (req, res) => {
    // only this origin: block DNS rebinding (Host) and cross-site POSTs (a page elsewhere could otherwise patch in a script and run it)
    const host = `127.0.0.1:${port}`, origin = req.headers.origin;
    if (![host, `localhost:${port}`].includes(req.headers.host ?? "") || (origin && origin !== `http://${req.headers.host}`)
      || (req.method === "POST" && !String(req.headers["content-type"]).startsWith("application/json") && !(req.headers["content-type"] === "audio/wav" && /^\/api\/export\/\w+$/.test(req.url ?? "")))) return json(res, 403, { error: "forbidden" });
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
  publish();
  const unpublish = () => { try { if (JSON.parse(readFileSync(infoFile, "utf8")).token === token) rmSync(infoFile); } catch {} };
  process.on("exit", unpublish);
  const ping = setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 15000);
  return {
    url: host.studioUrl, port,
    async close() {
      clearInterval(ping); clearTimeout(gone); w1.close(); w2.close(); clearTimeout(t1); clearTimeout(t2); unpublish(); process.off("exit", unpublish);
      await Promise.all([...host.runs.values()].map((r) => (r.ac.abort(), r.promise))); // a run waiting on a harness would never end by itself
       for (const c of clients) c.end(); server.closeAllConnections(); await new Promise((ok) => server.close(ok));
    },
  };
}
