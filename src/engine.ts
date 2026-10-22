import { createHash, randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { compile, BAR, STEP } from "./project.ts";
import { evalBool, renderTemplate } from "./expr.ts";
import { createMcpPool, generators, type Raw } from "./generators.ts";
import { celFrame, createMixer, RunStop } from "./mixer.ts";
import { openTakes } from "./takes.ts";

const sha = (x: unknown) => createHash("sha256").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex");
const frameHash = (f: any) => sha([f.kind, !!f.final, f.text ?? null, f.json ?? null]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (f: any) => f.text ?? JSON.stringify(f.json);
const trunc = (s?: string, n = 160) => (s && s.length > n ? s.slice(0, n) + "…" : s);

/** Progress event: barrier / pass / voice start+end, always with the pass and cost so far. */
export type RunEvent = {
  type: "barrier" | "pass" | "voice" | "frame"; pass: number; costUsd: number; pos?: string; phase?: "start" | "end" | "wait" | "resume"; channel?: string; status?: string;
  voice?: number; key?: number; bus?: string; voiceCostUsd?: number; frames?: number; cached?: boolean; text?: string; error?: string; // voice details
  tick?: number; at?: number; // barrier/pass: the tick released and its wall clock (the UI interpolates the playhead); voice: the note's start tick
  kind?: string; final?: boolean; json?: unknown; // frame: one frame a bus emitted (the Monitor and the meters)
};
export type RunOpts = {
  arrangement?: string; pattern?: string; input?: unknown; cache?: "fresh" | "prefer"; budget?: number;
  /** Tempo as a speed limit (BPM): a barrier at tick t releases no earlier than start + t * msPerTick. Unset: as fast as the agents go. */
  pace?: number;
  signal?: AbortSignal; // external abort: stops the run, the take is still saved
  onEvent?: (e: RunEvent) => void;
  runId?: string;
  /** The outside harness answers `harness` channels: resolves with the voice's output, rejects when `signal` aborts (run stop, timeout). */
  harness?: (req: HarnessRequest, signal: AbortSignal) => Promise<Raw[]>;
};
export type HarnessRequest = {
  runId: string; voiceId: number; channel: string; channelName?: string; instruction?: string; prompt: string; inputs: Record<string, { text: string; json: unknown; trust?: string }>;
  schema?: any; instructions?: string; history: { role: string; content: string }[]; pass: number; noteText?: string; attempt: number; feedback?: string;
};
const posStr = (t: number) => `${Math.floor(t / BAR) + 1}:${String(Math.floor((t % BAR) / STEP) + 1).padStart(2, "0")}`;

/** Compile and play a project headlessly. `proj` is { p, dir } from loadProject. */
export async function render(proj: { p: any; dir: string }, opts: RunOpts = {}) {
  const { p } = proj;
  const plan = compile(p, opts);
  const takes = openTakes(proj.dir);
  const run: any = {
    id: opts.runId ?? randomUUID().slice(0, 8), project: p.name, arrangement: opts.arrangement, start: Date.now(), cache: opts.cache ?? "fresh",
    costUsd: 0, tokens: 0, pass: 0, loop: { index: 0, pass: 1, max: 1 }, trigger: { payload: opts.input ?? null },
    budget: opts.budget ?? p.budgets?.runUsd ?? null, voices: [], stopped: null, abort: new AbortController(), seq: 0, fid: 0,
  };
  const mixer = createMixer(p, run);
  // ponytail: every frame every bus emits is an event (and an event-log line), text capped at 4000 chars; sample or drop partials if logs get big
  run.onFrame = (bus: string, f: any) => emit({ type: "frame", bus, channel: f.source?.channel, voice: f.voiceId, kind: f.kind, final: f.final, text: trunc(f.text, 4000), json: f.json });
  run.mcp = createMcpPool(p.tools, proj.dir); // servers connect lazily; closed when the run ends
  // ponytail: a throwing listener must not kill the run; errors are swallowed
  const emit = (e: Omit<RunEvent, "pass" | "costUsd">) => { try { opts.onEvent?.({ ...e, pass: run.pass, costUsd: run.costUsd }); } catch {} };
  // wrap the bridge so the event log (and the studio) sees when a voice starts waiting for the harness and when it is answered
  if (opts.harness) run.harness = async (req: HarnessRequest, signal: AbortSignal) => {
    const v = run.voices[req.voiceId], ev = { type: "voice" as const, channel: req.channel, voice: req.voiceId, key: v?.n.key, tick: v?.n.start, bus: v?.ch.def.output ?? "master" };
    emit({ ...ev, phase: "wait", text: trunc(req.prompt) });
    const out = await opts.harness!(req, signal);
    emit({ ...ev, phase: "resume" });
    return out;
  };
  run.ctx = (extra: object = {}) => ({
    loop: run.loop, run: { costUsd: run.costUsd, elapsedMs: Date.now() - run.start }, trigger: run.trigger, bus: mixer.view, ...extra,
  });
  const stop = (reason: string) => { run.stopped ??= reason; run.abort.abort(); };
  const onAbort = () => stop("aborted");
  if (opts.signal?.aborted) onAbort(); else opts.signal?.addEventListener("abort", onAbort, { once: true });

  // channels: polyphony queue + conversation state
  const chs: Record<string, any> = {};
  (p.channels ?? []).forEach((def: any, idx: number) => (chs[def.id] = { def, idx, active: 0, queue: [] as (() => void)[], hist: {} as Record<string, any[]>, prev: null }));
  const acquire = (c: any) => (c.active < (c.def.polyphony ?? 4) ? (c.active++, Promise.resolve()) : new Promise<void>((r) => c.queue.push(r)));
  const release = (c: any) => { const n = c.queue.shift(); n ? n() : c.active--; };

  // inputs: snapshot of frames the listened bus emitted (completed voices only)
  function snapshot(def: any) {
    const inputs: Record<string, any> = {}, used: any[] = [];
    for (const i of def.inputs ?? []) {
      let fs: any[] = mixer.buses[i.bus].emitted;
      if ((i.select ?? "final") === "final") fs = fs.filter((f) => f.final);
      const w = i.window ?? "last";
      fs = w === "pass" ? fs.filter((f) => f.pass === run.pass) : w === "last" ? fs.slice(-1) : w === "run" ? fs : fs.slice(-w.lastN);
      inputs[i.as ?? i.bus] = { text: fs.map(textOf).join("\n\n"), json: fs.at(-1)?.json ?? null, frames: fs.map(celFrame), trust: fs.some((f) => f.trust === "untrusted") ? "untrusted" : "trusted" };
      used.push(...fs);
    }
    return { inputs, used };
  }

  function mkFrame(v: any, r: any, i: number, last: boolean) {
    return {
      id: `f${++run.fid}`, runId: run.id, voiceId: v.seq, pos: { bar: Math.floor(v.n.start / BAR) + 1, tick: v.n.start % BAR },
      source: { channel: v.ch.def.id, clip: v.clip.id }, kind: r.kind ?? "message", final: last, role: "assistant",
      text: r.text, json: r.json, trust: r.trust ?? "trusted", meta: r.meta ?? {},
      ord: v.ch.idx * 1e9 + v.seq * 1e3 + i, pass: v.pass, _v: v, // ord: channel order, then note order (<1000 frames per voice)
    };
  }

  async function generateOnce(v: any) {
    if (run.stopped) throw new RunStop(run.stopped);
    const gen = v.ch.def.generator;
    const raw = await generators[gen.plugin]({
      prompt: v.prompt, inputs: v.inputs, note: v.noteCtx, loop: v.loop, trigger: run.trigger, params: gen.params ?? {}, history: v.base,
      schema: v.instr?.schema, signal: run.abort.signal, mcp: run.mcp, harness: run.harness,
      voice: { runId: run.id, voiceId: v.seq, channel: v.ch.def.id, channelName: v.ch.def.name, instruction: v.instr?.name, pass: v.pass, noteText: v.n.text,
        attempt: (v.ch.def.retries ?? 1) - v.attemptsLeft + 1, feedback: v.feedback },
      charge: (usd: number, tokens: number) => { v.costUsd += usd; run.costUsd += usd; run.tokens += tokens; },
      checkBudget: () => { if (run.budget != null && run.costUsd >= run.budget) throw new RunStop(`budget exceeded: $${run.costUsd.toFixed(4)} >= $${run.budget}`); },
    });
    return raw.map((r, i) => mkFrame(v, r, i, i === raw.length - 1));
  }
  // ponytail: backoff 50ms * 2^n with no jitter; add jitter if providers rate-limit in lockstep
  const backoff = (v: any) => sleep(50 * 2 ** Math.max(0, (v.ch.def.retries ?? 1) - v.attemptsLeft - 1));
  async function generate(v: any) {
    for (;;) {
      try { return await generateOnce(v); }
      catch (e) {
        if (e instanceof RunStop || e.noRetry || v.attemptsLeft <= 0) throw e;
        v.attemptsLeft--;
        await backoff(v);
      }
    }
  }
  // voice failure policy: stop halts the run, skip lets it continue
  async function fail(v: any, e: Error) {
    v.status = "failed"; v.error = e.message;
    if (e instanceof RunStop || (v.ch.def.onFail ?? "stop") === "stop") { stop(e.message); throw e instanceof RunStop ? e : new RunStop(`voice ${v.ch.def.id}#${v.seq} failed: ${e.message}`); }
  }

  async function execute(v: any, prev: any) {
    const def = v.ch.def, hk = def.context === "per-pattern" ? v.clip.patternId : "*";
    if (run.stopped) throw new RunStop(run.stopped);
    if (v.n.slide && prev) { await prev.done.catch(() => {}); v.base = prev.messages ?? []; }
    else v.base = def.context === "persistent" || def.context === "per-pattern" ? [...(v.ch.hist[hk] ?? [])] : [];
    v.startMs = Date.now() - run.start;
    emit({ type: "voice", phase: "start", channel: def.id, voice: v.seq, key: v.n.key, vel: v.n.vel, pan: v.n.pan, text: v.n.text, tick: v.n.start, len: v.n.len, bus: def.output ?? "master" });
    const gen = def.generator;
    v.cacheKey = sha([gen.plugin, gen.params ?? {}, v.prompt, v.notePar, v.inFrames.map(frameHash), v.seed, v.base.length ? sha(v.base) : "", run.trigger.payload]);
    const cached = run.cache === "prefer" ? takes.findCached(v.cacheKey) : null;
    let frames;
    if (cached) {
      v.cached = true;
      frames = cached.map((r, i) => ({ ...mkFrame(v, r, i, r.final), kind: r.kind, trust: r.trust ?? "trusted", meta: { ...r.meta, costUsd: 0, cached: true } }));
    } else frames = await generate(v);
    v.frames = frames;
    const final = frames.at(-1);
    v.messages = [...v.base, { role: "user", content: v.prompt }, { role: "assistant", content: textOf(final) }];
    if (def.context === "persistent" || def.context === "per-pattern") (v.ch.hist[hk] ??= []).push(...v.messages.slice(-2));
    for (const f of frames) await mixer.receive(f, def.output ?? "master");
    v.status = "done"; v.endMs = Date.now() - run.start;
  }

  function spawn(clip: any, n: any) {
    const ch = chs[n.ch], seq = run.seq++;
    const v: any = { ch, n, clip, seq, pass: run.pass, loop: { index: clip.index, pass: clip.index + 1, max: clip.loop?.max ?? 1 }, end: n.start + n.len,
      status: "pending", costUsd: 0, attemptsLeft: ch.def.retries ?? 1, frames: [], cached: false };
    run.voices.push(v);
    v.instr = ch.def.keymap?.find((k: any) => k.key === n.key);
    v.noteCtx = { text: n.text, key: n.key, name: v.instr?.name, vel: n.vel, pan: n.pan, fine: n.fine, start: n.start, len: n.len };
    v.notePar = { key: n.key, vel: n.vel, pan: n.pan, fine: n.fine, text: n.text, slide: n.slide };
    v.seed = `${p.seed ?? 0}:${n.start}:${n.fine}:${clip.index}`; // project seed + position + fine offset (+ loop pass, so passes cache separately)
    const snap = snapshot(ch.def); // inputs are snapshotted at voice start (here, at the barrier)
    v.inputs = snap.inputs; v.inFrames = snap.used;
    v.prompt = renderTemplate(v.instr?.template ?? "{{note.text}}", { inputs: v.inputs, note: v.noteCtx, loop: v.loop, trigger: run.trigger, params: ch.def.generator.params ?? {} });
    const prev = ch.prev; ch.prev = v;
    v.retry = async (feedback: string) => { // validator retry: re-run the source voice (a harness voice sees `feedback`), counts against its retries
      if (v.attemptsLeft <= 0) return null;
      v.attemptsLeft--; v.feedback = feedback;
      await backoff(v);
      try { v.frames = await generateOnce(v); return v.frames.at(-1); } // the take records (and cache replays) the retried output
      catch (e) { if (e instanceof RunStop) throw e; return null; }
    };
    v.fail = (e: Error) => fail(v, e);
    v.done = (async () => {
      await acquire(ch);
      try { await execute(v, prev); }
      catch (e: any) {
        await fail(v, e); // throws unless onFail is skip
        const f = mkFrame(v, { kind: "error", text: e.message }, 0, false);
        v.frames = [f];
        await mixer.receive(f, ch.def.output ?? "master");
      } finally { release(ch); v.endMs ??= Date.now() - run.start; if (v.startMs != null) emit({ type: "voice", phase: "end", channel: ch.def.id, status: v.status, voice: v.seq, key: n.key, tick: n.start, bus: ch.def.output ?? "master",
        voiceCostUsd: v.costUsd, frames: v.frames.length, cached: v.cached, error: v.error, text: trunc(v.frames.at(-1) && textOf(v.frames.at(-1))) }); }
    })();
    v.done.catch(() => {});
  }

  const loopOf = (clip: any) => ({ index: clip.index, pass: clip.index + 1, max: clip.loop?.max ?? 1 }); // pass: 1-based, for text people read
  function shouldRun(n: any, clip: any) {
    const loop = loopOf(clip);
    if (n.pass) { const [a, m] = n.pass.split(":").map(Number); if (loop.index % m !== a - 1) return false; }
    return !n.when || evalBool(n.when, run.ctx({ loop, note: { text: n.text, key: n.key } }));
  }

  // pace: barrier t releases no earlier than base + (t - baseTick) * msPerTick; a loop rewind moves the base to the rewind's release
  const mpt = opts.pace ? 60000 / opts.pace / 96 : 0;
  let base = run.start, baseTick = 0;
  const paceTo = async (t: number) => {
    const ms = base + (t - baseTick) * mpt - Date.now();
    if (mpt && ms > 0) await wait(ms, null, { signal: run.abort.signal }).catch(() => {});
    if (run.stopped) throw new RunStop(run.stopped);
  };
  const solo = (p.channels ?? []).some((c: any) => c.solo);
  const muted = (ch: any) => !!ch?.def.mute || (solo && !ch?.def.solo);

  // barrier scheduling (SPEC 5.2 / 7.2), global scope only
  async function play() {
    const { clips, points } = plan;
    let i = 0, replay: any = null;
    while (i < points.length) {
      const t = points[i];
      await Promise.all(run.voices.filter((v: any) => v.end <= t).map((v: any) => v.done)); // done + stream tails
      if (run.stopped) throw new RunStop(run.stopped); // external abort: nothing new starts after the voices in flight finish
      await paceTo(t);
      await mixer.flushAll(); // aligned joins for barrier t
      emit({ type: "barrier", pos: posStr(t), tick: t, at: Date.now() });
      const lc = clips.find((c) => c.loop && c.start + c.len === t && (!replay || replay === c));
      if (lc) {
        run.loop = loopOf(lc);
        const done = (lc.loop.until && evalBool(lc.loop.until, run.ctx())) || lc.index + 1 >= lc.loop.max; // max = number of passes
        mixer.endPass();
        if (!done) { lc.index++; run.pass++; replay = lc; base = Date.now(); baseTick = lc.start; emit({ type: "pass", tick: lc.start, at: base }); i = points.findIndex((x) => x >= lc.start); continue; }
        replay = null;
      }
      for (const clip of clips) {
        if (replay && clip !== replay) continue;
        for (const n of clip.notes) {
          if (n.start !== t) continue;
          run.loop = loopOf(clip);
          if (!muted(chs[n.ch]) && shouldRun(n, clip)) spawn(clip, n);
          else run.voices.push({ ch: chs[n.ch], n, seq: run.seq++, pass: run.pass, status: "skipped", costUsd: 0, frames: [], end: -1, cached: false });
        }
      }
      i++;
    }
    await Promise.all(run.voices.map((v: any) => v.done)); // tails of everything still running
    await paceTo(Math.max(0, ...clips.map((c) => c.start + c.len))); // a paced run plays to the end of its last clip
    await mixer.flushAll();
    mixer.endPass();
  }

  try { await play(); }
  catch (e: any) { if (e instanceof RunStop) stop(e.message); else { stop(e.message); run.error = e; } }
  await Promise.allSettled(run.voices.map((v: any) => v.done));
  opts.signal?.removeEventListener("abort", onAbort);
  await run.mcp.close();
  const master = mixer.buses.master.emitted.filter((f: any) => f.final);
  takes.save(run, master);
  takes.close();
  if (run.error) throw run.error;
  const voices = run.voices.filter((v: any) => v.status !== "skipped");
  return {
    takeId: run.id, passes: run.pass + 1, costUsd: run.costUsd, stopped: run.stopped as string | null,
    voicesRun: voices.filter((v: any) => !v.cached).length, cacheHits: voices.filter((v: any) => v.cached).length,
    skipped: run.voices.length - voices.length, master,
    // frames each bus emitted, including those that arrived through sends (mixer meters)
    buses: Object.fromEntries(Object.entries<any>(mixer.buses).map(([id, b]) => [id, { frames: b.emitted.length, errors: b.emitted.filter((f: any) => f.kind === "error").length }])),
  };
}
