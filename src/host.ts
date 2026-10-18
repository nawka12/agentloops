// The Studio host: owns the project, one undo stack for every source, runs, the harness bridge and the tool implementations.
// `agentloops mcp` (headless) and `agentloops studio` each create one; the MCP process relays to the studio's when one is open (see mcp.ts).
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { score } from "./cli.ts";
import { checkSchema } from "./mixer.ts";
import { loadProject, starter, validate, type Err } from "./project.ts";
import { appendEvent, loggedRender, refresh, writeJson } from "./sync.ts";
import { openTakes } from "./takes.ts";

// ---- RFC 6902 JSON Patch (handwritten, atomic: works on a clone, any bad op throws and nothing is applied) ----
const tokens = (path: any): string[] => {
  if (typeof path !== "string" || (path && path[0] !== "/")) throw new Error(`bad JSON Pointer ${JSON.stringify(path)}`);
  const ks = path ? path.slice(1).split("/").map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~")) : [];
  if (ks.includes("__proto__")) throw new Error("__proto__ is not allowed in a pointer");
  return ks;
};
const index = (arr: any[], k: string, end = false) => {
  if (end && k === "-") return arr.length;
  if (!/^(0|[1-9]\d*)$/.test(k) || +k > arr.length - (end ? 0 : 1)) throw new Error(`bad array index '${k}' (length ${arr.length})`);
  return +k;
};
const child = (c: any, k: string, path: string) => {
  if (Array.isArray(c)) return c[index(c, k)];
  if (c && typeof c === "object" && Object.hasOwn(c, k)) return c[k];
  throw new Error(`path not found: ${path}`);
};
const getAt = (doc: any, path: string) => tokens(path).reduce((c, k) => child(c, k, path), doc);
function put(doc: any, path: string, mode: "add" | "replace" | "remove", value?: any) {
  const keys = tokens(path);
  if (!keys.length) { if (mode === "remove") throw new Error("cannot remove the document root"); return value; }
  const par = keys.slice(0, -1).reduce((c, k) => child(c, k, path), doc), k = keys.at(-1)!;
  if (par === null || typeof par !== "object") throw new Error(`path not found: ${path}`);
  if (Array.isArray(par)) {
    const i = index(par, k, mode === "add");
    if (mode === "add") par.splice(i, 0, value); else if (mode === "replace") par[i] = value; else par.splice(i, 1);
  } else {
    if (mode !== "add" && !Object.hasOwn(par, k)) throw new Error(`path not found: ${path}`);
    if (mode === "remove") delete par[k]; else par[k] = value;
  }
  return doc;
}
export function applyPatch(doc: any, ops: any) {
  if (!Array.isArray(ops) || !ops.length) throw new Error("ops must be a non-empty array of RFC 6902 operations");
  ops.forEach((o: any, i: number) => {
    try {
      if (!o || typeof o !== "object") throw new Error("operation must be an object");
      const need = (...ks: string[]) => ks.forEach((k) => { if (!(k in o)) throw new Error(`missing '${k}'`); });
      need("path");
      switch (o.op) {
        case "add": case "replace": need("value"); doc = put(doc, o.path, o.op, structuredClone(o.value)); break;
        case "remove": doc = put(doc, o.path, "remove"); break;
        case "move": {
          need("from");
          const v = getAt(doc, o.from);
          if (o.path.startsWith(o.from + "/")) throw new Error("cannot move a value into itself");
          doc = put(put(doc, o.from, "remove"), o.path, "add", v);
          break;
        }
        case "copy": need("from"); doc = put(doc, o.path, "add", structuredClone(getAt(doc, o.from))); break;
        case "test": need("value"); if (!isDeepStrictEqual(getAt(doc, o.path), o.value)) throw new Error("test failed: value differs"); break;
        default: throw new Error(`unknown op ${JSON.stringify(o.op)}`);
      }
    } catch (e: any) { throw new Error(`op ${i} (${o?.op} ${o?.path}): ${e.message}`); }
  });
  return doc;
}

// ---- catalog for plugin_search: what exists in this build ----
export const PLUGINS = [
  { kind: "generator", id: "script", summary: "Deterministic JS step (no model, no cost). Not sandboxed.", params: { code: "string, required: async function body. Receives ctx {prompt, inputs, note, loop, trigger, params, history}. Return a string, {text?, json?, meta?}, or an array of those (the last is the final frame)." } },
  { kind: "generator", id: "llm.agent", summary: "Claude via the Anthropic API, with a tool loop over MCP servers. Needs ANTHROPIC_API_KEY.", models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"], params: { model: "string, default claude-opus-5-5", system: "string", effort: "low|medium|high|xhigh|max, or a number 0..1", temperature: "number (leave unset on Opus 5.5 / Sonnet 5.5)", maxTokens: "integer, default 16000", maxTurns: "integer, default 10 (model calls per voice)", tools: 'string[] allow-list: "<server>" or "<server>.<tool>", servers defined in project-level "tools"' } },
  { kind: "generator", id: "harness", summary: "The outside harness (you, over Studio MCP) is the agent: the run pauses at the note, run_start/voice_reply return status:waiting with the request, you do the work and answer with voice_reply. No API key, no cost. Only for runs started with run_start.", params: { instructions: "string: a role or system text shown to the harness with every request", timeoutMs: "number, default 1800000 (30 min): the voice fails if the harness has not replied by then" } },
  { kind: "processor", id: "fx.gate", summary: "Passes a frame only if the CEL condition is true.", params: { condition: "CEL string, e.g. side.last.json.approved", hold: '"none" (drop) | "pass" (hold until a sidechain frame makes it true, dropped at end of pass)' } },
  { kind: "processor", id: "fx.validator", summary: "Checks the final frame's json against a schema (type, required, properties).", params: { schema: "JSON Schema subset", onFail: '"drop" | "error" | "retry" (re-runs the source voice)' } },
  { kind: "processor", id: "fx.formatter", summary: "Rewrites frame text from a template.", params: { template: 'string, e.g. "{{frame.text}}"' } },
  { kind: "processor", id: "fx.limiter", summary: "Caps what passes through a bus.", params: { ceiling: "number > 0", unit: '"usd" (default) | "tokens"', action: '"block" (default) | "stop"' } },
];

// ---- tool plumbing ----
const S = { type: "string" }, B = { type: "boolean" }, N = { type: "number" }, O = { type: "object" };
const obj = (properties: any = {}, required: string[] = []) => ({ type: "object", properties, required });
export const RANK = { read: 0, edit: 1, run: 2 } as const;
const PANELS = ["playlist", "rack", "pianoroll", "mixer", "tracer", "monitor"];
const NO_STUDIO = "no studio open: run `agentloops studio <file>` to see it";
const clip = (s: any, n = 200) => { s = typeof s === "string" ? s : JSON.stringify(s); return s == null ? s : s.length > n ? s.slice(0, n) + "…" : s; };
// validate() is not shape-hardened; a crash on a half-built project is reported as one error instead of rejecting the edit
export const check = (p: any): Err[] => { try { return validate(p); } catch (e: any) { return [{ path: "/", message: `project cannot be validated: ${e.message}`, fix: "Check the types of the fields you just edited (arrays vs objects vs strings)" }]; } };

function outline(p: any) {
  const arr = (x: any): any[] => (Array.isArray(x) ? x : []);
  return {
    name: p.name, seed: p.seed, budgets: p.budgets, toolServers: Object.keys(p.tools ?? {}),
    channels: arr(p.channels).map((c) => ({ id: c.id, name: c.name, plugin: c.generator?.plugin, keys: arr(c.keymap).map((k: any) => `${k.key}:${k.name}`), inputs: arr(c.inputs).map((i: any) => i.bus), output: c.output ?? "master" })),
    patterns: arr(p.patterns).map((x) => ({ id: x.id, lengthSteps: x.lengthSteps ?? 16, loop: x.loop, channels: [...Object.keys(x.steps ?? {}), ...Object.keys(x.notes ?? {})] })),
    arrangements: arr(p.arrangements).map((a) => ({ id: a.id, clips: arr(a.clips).map((c: any) => `${c.ref}@${c.start ?? 0}`) })),
    buses: [...arr(p.mixer?.buses), { id: "master", ...(p.mixer?.master ?? {}) }].map((b) => ({ id: b.id, slots: arr(b.slots).map((s: any) => s.plugin), sends: arr(b.sends).map((s: any) => `${s.to}:${s.mode}`) })),
  };
}

/** Who is calling and how: `progress` reports a run's barriers, `signal` aborts the call (client cancelled). `scope` and `budget` come from the relaying MCP process. */
export type Ctx = { source: string; signal: AbortSignal; progress: (msg: string) => void; scope?: keyof typeof RANK; budget?: number; tool?: string; summary?: string; repeat?: number };
type Undo = { snap: string; source: string; tool: string; summary: string };

export function createHost(o: { file?: string; scope: keyof typeof RANK; budget?: number | null; notify?: (type: "state" | "tail" | "focus", data?: any) => void }) {
  const cap = o.budget === undefined ? 5 : o.budget; // ponytail: default spend cap per run_start when --budget is not given; null (the studio's Play) means only the project's runUsd
  const notify: NonNullable<typeof o.notify> = (t, d) => { try { o.notify?.(t, d); } catch {} };
  let st: { file: string; p: any; ver?: string | null; undo: Undo[] } | null = null;
  // reload first if another process (a headless MCP, an editor) changed the file, so a stale copy never overwrites its edits.
  // ponytail: undo snapshots stay whole-project copies, so undo after an outside edit also reverts that edit
  const cur = () => st ? refresh(st) : (() => { throw new Error("no project is open: call project_create or project_open first"); })();
  const open = (file: string) => { st = { file: resolve(file), p: null, undo: [] }; st.p = loadProject(file).p; return refresh(st); };
  const write = () => { st!.ver = writeJson(st!.file, st!.p); };
  /** Apply `fn` to a clone; on success snapshot for undo (labelled with who did it), swap in, write to disk. Validation errors never reject an edit. */
  const edit = (fn: (p: any) => any, c: Ctx) => {
    const s = cur(), next = structuredClone(s.p), out = fn(next) ?? {};
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("the project must stay a JSON object");
    s.undo.push({ snap: JSON.stringify(s.p), source: c.source, tool: c.tool!, summary: c.summary! }); if (s.undo.length > 100) s.undo.shift(); // ponytail: 100 snapshots, whole-project copies
    s.p = next; write(); notify("state");
    return editResult(out);
  };
  const editResult = (extra: object = {}) => { const errors = check(cur().p); return { ok: true, ...extra, errorCount: errors.length, errors, undoDepth: cur().undo.length }; };

  const upsert = (kind: string, list: (p: any) => any[], e: any, c: Ctx) => edit((p) => {
    if (!e || typeof e !== "object" || Array.isArray(e) || typeof e.id !== "string" || !e.id) throw new Error(`${kind} must be an object with a non-empty string id`);
    const isMaster = kind === "bus" && e.id === "master";
    const prev = isMaster ? (p.mixer ??= {}).master : list(p).find((x) => x.id === e.id);
    const merged: any = { ...prev, ...e };
    for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k]; // null removes a key
    if (isMaster) { delete merged.id; p.mixer.master = merged; }
    else { const a = list(p), i = a.findIndex((x) => x.id === e.id); i >= 0 ? (a[i] = merged) : a.push(merged); }
    return { id: e.id, action: prev ? "updated" : "added" };
  }, c);
  const lists = {
    channel: (p: any) => (p.channels ??= []), pattern: (p: any) => (p.patterns ??= []), arrangement: (p: any) => (p.arrangements ??= []),
    bus: (p: any) => ((p.mixer ??= {}).buses ??= []),
  };
  const upsertTool = (kind: keyof typeof lists, hint: string) => ({
    name: `${kind}_upsert`, scope: "edit",
    description: `Add or update a ${kind} by id: shallow-merges the given fields into the existing one, or appends if the id is new (null removes a key). ${hint} Positions may be "bar:step" strings. Never rejected for validation errors; read the returned errors.`,
    inputSchema: obj({ [kind]: O }, [kind]), run: (a: any, c: Ctx) => upsert(kind, lists[kind], a[kind], c),
  });

  // ---- runs ----
  const runs = new Map<string, any>();
  const runView = (r: any) => {
    const waiting = r.status === "running" && r.waiting.size ? [...r.waiting.values()].map((w: any) => w.req) : null;
    return { runId: r.id, status: waiting ? "waiting" : r.status, pass: r.pass, pos: r.pos, costUsd: r.costUsd, ...(waiting ? { waiting } : {}), ...(r.status === "running" ? { elapsedMs: Date.now() - r.started } : {}), ...(r.result ?? {}), ...(r.error ? { error: r.error } : {}) };
  };
  /** The harness bridge for one run: a request waits in r.waiting until voice_reply answers it or `signal` aborts (run_stop, timeout). */
  const bridge = (r: any) => (req: any, signal: AbortSignal) => new Promise<any[]>((resolve, reject) => {
    const w = { req, resolve, reject }, drop = () => { if (r.waiting.get(req.voiceId) === w) r.waiting.delete(req.voiceId); reject(signal.reason ?? new Error("aborted")); };
    if (signal.aborted) return drop();
    signal.addEventListener("abort", drop, { once: true });
    r.waiting.set(req.voiceId, w); r.wakers.forEach((f: any) => f());
  });
  /** Block until the run ends or is waiting on the harness; progress goes to this call. A cancelled call returns at once (the run goes on). */
  async function block(r: any, c: Ctx, settle: boolean) {
    let wake: any;
    const onProgress = (e: any) => c.progress(`${e.type} · bar:step ${r.pos ?? "-"} · pass ${e.pass} · $${e.costUsd.toFixed(4)}`);
    r.notify = onProgress;
    const cancelled = new Promise((ok) => c.signal.addEventListener("abort", ok, { once: true }));
    try {
      while (r.status === "running" && !c.signal.aborted) {
        if (r.waiting.size) {
          if (settle) await Promise.race([new Promise((ok) => setTimeout(ok, 50)), r.promise, cancelled]); // ponytail: 50 ms settle so a chord's requests arrive in one list; a note that starts later comes with the next reply
          return;
        }
        await Promise.race([r.promise, new Promise((ok) => r.wakers.add((wake = ok))), cancelled]);
        r.wakers.delete(wake);
      }
    } finally {
      // only clear what this call owns: a cancelled call's cleanup can run after the next call has started waiting
      r.wakers.delete(wake);
      if (r.notify === onProgress) r.notify = null;
    }
  }
  const findRun = (id?: string) => { const r = id ? runs.get(id) : [...runs.values()].at(-1); if (!r) throw new Error(id ? `unknown run '${id}'` : "no runs started in this session"); return r; };
  const withTakes = <T>(fn: (t: ReturnType<typeof openTakes>) => T): T => { const t = openTakes(dirname(cur().file)); try { return fn(t); } finally { t.close(); } };
  const needStudio = () => { if (!h.studioUrl) throw new Error(NO_STUDIO); };

  const tools: any[] = [
    // read
    { name: "project_get", scope: "read", description: "The open project: full JSON, or summary:true for a short outline (ids, routing, positions).", inputSchema: obj({ summary: B }), run: (a: any) => a.summary ? outline(cur().p) : cur().p },
    { name: "project_validate", scope: "read", description: "Validate the open project. Returns {ok, errors:[{path (JSON Pointer), message, fix}]}.", inputSchema: obj(), run: () => { const errors = check(cur().p); return { ok: !errors.length, errors }; } },
    { name: "score_view", scope: "read", description: "Compact text view of the arrangement, patterns and mixer (same as `agentloops score`). Optional pattern id.", inputSchema: obj({ pattern: S }), run: (a: any) => { try { return score(cur().p, a.pattern); } catch (e: any) { throw new Error(`cannot draw the score yet: ${e.message}`); } } },
    { name: "plugin_search", scope: "read", description: "Built-in generators and processors with their params. Optional query filters by substring.", inputSchema: obj({ query: S }), run: (a: any) => PLUGINS.filter((x) => !a.query || JSON.stringify(x).toLowerCase().includes(String(a.query).toLowerCase())) },
    { name: "take_list", scope: "read", description: "Recorded runs of the open project, newest first.", inputSchema: obj({ limit: N }), run: (a: any) => withTakes((t) => t.list(a.limit ?? 20)) },
    {
      name: "take_get", scope: "read",
      description: "A recorded run. Default: summary (per voice: channel, pass, status, cost, cached, truncated final text) plus the run's Master output. frames:true returns raw frames, filterable by bus (the voice's output bus), channel, kind (message, tool_call, tool_result, error) and pass. id defaults to the latest take.",
      inputSchema: obj({ id: S, frames: B, bus: S, channel: S, kind: S, pass: N }),
      run: (a: any) => withTakes((t) => {
        const id = a.id ?? (t.list(1)[0] as any)?.id;
        const g = id && t.get(id);
        if (!g) throw new Error(id ? `unknown take '${id}'` : "no takes yet: run_start first");
        if (a.frames) return t.frames(id, { bus: a.bus, channel: a.channel, kind: a.kind, pass: a.pass });
        return { ...g.run, voices: g.voices.map((v: any) => ({ ...v, text: clip(v.text) })), master: g.master.map((f: any) => ({ text: f.text, json: f.json })) };
      }),
    },
    { name: "studio_status", scope: "read", description: 'Who hosts the project: {host: "studio" (a studio window is open on it, with studioUrl; your calls are relayed to it) | "headless", file, scope}.', inputSchema: obj(), run: (_: any, c: Ctx) => ({ host: h.studioUrl ? "studio" : "headless", ...(h.studioUrl ? { studioUrl: h.studioUrl } : {}), file: st?.file ?? null, scope: c.scope ?? o.scope }) },
    {
      name: "studio_focus", scope: "read",
      description: "Show the user something in the open studio: scrolls to and flashes (and opens) a panel (playlist, rack, pianoroll, mixer, tracer, monitor) and selects a pattern, channel, bus or voice (a number from the Tracer / a waiting request). Call it after an edit the user should see. Errors when no studio is open.",
      inputSchema: obj({ panel: S, channel: S, pattern: S, bus: S, voice: N }),
      run: (a: any) => {
        needStudio();
        const p = cur().p, ids = (xs: any) => (Array.isArray(xs) ? xs : []).map((x: any) => x?.id);
        if (a.panel != null && !PANELS.includes(a.panel)) throw new Error(`panel must be one of ${PANELS.join(", ")}`);
        for (const [k, have] of [["channel", ids(p.channels)], ["pattern", ids(p.patterns)], ["bus", [...ids(p.mixer?.buses), "master"]]] as const)
          if (a[k] != null && !have.includes(a[k])) throw new Error(`unknown ${k} '${a[k]}' (have: ${have.join(", ") || "none"})`);
        const f = Object.fromEntries(["panel", "channel", "pattern", "bus", "voice"].filter((k) => a[k] != null).map((k) => [k, a[k]]));
        notify("focus", f);
        return { ok: true, focused: f };
      },
    },
    { name: "studio_view", scope: "read", description: "What the user is looking at in the open studio: {panel, pattern, channel, voice, selection, windows} (selection is the most specific selected entity, like voice:3 or channel:writer; windows lists the open floating windows). Errors when no studio is open.", inputSchema: obj(), run: () => { needStudio(); return h.view; } },
    // edit
    {
      name: "project_create", scope: "edit",
      description: "Create a new project file and open it. Default is a tiny valid starter song (one script channel); starter:false gives an empty skeleton to build from. Fails if the file exists (use project_open).",
      inputSchema: obj({ path: S, name: S, starter: B }, ["path"]),
      run: (a: any) => {
        const file = resolve(a.path);
        if (existsSync(file)) throw new Error(`${file} already exists: use project_open`);
        const p: any = starter(a.name ?? "My Song");
        if (a.starter === false) Object.assign(p, { channels: [], patterns: [], arrangements: [] });
        st = { file, p, undo: [] }; write();
        return editResult({ file });
      },
    },
    { name: "project_open", scope: "edit", description: "Open an existing project file (resets the undo stack).", inputSchema: obj({ path: S }, ["path"]), run: (a: any) => { const s = open(a.path); return editResult({ file: s.file }); } },
    { name: "project_patch", scope: "edit", description: "Apply RFC 6902 JSON Patch ops (add, remove, replace, move, copy, test) atomically. Covers any field; paths are JSON Pointers like /channels/0/name. Rejected only if an op is malformed or fails.", inputSchema: obj({ ops: { type: "array" } }, ["ops"]), run: (a: any, c: Ctx) => edit((p) => { const r = applyPatch(p, a.ops); if (r !== p) throw new Error("replacing the whole document is not supported; patch its fields"); }, c) },
    upsertTool("channel", "A channel is {id, name, generator:{plugin, params}, keymap:[{key,name,template,schema?}], inputs:[{bus,window,select,as}], context, output, polyphony, retries, onFail}."),
    upsertTool("pattern", "A pattern is {id, name, lengthSteps, loop?:{max, until?}, steps?:{channel:[0|1,..]}, notes?:{channel:[{start,len,key,when?,pass?,slide?}]}}."),
    upsertTool("bus", 'A bus is {id, name, slots:[{plugin, params}], sends:[{to, mode: all|final|sidechain}], join}. id "master" configures the implicit Master bus.'),
    upsertTool("arrangement", "An arrangement is {id, name, tracks:[{name}], clips:[{type:'pattern', ref, track, start, len?, loop?}]}."),
    {
      name: "undo", scope: "edit", description: "Revert the latest edit from any source (you, the user in the studio, another client; one step per call). Returns what it undid: {undone: {source, tool, summary}}.", inputSchema: obj(),
      run: (_: any, c: Ctx) => {
        const s = cur(), u = s.undo.pop();
        if (!u) throw new Error("nothing to undo");
        s.p = JSON.parse(u.snap); write(); notify("state");
        c.summary = `undid ${u.source} ${u.tool}: ${u.summary}`;
        return editResult({ undone: { source: u.source, tool: u.tool, summary: u.summary } });
      },
    },
    // run
    {
      name: "run_start", scope: "run",
      description: "Play an arrangement (default: the first) or loop one pattern. Spends money if channels use llm.agent: budget is capped by the server's --budget. wait:true (default) blocks and sends progress notifications at each barrier and pass; cancelling the call stops the run. wait:false returns a runId for run_status / run_stop. If the project has harness channels, YOU are their agent: the call returns {status: \"waiting\", waiting: [requests]} as soon as the run needs you (do the work, answer with voice_reply), cancelling it leaves the run going, and wait:false is resumed with voice_reply({replies: []}) or run_status. Refuses to start while project_validate reports errors. pace: \"project\" (or a BPM number) plays no faster than the project tempo (clock.bpm, default 120): pass it when the user is watching in the studio; omit it for headless work.",
      inputSchema: obj({ arrangement: S, pattern: S, input: {}, cache: S, budget: N, wait: B, pace: {} }),
      run: async (a: any, c: Ctx) => {
        const s = cur(), errors = check(s.p);
        if (errors.length) throw new Error(`fix the project first (${errors.length} errors):\n${JSON.stringify(errors, null, 2)}`);
        if (a.cache != null && !["fresh", "prefer"].includes(a.cache)) throw new Error('cache must be "fresh" or "prefer"');
        const pace = a.pace === "project" ? (s.p.clock?.bpm ?? 120) : a.pace;
        if (pace != null && !(typeof pace === "number" && pace > 0)) throw new Error('pace must be "project" or a BPM number > 0');
        const wait = a.wait !== false, caps = [a.budget, s.p.budgets?.runUsd, c.budget ?? cap].filter((x) => x != null), budget = caps.length ? Math.min(...caps) : undefined;
        const r: any = { id: randomUUID().slice(0, 8), repeat: c.repeat, status: "running", ac: new AbortController(), pass: 0, costUsd: 0, pos: null, started: Date.now(), waiting: new Map<number, any>(), wakers: new Set<() => void>(),
          bridged: (s.p.channels ?? []).some((c: any) => c.generator?.plugin === "harness") };
        runs.set(r.id, r);
        r.promise = loggedRender({ p: structuredClone(s.p), dir: dirname(s.file) }, {
          arrangement: a.arrangement, pattern: a.pattern, input: a.input, cache: a.cache, budget, pace, signal: r.ac.signal, runId: r.id, harness: bridge(r),
          onEvent: (e) => {
            r.pass = e.pass; r.costUsd = e.costUsd; if (e.pos) r.pos = e.pos;
            if (e.type !== "voice") r.notify?.(e);
          },
        }, c.source, c.repeat ? { repeat: c.repeat } : {}).then(
          (x) => { r.status = x.stopped ? "stopped" : "done"; r.result = { passes: x.passes, stopped: x.stopped, voicesRun: x.voicesRun, cacheHits: x.cacheHits, skipped: x.skipped, costUsd: x.costUsd, master: x.master.map((f: any) => ({ text: f.text, json: f.json })) }; },
          (e) => { r.status = "failed"; r.error = e.message; },
        ).then(() => notify("tail")); // tail now: an open studio shows run.end and the new take without waiting on its file watcher
        if (!wait) return { runId: r.id, status: "running" };
        const onAbort = () => { if (!r.bridged) r.ac.abort(); }; // client cancelled the call (a harness run is left going: resume it with voice_reply)
        c.signal.addEventListener("abort", onAbort);
        try { await block(r, c, true); if (!r.bridged) await r.promise; } finally { c.signal.removeEventListener("abort", onAbort); }
        return runView(r);
      },
    },
    { name: "run_status", scope: "run", description: "Status of a run started in this session (default: the latest): position, pass, cost so far, and the result once finished. Includes runs the user started with Play in an open studio.", inputSchema: obj({ runId: S }), run: (a: any) => runView(findRun(a.runId)) },
    {
      name: "voice_reply", scope: "run",
      description: 'Answer the voices a run is waiting on (run_start / voice_reply returned status:"waiting"). replies: [{voiceId, text?, json?, error?}]: text or json is the voice\'s output (json must match the request\'s schema when it has one; a mismatch is rejected and nothing is applied), error declines (the voice fails through its channel\'s onFail). Then, like run_start, it returns the next {status:"waiting", waiting:[…]} (at once if other voices are still unanswered) or the final result. replies:[] just waits again (and picks up a run the user started with Play in the studio). Keep calling until status is done, stopped or failed.',
      inputSchema: obj({ runId: S, replies: { type: "array" } }, ["replies"]),
      run: async (a: any, c: Ctx) => {
        const r = findRun(a.runId), who = c.source.replace(/^mcp:/, ""), seen = new Set<number>();
        const pending = () => `waiting voices: [${[...r.waiting.keys()].join(", ")}]`;
        for (const x of a.replies) { // check everything first: a bad reply applies nothing
          const w = r.waiting.get(x?.voiceId);
          if (!w) throw new Error(`voice ${JSON.stringify(x?.voiceId)} is not waiting for a reply (unknown or already answered); ${pending()}`);
          if (seen.has(x.voiceId)) throw new Error(`voice ${x.voiceId} appears twice in replies`);
          seen.add(x.voiceId);
          if (x.error != null) continue;
          if (x.text === undefined && x.json === undefined) throw new Error(`reply for voice ${x.voiceId} needs text, json or error`);
          if (w.req.schema) {
            if (x.json === undefined) throw new Error(`voice ${x.voiceId} has an output schema: reply with json matching ${JSON.stringify(w.req.schema)}`);
            const bad = checkSchema(w.req.schema, x.json);
            if (bad) throw new Error(`voice ${x.voiceId}: json does not match the schema (${bad}); nothing was applied, reply again`);
          }
        }
        for (const x of a.replies) {
          const w = r.waiting.get(x.voiceId); r.waiting.delete(x.voiceId);
          if (x.error != null) w.reject(new Error(`harness declined: ${x.error}`));
          else w.resolve([{ text: x.text ?? JSON.stringify(x.json), json: x.json, meta: { harness: who } }]);
        }
        if (!r.waiting.size || !a.replies.length) await block(r, c, true);
        return runView(r);
      },
    },
    { name: "run_stop", scope: "run", description: "Stop a running run (default: the latest), also while it waits on the harness (the pending requests are dropped). The take is still saved.", inputSchema: obj({ runId: S }), run: async (a: any) => { const r = findRun(a.runId); r.ac.abort(); await r.promise; return runView(r); } },
  ];

  /** Run one tool for `c.source`. Throws on any failure; returns the plain result. `c.scope` (from a relaying MCP process) narrows the host's scope. */
  async function call(name: string, args: any, c: Partial<Ctx> & { source: string }) {
    const t = tools.find((x) => x.name === name), scope = c.scope ?? o.scope;
    if (!t || RANK[t.scope as keyof typeof RANK] > RANK[scope]) throw new Error(`unknown tool '${name}' (scope ${scope})`);
    args ??= {};
    const bad = checkSchema(t.inputSchema, args);
    if (bad) throw new Error(`bad arguments: ${bad}`);
    const sum = c.summary ?? (args.ops ? (args.ops as any[]).map((x) => `${x?.op} ${x?.path}`).join(", ") : Object.values<any>(args).find((x) => x?.id)?.id ?? args.path ?? "");
    const x: Ctx = { signal: new AbortController().signal, progress: () => {}, ...c, tool: name, summary: String(sum) };
    const out = await t.run(args, x);
    if (t.scope === "edit" && st) try { appendEvent(dirname(st.file), { type: "edit", source: x.source, tool: name, summary: x.summary!.slice(0, 200) }); } catch {} // the event log is how an open studio learns who edited what
    return out;
  }

  const h = {
    tools, call, runs, cur, open, cap,
    get st() { return st; },
    /** Set by the studio once it listens; makes studio_status/focus/view live. */
    studioUrl: undefined as string | undefined,
    /** The latest {panel, pattern, channel, voice, selection} the studio UI posted. */
    view: { panel: null, pattern: null, channel: null, voice: null, selection: null } as any,
  };
  if (o.file) open(o.file);
  return h;
}
