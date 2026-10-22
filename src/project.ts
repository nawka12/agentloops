import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { checkExpr } from "./expr.ts";
import { AsyncFunction } from "./generators.ts";

export const BAR = 384; // ticks per bar
export const STEP = 24; // ticks per step
// ponytail: only `clock.bpm` is read (the studio's playback pace); 4 beats x 4 steps x 96 ppq is hardwired. Derive from project.clock if other grids are needed.

/** docs/manual.md is the single source for the MCP resource, the Claude Code skill and AGENTS.md. */
export const MANUAL = readFileSync(new URL("../docs/manual.md", import.meta.url), "utf8");

export type Err = { path: string; message: string; fix: string };

export function loadProject(file: string) {
  const path = resolve(file);
  return { p: JSON.parse(readFileSync(path, "utf8")), dir: dirname(path), path };
}

/** tick count or "bar:step[:tick]" (1-based) -> ticks, or null if invalid */
export function pos(v: any): number | null {
  if (Number.isInteger(v) && v >= 0) return v;
  const m = typeof v === "string" && /^(\d+):(\d+)(?::(\d+))?$/.exec(v);
  if (!m) return null;
  const bar = +m[1], step = +m[2], tick = +(m[3] ?? 0);
  if (bar < 1 || step < 1 || step > BAR / STEP || tick >= STEP) return null;
  return (bar - 1) * BAR + (step - 1) * STEP + tick;
}

/** A minimal valid project (one script channel, one pattern, one arrangement): runs with no API key. */
export const starter = (name = "My Song") => ({
  format: "agentloops/1", name, seed: 1, budgets: { runUsd: 1 },
  channels: [{
    id: "hello", name: "Hello", generator: { plugin: "script", params: { code: "return `Hello from ${ctx.note.name}!`;" } },
    keymap: [{ key: 60, name: "Greet", template: "Say hello" }], inputs: [], context: "fresh", output: "master",
  }],
  patterns: [{ id: "intro", name: "Intro", lengthSteps: 16, notes: { hello: [{ start: "1:01", len: 96, key: 60 }] } }],
  arrangements: [{ id: "main", name: "Main", tracks: [{ name: "Main" }], clips: [{ type: "pattern", ref: "intro", track: 0, start: "1:01" }] }],
  mixer: { buses: [] },
});

export const patLen = (pat: any) => (pat.lengthSteps ?? 16) * STEP;
const GENS = ["script", "llm.agent", "harness"];
const PROCS = ["fx.gate", "fx.validator", "fx.formatter", "fx.limiter"];
// channel `sound` (sonification instrument); keep in sync with SOUNDS in ui/sound.ts
export const SOUNDS = ["auto", "triangle", "sine", "square", "saw", "supersaw", "sub", "chip", "pluck", "bell", "drums", "piano", "sax", "trumpet", "trombone", "epiano", "organ", "upright", "vibes", "brushes", "eguitar", "distguitar", "ebass", "rock", "guitar", "pad", "noise", "strings", "violin", "harp", "glock", "timpani", "choir", "reese", "acid", "wobble", "808", "brass", "flute", "marimba", "heavy", "crunch", "chug", "clean"];
const ptr = (...parts: (string | number)[]) =>
  parts.map((x) => "/" + String(x).replace(/~/g, "~0").replace(/\//g, "~1")).join("");

export function validate(p: any): Err[] {
  const errs: Err[] = [];
  const err = (path: string, message: string, fix: string) => errs.push({ path, message, fix });
  const expr = (src: any, path: string) => {
    const m = typeof src === "string" ? checkExpr(src) : "expected a string";
    if (m) err(path, `Unparseable expression: ${m}`, "Write a valid CEL expression, e.g. loop.index > 0 or bus('review').last.json.approved");
  };
  if (p.format != null && p.format !== "agentloops/1") err("/format", `Unknown format ${JSON.stringify(p.format)}`, 'Set "format": "agentloops/1"');
  const channels: any[] = p.channels ?? [], buses: any[] = p.mixer?.buses ?? [], pats: any[] = p.patterns ?? [], arrs: any[] = p.arrangements ?? [];
  if (p.clock?.bpm != null && !(typeof p.clock.bpm === "number" && p.clock.bpm >= 10 && p.clock.bpm <= 999)) err("/clock/bpm", "bpm must be a number from 10 to 999", "Use e.g. 120");
  if (p.budgets?.runUsd != null && !(p.budgets.runUsd > 0)) err("/budgets/runUsd", "runUsd must be a positive number", "Use e.g. 5");

  // project-level tool servers (MCP over stdio); channels allow-list them by name
  const servers: Record<string, any> = p.tools ?? {};
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) err("/tools", "tools must be an object of servers", 'e.g. {"web": {"mcp": {"command": "npx", "args": ["-y", "some-mcp"]}}}');
  else for (const [name, s] of Object.entries<any>(servers)) {
    const sp = (...k: string[]) => ptr("tools", name, ...k);
    if (!/^[\w-]+$/.test(name)) err(sp(), `Bad tool server name '${name}'`, "Use letters, digits, _ or - (no dots: '<server>.<tool>' splits on the first dot)");
    const m = s?.mcp;
    if (typeof m?.command !== "string") err(sp("mcp", "command"), "A tool server needs mcp.command (stdio only for now)", 'e.g. {"mcp": {"command": "npx", "args": ["-y", "some-mcp"]}}');
    else if (m.args != null && !(Array.isArray(m.args) && m.args.every((a: any) => typeof a === "string"))) err(sp("mcp", "args"), "mcp.args must be an array of strings", 'e.g. ["-y", "some-mcp"]');
    else if (m.env != null && (typeof m.env !== "object" || Array.isArray(m.env) || Object.values(m.env).some((x) => typeof x !== "string"))) err(sp("mcp", "env"), "mcp.env must be an object of strings", 'e.g. {"TOKEN": "..."}');
  }

  const busIds = new Set(["master"]);
  buses.forEach((b, i) => {
    if (typeof b.id !== "string") return err(ptr("mixer", "buses", i, "id"), "Bus needs a string id", "Add an id");
    if (b.id === "master") return err(ptr("mixer", "buses", i, "id"), "master is implicit", "Remove this bus and configure mixer.master instead");
    if (busIds.has(b.id)) err(ptr("mixer", "buses", i, "id"), `Duplicate bus id '${b.id}'`, "Give each bus a unique id");
    busIds.add(b.id);
  });

  const chById = new Map<string, any>();
  channels.forEach((c, i) => {
    const at = (...k: (string | number)[]) => ptr("channels", i, ...k);
    if (typeof c.id !== "string") return err(at("id"), "Channel needs a string id", "Add an id");
    if (chById.has(c.id)) err(at("id"), `Duplicate channel id '${c.id}'`, "Give each channel a unique id");
    chById.set(c.id, c);
    const g = c.generator;
    if (!GENS.includes(g?.plugin)) err(at("generator", "plugin"), `Unknown generator plugin ${JSON.stringify(g?.plugin)}`, `Use one of: ${GENS.join(", ")}`);
    if (g?.plugin === "script") {
      if (typeof g.params?.code !== "string") err(at("generator", "params", "code"), "script generator needs params.code", "Add an async function body as a string");
      else try { new AsyncFunction("ctx", g.params.code); } catch (e: any) { err(at("generator", "params", "code"), `script has a syntax error: ${e.message}`, "Fix the JavaScript"); }
    }
    if (g?.params?.tools != null) {
      const ts = g.params.tools;
      if (!Array.isArray(ts)) err(at("generator", "params", "tools"), "tools must be an array of allow-list entries", 'e.g. ["web", "files.read_file"]');
      else if (ts.length && g.plugin !== "llm.agent") err(at("generator", "params", "tools"), `${g.plugin} generators do not use tools`, "Remove tools or use llm.agent");
      else ts.forEach((ref: any, j: number) => {
        const tp = at("generator", "params", "tools", j), [srv, ...rest] = typeof ref === "string" ? ref.split(".") : [];
        if (typeof ref !== "string" || !srv || (rest.length && !rest.join("."))) err(tp, `Bad tool reference ${JSON.stringify(ref)}`, 'Use "<server>" or "<server>.<tool>"');
        else if (!(srv in servers)) err(tp, `Unknown tool server '${srv}'`, `Define it under the project-level "tools" (${Object.keys(servers).join(", ") || "none defined yet"})`);
      });
    }
    if (g?.plugin === "harness") {
      if (g.params?.instructions != null && typeof g.params.instructions !== "string") err(at("generator", "params", "instructions"), "instructions must be a string", "A role or system text shown to the harness");
      if (g.params?.timeoutMs != null && !(g.params.timeoutMs > 0)) err(at("generator", "params", "timeoutMs"), "timeoutMs must be a positive number", "Use e.g. 1800000 (30 minutes)");
    }
    if (g?.params?.maxTurns != null && !(Number.isInteger(g.params.maxTurns) && g.params.maxTurns > 0)) err(at("generator", "params", "maxTurns"), "maxTurns must be a positive integer", "Use e.g. 10");
    (c.keymap ?? []).forEach((k: any, j: number) => {
      if (!Number.isInteger(k.key)) err(at("keymap", j, "key"), "Instruction key must be an integer", "Use 60 for the default key");
    });
    (c.inputs ?? []).forEach((inp: any, j: number) => {
      if (!busIds.has(inp.bus)) err(at("inputs", j, "bus"), `Unknown input bus '${inp.bus}'`, `Use one of: ${[...busIds].join(", ")}`);
      const w = inp.window ?? "last";
      if (!["last", "pass", "run"].includes(w) && !(w?.lastN > 0)) err(at("inputs", j, "window"), `Bad window ${JSON.stringify(w)}`, 'Use "last", "pass", "run" or {"lastN": n}');
      if (inp.select != null && !["final", "all"].includes(inp.select)) err(at("inputs", j, "select"), `Bad select ${JSON.stringify(inp.select)}`, 'Use "final" or "all"');
    });
    if (c.output != null && !busIds.has(c.output)) err(at("output"), `Unknown output bus '${c.output}'`, `Use one of: ${[...busIds].join(", ")} (or omit for master)`);
    for (const k of ["mute", "solo"]) if (c[k] != null && typeof c[k] !== "boolean") err(at(k), `${k} must be true or false`, `Use "${k}": true, or remove it`);
    if (c.sound != null && !SOUNDS.includes(c.sound)) err(at("sound"), `unknown sound "${c.sound}"`, `Use one of: ${SOUNDS.join(", ")}`);
    if (c.gain != null && !(typeof c.gain === "number" && c.gain >= 0 && c.gain <= 1)) err(at("gain"), "gain must be a number from 0 to 1", 'Use e.g. "gain": 0.8');
    if (c.polyphony != null && !(Number.isInteger(c.polyphony) && c.polyphony > 0)) err(at("polyphony"), "polyphony must be a positive integer", "Use e.g. 4");
    if (c.retries != null && !(Number.isInteger(c.retries) && c.retries >= 0)) err(at("retries"), "retries must be an integer >= 0", "Use e.g. 1");
    if (c.onFail != null && !["stop", "skip"].includes(c.onFail)) err(at("onFail"), `onFail ${JSON.stringify(c.onFail)} is not supported yet`, 'Use "stop" or "skip"');
    if (c.context != null && !["fresh", "persistent", "per-pattern"].includes(c.context)) err(at("context"), `Bad context ${JSON.stringify(c.context)}`, 'Use "fresh", "persistent" or "per-pattern"');
  });

  // buses: slots, sends, cycles
  const edges = new Map<string, { to: string; path: string }[]>();
  const allBuses = [...buses.map((b, i) => ({ b, at: (...k: (string | number)[]) => ptr("mixer", "buses", i, ...k) })),
    { b: { id: "master", ...(p.mixer?.master ?? {}) }, at: (...k: (string | number)[]) => ptr("mixer", "master", ...k) }];
  for (const { b, at } of allBuses) {
    if (b.join != null && !["aligned", "stream"].includes(b.join)) err(at("join"), `Bad join ${JSON.stringify(b.join)}`, 'Use "aligned" or "stream"');
    (b.slots ?? []).forEach((s: any, j: number) => {
      const sp = (...k: (string | number)[]) => at("slots", j, ...k);
      if (!PROCS.includes(s.plugin)) return err(sp("plugin"), `Unknown or unsupported processor ${JSON.stringify(s.plugin)}`, `Use one of: ${PROCS.join(", ")}`);
      const q = s.params ?? {};
      if (s.plugin === "fx.gate") {
        expr(q.condition, sp("params", "condition"));
        if (q.hold != null && !["none", "pass"].includes(q.hold)) err(sp("params", "hold"), `Bad hold ${JSON.stringify(q.hold)}`, 'Use "none" or "pass"');
      }
      if (s.plugin === "fx.validator" && q.onFail != null && !["drop", "error", "retry"].includes(q.onFail)) err(sp("params", "onFail"), `Bad onFail ${JSON.stringify(q.onFail)}`, 'Use "drop", "error" or "retry"');
      if (s.plugin === "fx.formatter" && typeof q.template !== "string") err(sp("params", "template"), "Formatter needs a template string", 'e.g. "{{frame.text}}"');
      if (s.plugin === "fx.limiter") {
        if (!(q.ceiling > 0)) err(sp("params", "ceiling"), "Limiter needs a positive ceiling", "e.g. 1000");
        if (q.unit != null && !["usd", "tokens"].includes(q.unit)) err(sp("params", "unit"), `Bad unit ${JSON.stringify(q.unit)}`, 'Use "usd" or "tokens"');
        if (q.action != null && !["block", "stop"].includes(q.action)) err(sp("params", "action"), `Bad action ${JSON.stringify(q.action)}`, 'Use "block" or "stop"');
      }
    });
    (b.sends ?? []).forEach((s: any, j: number) => {
      const sp = (...k: (string | number)[]) => at("sends", j, ...k);
      if (!busIds.has(s.to)) return err(sp("to"), `Unknown send target '${s.to}'`, `Use one of: ${[...busIds].join(", ")}`);
      if (s.mode === "summary") err(sp("mode"), "summary sends need the Compressor, which is not supported yet", 'Use "all" or "final"');
      else if (!["all", "final", "sidechain"].includes(s.mode)) err(sp("mode"), `Bad send mode ${JSON.stringify(s.mode)}`, 'Use "all", "final" or "sidechain"');
      edges.set(b.id, [...(edges.get(b.id) ?? []), { to: s.to, path: sp() }]);
    });
  }
  // cycle detection (DFS colouring); report each back edge
  const colour = new Map<string, 1 | 2>(), stack: string[] = [];
  const dfs = (id: string) => {
    colour.set(id, 1); stack.push(id);
    for (const e of edges.get(id) ?? []) {
      if (colour.get(e.to) === 1) {
        const cyc = [...stack.slice(stack.indexOf(e.to)), e.to].join(" -> ");
        err(e.path, `Bus send cycle: ${cyc}`, "Remove this send or route it forward; bus-to-bus routing must be acyclic");
      } else if (!colour.has(e.to)) dfs(e.to);
    }
    stack.pop(); colour.set(id, 2);
  };
  for (const id of busIds) if (!colour.has(id)) dfs(id);

  // patterns
  const patById = new Map<string, any>();
  pats.forEach((pat, i) => {
    const at = (...k: (string | number)[]) => ptr("patterns", i, ...k);
    if (typeof pat.id !== "string") return err(at("id"), "Pattern needs a string id", "Add an id");
    if (patById.has(pat.id)) err(at("id"), `Duplicate pattern id '${pat.id}'`, "Give each pattern a unique id");
    patById.set(pat.id, pat);
    if (pat.loop) {
      if (!(Number.isInteger(pat.loop.max) && pat.loop.max > 0)) err(at("loop", "max"), "A looping pattern needs loop.max (a positive integer)", "Set loop.max so the loop is bounded");
      if (pat.loop.until != null) expr(pat.loop.until, at("loop", "until"));
    }
    const hasKey = (ch: string, key: number) => chById.get(ch)?.keymap?.some((k: any) => k.key === key);
    for (const [ch, steps] of Object.entries<any>(pat.steps ?? {})) {
      if (!chById.has(ch)) { err(at("steps", ch), `Unknown channel '${ch}'`, `Use one of: ${[...chById.keys()].join(", ")}`); continue; }
      if (!Array.isArray(steps) || steps.some((s) => s !== 0 && s !== 1)) err(at("steps", ch), "steps must be an array of 0/1", "e.g. [1,0,0,0, 1,0,0,0]");
      else if (!hasKey(ch, 60)) err(at("steps", ch), `Step notes use key 60 but channel '${ch}' has no instruction for it`, `Add {"key": 60, ...} to the keymap of '${ch}'`);
    }
    for (const [ch, notes] of Object.entries<any>(pat.notes ?? {})) {
      if (!chById.has(ch)) { err(at("notes", ch), `Unknown channel '${ch}'`, `Use one of: ${[...chById.keys()].join(", ")}`); continue; }
      (notes as any[]).forEach((n, j) => {
        const np = (...k: (string | number)[]) => at("notes", ch, j, ...k);
        if (pos(n.start) == null) err(np("start"), `Bad position ${JSON.stringify(n.start)}`, 'Use a tick count or "bar:step[:tick]" (1-based, 16 steps per bar, e.g. "2:09")');
        if (n.len != null && !(Number.isInteger(n.len) && n.len > 0)) err(np("len"), `Bad length ${JSON.stringify(n.len)}`, "Use a positive tick count (24 ticks per step)");
        const key = n.key ?? 60;
        if (!hasKey(ch, key)) err(np("key"), `Key ${key} is not in the keymap of channel '${ch}'`, `Add an instruction with key ${key} to channel '${ch}' or use one of: ${(chById.get(ch).keymap ?? []).map((k: any) => k.key).join(", ")}`);
        if (n.when != null) expr(n.when, np("when"));
        if (n.pass != null) {
          const m = /^(\d+):(\d+)$/.exec(n.pass);
          if (!m || +m[1] < 1 || +m[1] > +m[2]) err(np("pass"), `Bad pass condition ${JSON.stringify(n.pass)}`, 'Use "N:M" with 1 <= N <= M, e.g. "1:2"');
        }
      });
    }
  });

  // arrangements
  arrs.forEach((a, i) => {
    const loops: [number, number, string][] = [];
    (a.clips ?? []).forEach((c: any, j: number) => {
      const cp = (...k: (string | number)[]) => ptr("arrangements", i, "clips", j, ...k);
      if ((c.type ?? "pattern") !== "pattern") return err(cp("type"), `Clip type '${c.type}' is not supported yet`, "Only pattern clips are supported in slice 1");
      const pat = patById.get(c.ref);
      if (!pat) return err(cp("ref"), `Unknown pattern '${c.ref}'`, `Use one of: ${[...patById.keys()].join(", ")}`);
      const start = pos(c.start ?? 0);
      if (start == null) return err(cp("start"), `Bad position ${JSON.stringify(c.start)}`, 'Use a tick count or "bar:step[:tick]"');
      if (c.len != null && !(Number.isInteger(c.len) && c.len > 0)) return err(cp("len"), `Bad length ${JSON.stringify(c.len)}`, "Use a positive tick count");
      if (c.loop ?? pat.loop) loops.push([start, start + (c.len ?? patLen(pat)), cp()]);
    });
    loops.sort((x, y) => x[0] - y[0]).forEach((l, k) => {
      if (k > 0 && l[0] < loops[k - 1][1]) err(l[2], "Looping clips must not overlap", "Move this clip after the previous loop ends");
    });
  });
  if (!arrs.length && !pats.length) err("/arrangements", "Project has nothing to render", "Add a pattern and an arrangement");
  return errs;
}

/** Compile the chosen arrangement (or one pattern) into a plan: clips with absolute-tick notes. */
export function compile(p: any, opts: { arrangement?: string; pattern?: string }) {
  const chIdx = new Map<string, number>((p.channels ?? []).map((c: any, i: number) => [c.id, i]));
  const pats = new Map<string, any>((p.patterns ?? []).map((x: any) => [x.id, x]));
  let raw: { id: string; pat: any; start: number; len: number; loop: any }[];
  if (opts.pattern) {
    const pat = pats.get(opts.pattern);
    if (!pat) throw new Error(`No pattern '${opts.pattern}'`);
    raw = [{ id: pat.id, pat, start: 0, len: patLen(pat), loop: pat.loop }];
  } else {
    const arr = opts.arrangement ? p.arrangements?.find((a: any) => a.id === opts.arrangement) : p.arrangements?.[0];
    if (!arr) throw new Error(opts.arrangement ? `No arrangement '${opts.arrangement}'` : "Project has no arrangements (use --pattern)");
    raw = (arr.clips ?? []).filter((c: any) => (c.type ?? "pattern") === "pattern").map((c: any, j: number) => {
      const pat = pats.get(c.ref);
      return { id: `${arr.id}:${j}`, pat, start: pos(c.start ?? 0)!, len: c.len ?? patLen(pat), loop: c.loop ?? pat.loop };
    });
  }
  const clips = raw.sort((a, b) => a.start - b.start).map((c) => {
    const notes: any[] = [];
    for (const [ch, steps] of Object.entries<number[]>(c.pat.steps ?? {}))
      steps.forEach((s, i) => s && notes.push({ ch, start: i * STEP, len: STEP, key: 60, vel: 0.5, pan: 0, fine: 0, text: "", slide: false }));
    for (const [ch, ns] of Object.entries<any[]>(c.pat.notes ?? {}))
      for (const n of ns) notes.push({ vel: 0.5, pan: 0, fine: 0, text: "", slide: false, len: STEP, key: 60, ...n, ch, start: pos(n.start)! });
    // stable order: start, then channel order, then definition order (sort is stable)
    notes.sort((a, b) => a.start - b.start || chIdx.get(a.ch)! - chIdx.get(b.ch)!);
    for (const n of notes) { n.start += c.start; }
    return { id: c.id, patternId: c.pat.id, start: c.start, len: c.len, loop: c.loop ?? null, index: 0,
      notes: notes.filter((n) => n.start < c.start + c.len) };
  });
  const points = [...new Set(clips.flatMap((c) => [...c.notes.map((n) => n.start), ...(c.loop ? [c.start + c.len] : [])]))].sort((a, b) => a - b);
  return { clips, points };
}
