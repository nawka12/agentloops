import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { score } from "./cli.ts";
import { checkSchema } from "./mixer.ts";
import { loadProject, MANUAL, starter, validate, type Err } from "./project.ts";
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
const PLUGINS = [
  { kind: "generator", id: "script", summary: "Deterministic JS step (no model, no cost). Not sandboxed.", params: { code: "string, required: async function body. Receives ctx {prompt, inputs, note, loop, trigger, params, history}. Return a string, {text?, json?, meta?}, or an array of those (the last is the final frame)." } },
  { kind: "generator", id: "llm.agent", summary: "Claude via the Anthropic API, with a tool loop over MCP servers. Needs ANTHROPIC_API_KEY.", params: { model: "string, default claude-opus-5-5", system: "string", effort: "low|medium|high|xhigh|max, or a number 0..1", temperature: "number (leave unset on Opus 5.5 / Sonnet 5.5)", maxTokens: "integer, default 16000", maxTurns: "integer, default 10 (model calls per voice)", tools: 'string[] allow-list: "<server>" or "<server>.<tool>", servers defined in project-level "tools"' } },
  { kind: "generator", id: "harness", summary: "The outside harness (you, over Studio MCP) is the agent: the run pauses at the note, run_start/voice_reply return status:waiting with the request, you do the work and answer with voice_reply. No API key, no cost. Only for runs started with run_start.", params: { instructions: "string: a role or system text shown to the harness with every request", timeoutMs: "number, default 1800000 (30 min): the voice fails if the harness has not replied by then" } },
  { kind: "processor", id: "fx.gate", summary: "Passes a frame only if the CEL condition is true.", params: { condition: "CEL string, e.g. side.last.json.approved", hold: '"none" (drop) | "pass" (hold until a sidechain frame makes it true, dropped at end of pass)' } },
  { kind: "processor", id: "fx.validator", summary: "Checks the final frame's json against a schema (type, required, properties).", params: { schema: "JSON Schema subset", onFail: '"drop" | "error" | "retry" (re-runs the source voice)' } },
  { kind: "processor", id: "fx.formatter", summary: "Rewrites frame text from a template.", params: { template: 'string, e.g. "{{frame.text}}"' } },
  { kind: "processor", id: "fx.limiter", summary: "Caps what passes through a bus.", params: { ceiling: "number > 0", unit: '"usd" (default) | "tokens"', action: '"block" (default) | "stop"' } },
];

// ---- tool plumbing ----
const S = { type: "string" }, B = { type: "boolean" }, N = { type: "number" }, O = { type: "object" };
const obj = (properties: any = {}, required: string[] = []) => ({ type: "object", properties, required });
const text = (v: any) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const RANK = { read: 0, edit: 1, run: 2 } as const;
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

export async function serve(o: { project?: string; scope: keyof typeof RANK; budget?: number }) {
  const cap = o.budget ?? 5; // ponytail: default spend cap per run_start when --budget is not given
  let st: { file: string; p: any; ver?: string | null; undo: string[] } | null = null;
  // reload first if another process (the studio, an editor) changed the file, so a stale copy never overwrites its edits.
  // ponytail: undo snapshots stay whole-project copies, so undo after an outside edit also reverts that edit
  const cur = () => st ? refresh(st) : (() => { throw new Error("no project is open: call project_create or project_open first"); })();
  const open = (file: string) => { st = { file: resolve(file), p: null, undo: [] }; st.p = loadProject(file).p; return refresh(st); };
  const write = () => { st!.ver = writeJson(st!.file, st!.p); };
  /** Apply `fn` to a clone; on success snapshot for undo, swap in, write to disk. Validation errors never reject an edit. */
  const edit = (fn: (p: any) => any) => {
    const s = cur(), next = structuredClone(s.p), out = fn(next) ?? {};
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("the project must stay a JSON object");
    s.undo.push(JSON.stringify(s.p)); if (s.undo.length > 100) s.undo.shift(); // ponytail: 100 snapshots, whole-project copies
    s.p = next; write();
    return editResult(out);
  };
  const editResult = (extra: object = {}) => { const errors = check(cur().p); return text({ ok: true, ...extra, errorCount: errors.length, errors, undoDepth: cur().undo.length }); };

  const upsert = (kind: string, list: (p: any) => any[], e: any) => edit((p) => {
    if (!e || typeof e !== "object" || Array.isArray(e) || typeof e.id !== "string" || !e.id) throw new Error(`${kind} must be an object with a non-empty string id`);
    const isMaster = kind === "bus" && e.id === "master";
    const prev = isMaster ? (p.mixer ??= {}).master : list(p).find((x) => x.id === e.id);
    const merged: any = { ...prev, ...e };
    for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k]; // null removes a key
    if (isMaster) { delete merged.id; p.mixer.master = merged; }
    else { const a = list(p), i = a.findIndex((x) => x.id === e.id); i >= 0 ? (a[i] = merged) : a.push(merged); }
    return { id: e.id, action: prev ? "updated" : "added" };
  });
  const lists = {
    channel: (p: any) => (p.channels ??= []), pattern: (p: any) => (p.patterns ??= []), arrangement: (p: any) => (p.arrangements ??= []),
    bus: (p: any) => ((p.mixer ??= {}).buses ??= []),
  };
  const upsertTool = (kind: keyof typeof lists, hint: string) => ({
    name: `${kind}_upsert`, scope: "edit",
    description: `Add or update a ${kind} by id: shallow-merges the given fields into the existing one, or appends if the id is new (null removes a key). ${hint} Positions may be "bar:step" strings. Never rejected for validation errors; read the returned errors.`,
    inputSchema: obj({ [kind]: O }, [kind]), run: (a: any) => upsert(kind, lists[kind], a[kind]),
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
  /** Block until the run ends or is waiting on the harness; progress notifications go to this call. A cancelled call returns at once (the run goes on). */
  async function block(r: any, extra: any, settle: boolean) {
    const token = extra._meta?.progressToken;
    let n = 0, wake: any;
    const notify = token == null ? null : (e: any) => extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++n, message: `${e.type} · bar:step ${r.pos ?? "-"} · pass ${e.pass} · $${e.costUsd.toFixed(4)}` } }).catch(() => {});
    r.notify = notify;
    const cancelled = new Promise((ok) => extra.signal.addEventListener("abort", ok, { once: true }));
    try {
      while (r.status === "running" && !extra.signal.aborted) {
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
      if (r.notify === notify) r.notify = null;
    }
  }
  const findRun = (id?: string) => { const r = id ? runs.get(id) : [...runs.values()].at(-1); if (!r) throw new Error(id ? `unknown run '${id}'` : "no runs started in this session"); return r; };
  const withTakes = <T>(fn: (t: ReturnType<typeof openTakes>) => T): T => { const t = openTakes(dirname(cur().file)); try { return fn(t); } finally { t.close(); } };

  const tools: any[] = [
    // read
    { name: "project_get", scope: "read", description: "The open project: full JSON, or summary:true for a short outline (ids, routing, positions).", inputSchema: obj({ summary: B }), run: (a: any) => text(a.summary ? outline(cur().p) : cur().p) },
    { name: "project_validate", scope: "read", description: "Validate the open project. Returns {ok, errors:[{path (JSON Pointer), message, fix}]}.", inputSchema: obj(), run: () => { const errors = check(cur().p); return text({ ok: !errors.length, errors }); } },
    { name: "score_view", scope: "read", description: "Compact text view of the arrangement, patterns and mixer (same as `agentloops score`). Optional pattern id.", inputSchema: obj({ pattern: S }), run: (a: any) => { try { return text(score(cur().p, a.pattern)); } catch (e: any) { throw new Error(`cannot draw the score yet: ${e.message}`); } } },
    { name: "plugin_search", scope: "read", description: "Built-in generators and processors with their params. Optional query filters by substring.", inputSchema: obj({ query: S }), run: (a: any) => text(PLUGINS.filter((x) => !a.query || JSON.stringify(x).toLowerCase().includes(String(a.query).toLowerCase()))) },
    { name: "take_list", scope: "read", description: "Recorded runs of the open project, newest first.", inputSchema: obj({ limit: N }), run: (a: any) => text(withTakes((t) => t.list(a.limit ?? 20))) },
    {
      name: "take_get", scope: "read",
      description: "A recorded run. Default: summary (per voice: channel, pass, status, cost, cached, truncated final text) plus the run's Master output. frames:true returns raw frames, filterable by bus (the voice's output bus), channel, kind (message, tool_call, tool_result, error) and pass. id defaults to the latest take.",
      inputSchema: obj({ id: S, frames: B, bus: S, channel: S, kind: S, pass: N }),
      run: (a: any) => withTakes((t) => {
        const id = a.id ?? (t.list(1)[0] as any)?.id;
        const g = id && t.get(id);
        if (!g) throw new Error(id ? `unknown take '${id}'` : "no takes yet: run_start first");
        if (a.frames) return text(t.frames(id, { bus: a.bus, channel: a.channel, kind: a.kind, pass: a.pass }));
        return text({ ...g.run, voices: g.voices.map((v: any) => ({ ...v, text: clip(v.text) })), master: g.master.map((f: any) => ({ text: f.text, json: f.json })) });
      }),
    },
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
    { name: "project_patch", scope: "edit", description: "Apply RFC 6902 JSON Patch ops (add, remove, replace, move, copy, test) atomically. Covers any field; paths are JSON Pointers like /channels/0/name. Rejected only if an op is malformed or fails.", inputSchema: obj({ ops: { type: "array" } }, ["ops"]), run: (a: any) => edit((p) => { const r = applyPatch(p, a.ops); if (r !== p) throw new Error("replacing the whole document is not supported; patch its fields"); }) },
    upsertTool("channel", "A channel is {id, name, generator:{plugin, params}, keymap:[{key,name,template,schema?}], inputs:[{bus,window,select,as}], context, output, polyphony, retries, onFail}."),
    upsertTool("pattern", "A pattern is {id, name, lengthSteps, loop?:{max, until?}, steps?:{channel:[0|1,..]}, notes?:{channel:[{start,len,key,when?,pass?,slide?}]}}."),
    upsertTool("bus", 'A bus is {id, name, slots:[{plugin, params}], sends:[{to, mode: all|final|sidechain}], join}. id "master" configures the implicit Master bus.'),
    upsertTool("arrangement", "An arrangement is {id, name, tracks:[{name}], clips:[{type:'pattern', ref, track, start, len?, loop?}]}."),
    {
      name: "undo", scope: "edit", description: "Revert the last edit (any edit tool, one step per call).", inputSchema: obj(),
      run: () => { const s = cur(); const prev = s.undo.pop(); if (!prev) throw new Error("nothing to undo"); s.p = JSON.parse(prev); write(); return editResult({ undone: true }); },
    },
    // run
    {
      name: "run_start", scope: "run",
      description: "Play an arrangement (default: the first) or loop one pattern. Spends money if channels use llm.agent: budget is capped by the server's --budget. wait:true (default) blocks and sends progress notifications at each barrier and pass; cancelling the call stops the run. wait:false returns a runId for run_status / run_stop. If the project has harness channels, YOU are their agent: the call returns {status: \"waiting\", waiting: [requests]} as soon as the run needs you (do the work, answer with voice_reply), cancelling it leaves the run going, and wait:false is resumed with voice_reply({replies: []}) or run_status. Refuses to start while project_validate reports errors.",
      inputSchema: obj({ arrangement: S, pattern: S, input: {}, cache: S, budget: N, wait: B }),
      run: async (a: any, extra: any) => {
        const s = cur(), errors = check(s.p);
        if (errors.length) throw new Error(`fix the project first (${errors.length} errors):\n${JSON.stringify(errors, null, 2)}`);
        if (a.cache != null && !["fresh", "prefer"].includes(a.cache)) throw new Error('cache must be "fresh" or "prefer"');
        const wait = a.wait !== false;
        const budget = Math.min(...[a.budget, s.p.budgets?.runUsd, cap].filter((x) => x != null));
        const r: any = { id: randomUUID().slice(0, 8), status: "running", ac: new AbortController(), pass: 0, costUsd: 0, pos: null, started: Date.now(), waiting: new Map<number, any>(), wakers: new Set<() => void>(),
          bridged: (s.p.channels ?? []).some((c: any) => c.generator?.plugin === "harness") };
        runs.set(r.id, r);
        r.promise = loggedRender({ p: structuredClone(s.p), dir: dirname(s.file) }, {
          arrangement: a.arrangement, pattern: a.pattern, input: a.input, cache: a.cache, budget, signal: r.ac.signal, runId: r.id, harness: bridge(r),
          onEvent: (e) => {
            r.pass = e.pass; r.costUsd = e.costUsd; if (e.pos) r.pos = e.pos;
            if (e.type !== "voice") r.notify?.(e);
          },
        }, source()).then(
          (x) => { r.status = x.stopped ? "stopped" : "done"; r.result = { passes: x.passes, stopped: x.stopped, voicesRun: x.voicesRun, cacheHits: x.cacheHits, skipped: x.skipped, costUsd: x.costUsd, master: x.master.map((f: any) => ({ text: f.text, json: f.json })) }; },
          (e) => { r.status = "failed"; r.error = e.message; },
        );
        if (!wait) return text({ runId: r.id, status: "running" });
        const onAbort = () => { if (!r.bridged) r.ac.abort(); }; // client cancelled the call (a harness run is left going: resume it with voice_reply)
        extra.signal.addEventListener("abort", onAbort);
        try { await block(r, extra, true); if (!r.bridged) await r.promise; } finally { extra.signal.removeEventListener("abort", onAbort); }
        return text(runView(r));
      },
    },
    { name: "run_status", scope: "run", description: "Status of a run started in this session (default: the latest): position, pass, cost so far, and the result once finished.", inputSchema: obj({ runId: S }), run: (a: any) => text(runView(findRun(a.runId))) },
    {
      name: "voice_reply", scope: "run",
      description: 'Answer the voices a run is waiting on (run_start / voice_reply returned status:"waiting"). replies: [{voiceId, text?, json?, error?}]: text or json is the voice\'s output (json must match the request\'s schema when it has one; a mismatch is rejected and nothing is applied), error declines (the voice fails through its channel\'s onFail). Then, like run_start, it returns the next {status:"waiting", waiting:[…]} (at once if other voices are still unanswered) or the final result. replies:[] just waits again. Keep calling until status is done, stopped or failed.',
      inputSchema: obj({ runId: S, replies: { type: "array" } }, ["replies"]),
      run: async (a: any, extra: any) => {
        const r = findRun(a.runId), who = server.getClientVersion()?.name ?? "unknown", seen = new Set<number>();
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
        if (!r.waiting.size || !a.replies.length) await block(r, extra, true);
        return text(runView(r));
      },
    },
    { name: "run_stop", scope: "run", description: "Stop a running run (default: the latest), also while it waits on the harness (the pending requests are dropped). The take is still saved.", inputSchema: obj({ runId: S }), run: async (a: any) => { const r = findRun(a.runId); r.ac.abort(); await r.promise; return text(runView(r)); } },
  ];
  const allowed = tools.filter((t) => RANK[t.scope as keyof typeof RANK] <= RANK[o.scope]);

  const server = new Server({ name: "agentloops", version: "0.0.1" }, {
    capabilities: { tools: {}, resources: {} },
    instructions: "Read the agentloops://manual resource first. If run_start or voice_reply returns status:waiting you are the agent for those voices: see \"You are the agent\" in the manual. Edits are applied and saved even when the project is invalid: read the returned errors (path, message, fix) and keep going.",
  });
  const source = () => `mcp:${server.getClientVersion()?.name ?? "unknown"}`;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allowed.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    try {
      const t = allowed.find((x) => x.name === req.params.name);
      if (!t) throw new Error(`unknown tool '${req.params.name}' (scope ${o.scope})`);
      const args = req.params.arguments ?? {}, bad = checkSchema(t.inputSchema, args);
      if (bad) throw new Error(`bad arguments: ${bad}`);
      const out = await t.run(args, extra);
      if (t.scope === "edit" && st) try { // the event log is how an open studio learns who edited what
        const sum = args.ops ? (args.ops as any[]).map((x) => `${x?.op} ${x?.path}`).join(", ") : Object.values<any>(args).find((x) => x?.id)?.id ?? args.path ?? "";
        appendEvent(dirname(st.file), { type: "edit", source: source(), tool: t.name, summary: String(sum).slice(0, 200) });
      } catch {}
      return out;
    } catch (e: any) { return { isError: true, content: [{ type: "text", text: e.message }] }; }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: "agentloops://manual", name: "AgentLoops manual", mimeType: "text/markdown", description: "Concepts, project format and the authoring loop" }] }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri !== "agentloops://manual") throw new Error(`unknown resource ${req.params.uri}`);
    return { contents: [{ uri: req.params.uri, mimeType: "text/markdown", text: MANUAL }] };
  });

  if (o.project) try { open(o.project); } catch (e: any) { console.error(`agentloops mcp: cannot open ${o.project}: ${e.message}`); }
  await server.connect(new StdioServerTransport());
}
