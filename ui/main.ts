// AgentLoops Studio, browser side. Served type-stripped by src/studio.ts; Preact + htm come from node_modules through the import map.
// One global store S, re-rendered from the root on every change (Preact diffs it, so focus and drags survive). Gesture state lives in module variables.
import { h, render } from "preact";
import htm from "htm";
import { Mixer, Monitor, Piano, Playlist, Rack, Tracer, clipsOf, selChannel } from "./panels.ts";
import { Browser, ChannelWin, LoopPop, Menu, Picker, SlotEditor, loadCatalog, loadSongs, openLoop, openPicker, newPattern, patternMenu } from "./make.ts";
import { blip, chime, click, preload, renderWav, setMetro, setOn, setVol, songMix, sound, heard, stopAll, unlock, voiceEnd, voiceStart } from "./sound.ts";

/** the score for a query string ("pattern=x" or "arrangement=y") */
async function getScore(q: string) {
  const score = await (await fetch(`/api/score?${q}`)).json();
  if (score.error) throw new Error(score.error);
  return score;
}
/** fetch the score and bounce it offline to WAV bytes */
async function bounce(q: string, tempo?: number) {
  const score = await getScore(q);
  return { score, wav: await renderWav({ ...score, ...(tempo ? { bpm: tempo } : {}) }) };
}
/** Ctrl+Alt+R: bounce the song (SONG) or current pattern (PAT) to a WAV, offline, and download it. Shift: the host saves an MP3 in the project folder instead. */
export async function exportAudio(toFolder = false) {
  if (S.exporting) return;
  S.exporting = true; paint();
  try {
    const q = S.mode === "pat" ? `pattern=${encodeURIComponent(curPattern()?.id ?? "")}` : `arrangement=${encodeURIComponent(S.project.arrangements?.[0]?.id ?? "")}`;
    if (toFolder) { // same path as the MCP tool: about 0.3x the song's length, and it refuses to overwrite a file of the same name
      S.notice = "Rendering MP3 for the project folder…"; paint();
      const r = await fetch("/api/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(S.mode === "pat" ? { pattern: curPattern()?.id } : { arrangement: S.project.arrangements?.[0]?.id }) }), j = await r.json();
      if (!r.ok) throw new Error(j.error);
      S.notice = `Saved ${j.file.split("/").pop()} (${j.seconds} s)${j.note ? `: ${j.note}` : ""}`;
      return;
    }
    const { score, wav } = await bounce(q, bpm());
    const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" })), a = document.createElement("a");
    a.href = url; a.download = `${(score.name ?? "song").replace(/[^\w.-]+/g, "-")}.wav`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
    S.notice = `Exported ${a.download}`;
  } catch (e: any) { S.notice = `Export failed: ${e.message}`; }
  finally { S.exporting = false; paint(); }
}

/** The host asked this tab (or a headless browser, via ?export=<id>) to render audio: bounce, then upload to /api/export/:id (or report the error). */
const cancelled = new Set<string>();
async function hostExport(x: { id: string; arrangement?: string; pattern?: string; stems?: boolean }) {
  const up = (body: BodyInit, type: string, to = "") => fetch(`/api/export/${x.id}${to}`, { method: "POST", headers: { "content-type": type }, body });
  try {
    const q = x.pattern ? `pattern=${encodeURIComponent(x.pattern)}` : x.arrangement ? `arrangement=${encodeURIComponent(x.arrangement)}` : "";
    if (x.stems) { // one render per channel that sounds, one after the other in this page, each uploaded before the next starts
      const score = await getScore(q), on = new Set(score.notes.map((n: any) => n.ch));
      for (const c of score.channels.filter((c: any) => on.has(c.id))) {
        const wav = await renderWav(score, undefined, c.id);
        if (cancelled.delete(x.id)) return;
        const r = await up(wav, "audio/wav", `/stem?ch=${encodeURIComponent(c.id)}`);
        if (!r.ok) throw new Error((await r.json()).error);
      }
      await up(JSON.stringify({ done: true }), "application/json");
      return;
    }
    const { wav } = await bounce(q);
    if (cancelled.delete(x.id)) return;
    const r = await up(wav, "audio/wav");
    if (!r.ok) throw new Error((await r.json()).error);
  } catch (e: any) { if (!cancelled.has(x.id)) await up(JSON.stringify({ error: e.message }), "application/json").catch(() => {}); }
}

export const html = htm.bind(h);
export const esc = (s: any) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const ptr = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
export const BAR = 384, STEP = 24;
/** tick count or "bar:step[:tick]" -> ticks (mirror of src/project.ts pos) */
export const pos = (v: any): number => {
  if (Number.isInteger(v)) return v;
  const m = /^(\d+):(\d+)(?::(\d+))?$/.exec(String(v));
  return m ? (+m[1] - 1) * BAR + (+m[2] - 1) * STEP + +(m[3] ?? 0) : 0;
};
export const posStr = (t: number) => `${Math.floor(t / BAR) + 1}:${String(Math.floor((t % BAR) / STEP) + 1).padStart(2, "0")}`;
const lcdPos = (t: number) => `${Math.floor(t / BAR) + 1}:${String(Math.floor((t % BAR) / STEP) + 1).padStart(2, "0")}:${String(Math.floor(t % STEP)).padStart(2, "0")}`;
export const patLen = (pat: any) => (pat?.lengthSteps ?? 16) * STEP;

type Run = { id?: string; running: boolean; start: number; end?: number; pos?: string; tick: number; at: number; pass: number; cost: number; budget?: number; pattern?: string;
  repeat?: number; pace?: number; voices: Map<number, any>; buses: Record<string, { frames: number; cost: number; errors: number; at?: number }>; summary?: any; error?: string };
const newRun = (e?: any): Run => ({ id: e?.runId, running: !!e, start: e?.at ?? 0, tick: 0, at: e?.at ?? 0, pass: 0, cost: 0, budget: e?.budget, pattern: e?.pattern, repeat: e?.repeat, pace: e?.pace, voices: new Map(), buses: {} });
export const S: any = {
  project: null, errors: [], takes: [], latest: null, events: [] as any[], file: "", serverPlaying: false,
  mode: "pat", pattern: null as string | null, channel: null as string | null, cache: false, voice: null as number | null, panel: "playlist",
  run: newRun(), monitor: [] as any[], monitorBus: "master", monTab: "master", preview: new Map<string, string>(),
  runs: [] as any[], // one entry per run (a PAT repeat or a song play): {id, repeat, master: [frames], ended, cached}
  flash: new Set<string>(), lastHarness: null as any, bpm: null as number | null, showErrors: false,
  loop: null as any, repeats: 0, capUsd: null as number | null, notice: null as string | null, meters: {} as Record<string, any>, sendMode: "final",
  menu: null as any, picker: null as any, slotEd: null as any, pop2: null as any, wins: {} as Record<string, any>,
  connect: { res: {} as Record<string, any>, busy: null as string | null },
};
export const playing = () => S.run.running || S.serverPlaying;
export const bpm = () => S.bpm ?? S.project?.clock?.bpm ?? 120;

export async function post(path: string, body: any = {}) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) setHint(`${path.slice(5)} refused: ${String((await r.json()).error).split("\n")[0]}`);
  return r.ok;
}
/** Every studio edit: one JSON Patch, one undo step, source "studio". */
export const patch = (ops: any[], summary: string, extra: object = {}): Promise<boolean> => (ops.length ? post("/api/patch", { ops, summary, ...extra }) : Promise.resolve(false));
/** the PAT loop's spend cap: set by clicking the cost meter, else 3 x the run budget, else $1 (the server applies the same default) */
export const loopCap = () => S.capUsd ?? (S.project?.budgets?.runUsd > 0 ? S.project.budgets.runUsd * 3 : 1);
let warned = (() => { try { return sessionStorage.getItem("agentloops.loop.warned") === "1"; } catch { return false; } })();
function play() {
  unlock();
  if (playing()) return post("/api/stop");
  S.notice = null;
  if (S.mode !== "pat") return post("/api/run", { arrangement: S.project.arrangements?.[0]?.id, cache: S.cache ? "prefer" : "fresh", pace: "project" });
  if (!warned && (S.project.channels ?? []).some((c: any) => c.generator?.plugin === "llm.agent" && !c.mute)) { // once per session: looping real models costs money
    if (!confirm(`PAT play repeats this pattern until you stop it, and each repeat runs its llm.agent channels again, which costs money. Voices whose prompt and inputs did not change replay from the cache for free. The loop stops by itself at $${loopCap().toFixed(2)} (click the cost meter to change it). Play?`)) return;
    warned = true; try { sessionStorage.setItem("agentloops.loop.warned", "1"); } catch {}
  }
  return post("/api/run", { pattern: curPattern()?.id, pace: "project", capUsd: loopCap(), ...(S.repeats ? { repeats: S.repeats } : {}) });
}
export const curPattern = () => (S.project?.patterns ?? []).find((p: any) => p.id === S.pattern) ?? S.project?.patterns?.[0];
export const chColor = (id: string) => (S.project?.channels ?? []).find((c: any) => c.id === id)?.color ?? "#9aa5ae";
export const chName = (id: string) => (S.project?.channels ?? []).find((c: any) => c.id === id)?.name ?? id;

// ---- run state, rebuilt from the shared event log ----
/** absolute run tick -> {pat, rel}: which pattern the head is in and where */
const wrap = (t: number, len: number) => (t > 0 && t % len === 0 ? len : t % len); // the end of a pattern stays at its end, not back at 1:01
export function relTick(r: Run, t: number) {
  if (r.pattern) { const pat = (S.project?.patterns ?? []).find((p: any) => p.id === r.pattern); return { pat: r.pattern, rel: wrap(t, Math.max(1, patLen(pat))) }; }
  const c = clipsOf().find((c: any) => t >= c.s && t < c.s + c.l) ?? clipsOf().findLast((c: any) => t >= c.s);
  return { pat: c?.ref, rel: c ? wrap(Math.min(t - c.s, c.l), Math.max(1, patLen(c.p))) : t };
}
export const noteKey = (pat: string, ch: string, key: number, rel: number) => `${pat}|${ch}|${key}|${rel}`;
const audible = (ch: string) => { const cs: any[] = S.project?.channels ?? [], c = cs.find((x) => x.id === ch); return !!c && !c.mute && (!cs.some((x) => x.solo) || !!c.solo); };
const plugin = (ch: string) => (S.project?.channels ?? []).find((c: any) => c.id === ch)?.generator?.plugin;
function applyEvent(e: any, live: boolean) {
  const r: Run = S.run, hist = S.runs.find((x: any) => x.id === e.runId);
  if (e.type === "song.open") { // the studio switched songs: earlier runs belong to the old one
    Object.assign(S, { run: newRun(), runs: [], monitor: [], meters: {}, voice: null, channel: null, pattern: null, loop: null });
    S.preview.clear();
    if (live) { for (const k of Object.keys(S.wins)) if (k.startsWith("ch:")) delete S.wins[k]; loadSongs(); }
    return;
  }
  if (e.type === "loop.end" && live && e.reason !== "stopped") S.notice = `Loop ended: ${e.reason}`;
  if (e.type === "frame" && e.bus) { // meters: each frame kicks the level, which decays; the peak holds (see tick)
    const m = (S.meters[e.bus] ??= { lv: 0, at: 0, pk: 0, pkAt: 0 }), lv = Math.min(1, m.lv * Math.exp(-(e.at - m.at) / 900) + 0.34);
    Object.assign(m, { lv, at: e.at }); if (lv >= peak(m, e.at)) Object.assign(m, { pk: lv, pkAt: e.at });
  }
  if (e.type === "run.start") { S.run = newRun(e); S.runs.push({ id: e.runId, repeat: e.repeat, pattern: e.pattern, master: [] }); if (S.runs.length > 60) S.runs.shift(); }
  if (e.type === "run.end" && hist) Object.assign(hist, { ended: true, cached: !e.summary?.voicesRun && e.summary?.cacheHits > 0 });
  if (e.type === "frame" && e.bus === "master" && e.final && hist) hist.master.push(e);
  if (live) heard(e.at); // the lookahead's clock, from every live event
  if (live && e.runId === r.id) { // sonification: only for what happens now, never for the replayed log
    const id = `${e.runId}:${e.voice}`;
    if (e.type === "voice" && e.phase === "start" && audible(e.channel)) {
      const c = (S.project?.channels ?? []).find((x: any) => x.id === e.channel); // the note rings for its length at tempo, longer while the agent runs
      voiceStart(id, e.key, plugin(e.channel), { sound: c?.sound, gain: c?.gain, vel: e.vel, pan: e.pan, text: e.text, ch: e.channel, dur: ((e.len ?? 0) * 60) / bpm() / 96, bpm: bpm(), mix: c?.mix }, e.at);
    }
    if (e.type === "voice" && e.phase === "end") voiceEnd(id, e.status === "failed" && audible(e.channel), e.at);
    if (e.type === "frame" && e.kind === "error") blip();
    if (e.type === "frame" && e.bus === "master" && e.final && e.kind !== "error" && !(r as any).chimed) { (r as any).chimed = true; chime(); } // once per run: the song landed
    if (e.type === "run.end") stopAll();
  }
  if (e.type === "run.start") return;
  if (e.runId && e.runId !== r.id) return; // a line from an older run
  if (e.type === "run.end") Object.assign(r, { running: false, end: e.at, summary: e.summary, error: e.error, cost: e.summary?.costUsd ?? r.cost });
  else if (["barrier", "pass", "voice", "frame"].includes(e.type)) {
    r.pass = e.pass; r.cost = e.costUsd;
    if (e.type === "barrier" || e.type === "pass") { r.tick = e.tick ?? pos(e.pos ?? 0); r.at = e.at; if (e.pos) r.pos = e.pos; }
    if (e.type === "voice") {
      r.voices.set(e.voice, { ...r.voices.get(e.voice), ...e, ...(e.phase === "start" ? { startAt: e.at } : {}), status: ({ start: "running", wait: "waiting", resume: "running" } as any)[e.phase] ?? e.status });
      if (e.phase === "end") {
        const b = (r.buses[e.bus] ??= { frames: 0, cost: 0, errors: 0 });
        b.cost += e.voiceCostUsd ?? 0; if (e.status === "failed") b.errors++;
        if (e.tick != null && e.text) { const { pat, rel } = relTick(r, e.tick); S.preview.set(noteKey(pat, e.channel, e.key, rel), e.text); }
      }
    }
    if (e.type === "frame") {
      const b = (r.buses[e.bus] ??= { frames: 0, cost: 0, errors: 0 });
      b.frames++; b.at = e.at; if (e.kind === "error") b.errors++;
      S.monitor.push({ ...e, repeat: r.repeat }); if (S.monitor.length > 400) S.monitor.shift();
    }
  }
}
function onEvent(e: any, live: boolean) {
  S.events.push(e); if (S.events.length > 400) S.events.shift();
  if (String(e.source).startsWith("mcp:") && (e.type === "edit" || e.type === "run.start")) { S.lastHarness = e; if (live) tryFlash(); }
  applyEvent(e, live);
}

// ---- edit flash: diff the old and new project by id, show it when an MCP edit caused it ----
let pending: { ids: Set<string>; at: number } | null = null;
function diff(a: any, b: any) {
  const ids = new Set<string>(), j = JSON.stringify;
  const cmp = (kind: string, xs: any[] = [], ys: any[] = []) => {
    const old = new Map(xs.map((x) => [x.id, j(x)]));
    for (const y of ys) if (old.get(y.id) !== j(y)) ids.add(`${kind}:${y.id}`);
  };
  cmp("ch", a?.channels, b?.channels); cmp("pat", a?.patterns, b?.patterns); cmp("bus", a?.mixer?.buses, b?.mixer?.buses);
  if (j(a?.mixer?.master) !== j(b?.mixer?.master)) ids.add("bus:master");
  if (j(a?.arrangements) !== j(b?.arrangements)) ids.add("arr");
  for (const p of b?.patterns ?? []) for (const ch of [...Object.keys(p.notes ?? {}), ...Object.keys(p.steps ?? {})]) {
    const o = (a?.patterns ?? []).find((x: any) => x.id === p.id);
    if (j(o?.notes?.[ch]) !== j(p.notes?.[ch]) || j(o?.steps?.[ch]) !== j(p.steps?.[ch])) ids.add(`ch:${ch}`);
  }
  return ids;
}
function tryFlash() {
  const h = S.lastHarness;
  if (!pending || !h || Math.abs(h.at - pending.at) > 2500) return;
  for (const id of pending.ids) S.flash.add(id);
  const ids = pending.ids; pending = null; paint();
  setTimeout(() => { for (const id of ids) S.flash.delete(id); paint(); }, 1500);
}
export const fl = (id: string) => (S.flash.has(id) ? " flash" : "");
function setState(st: any, live: boolean) {
  const ids = live ? diff(S.project, st.project) : new Set<string>();
  Object.assign(S, { project: st.project, errors: st.errors, takes: st.takes, latest: st.latest, file: st.file, serverPlaying: st.running, loop: st.loop ?? null });
  preload(st.project); // the sample files the song plays start downloading when it opens or changes
  songMix(st.project?.mix);
  if (S.bpm != null && S.bpm === st.project?.clock?.bpm) S.bpm = null; // the tempo edit landed
  if (S.pattern && !curPattern()?.id) S.pattern = null;
  if (ids.size) { pending = { ids, at: Date.now() }; tryFlash(); }
}

// ---- floating windows: the Playlist is the background, the rest float over it (FL's window model) ----
export const WINS: Record<string, { title: string; key: string; panel: string }> = {
  playlist: { title: "Playlist", key: "F5", panel: "playlist" }, rack: { title: "Channel rack", key: "F6", panel: "rack" }, piano: { title: "Piano roll", key: "F7", panel: "pianoroll" },
  mixer: { title: "Mixer", key: "F9", panel: "mixer" }, tracer: { title: "Tracer", key: "F10", panel: "tracer" }, monitor: { title: "Monitor", key: "F11", panel: "monitor" },
  browser: { title: "Browser", key: "Alt+F8", panel: "browser" },
};
const KEYS: Record<string, string> = Object.fromEntries(Object.entries(WINS).map(([id, w]) => [w.key, id]));
function defaultWins() {
  // the Playlist's first tracks stay visible; rack and piano roll over its left side, Monitor right, Mixer bottom
  const W = innerWidth, H = innerHeight - 64, mw = Math.min(440, W * 0.3), chs: any[] = S.project?.channels ?? [];
  const rh = 94 + 30 * Math.min(8, chs.length || 3), keys = Math.max(3, ...chs.map((c) => c.keymap?.length ?? 0)), py = 200 + rh;
  return {
    playlist: { open: true }, rack: { x: 124, y: 186, w: Math.min(700, W - mw - 150), h: rh, open: true, z: 3 },
    piano: { x: 124, y: py, w: Math.min(1000, W - mw - 150), h: Math.max(160, Math.min(H - 236 - py, 70 + 34 * Math.min(12, keys))), open: true, z: 2 },
    mixer: { x: 12, y: H - 296, w: Math.min(W - mw - 36, Math.max(640, 40 + 126 * ((S.project?.mixer?.buses?.length ?? 0) + 1))), h: 288, open: true, z: 4 }, monitor: { x: W - mw - 12, y: 8, w: mw, h: H - 16, open: true, z: 5 },
    tracer: { x: 160, y: 120, w: Math.min(980, W - 320), h: 420, open: false, z: 1 }, browser: { x: 0, y: 0, w: 250, h: H, open: false, z: 6 },
  } as Record<string, any>;
}
const LS = "agentloops.windows.v1";
const loadWins = () => { const d = defaultWins(); try { const s = JSON.parse(localStorage.getItem(LS) ?? "{}"); for (const k in d) Object.assign(d[k], s[k]); for (const k in s) if (k.startsWith("ch:")) d[k] = s[k]; } catch {} return d; };
const saveWins = () => { try { localStorage.setItem(LS, JSON.stringify(S.wins)); } catch {} };
let zTop = 10;
export function front(id: string) {
  const w = S.wins[id];
  if (S.panel !== id) { S.panel = id; paint(); }
  if (id !== "playlist" && w.z !== zTop) { w.z = ++zTop; paint(); }
}
/** open (creating) a floating window that is not in WINS, like a channel window; new ones cascade */
export function openWin(id: string, w = 560, h = 470) {
  const n = Object.keys(S.wins).filter((k) => k.startsWith("ch:") && S.wins[k].open).length;
  S.wins[id] ??= { x: Math.min(innerWidth - w - 20, 300 + 26 * n), y: 60 + 26 * n, w, h };
  toggleWin(id, true);
}
export function toggleWin(id: string, show?: boolean) {
  const w = S.wins[id]; w.open = show ?? !w.open;
  if (w.open) front(id);
  saveWins(); paint();
}
/** drag a window by its title bar, or resize it by the corner grip */
function dragWin(ev: PointerEvent, id: string, mode: "move" | "size") {
  if (ev.button !== 0 || (ev.target as HTMLElement).closest("button")) return;
  ev.preventDefault(); front(id);
  const w = S.wins[id], x0 = ev.clientX, y0 = ev.clientY, a = { ...w };
  const mv = (e: PointerEvent) => {
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (mode === "move") { w.x = Math.max(-a.w + 80, Math.min(innerWidth - 80, a.x + dx)); w.y = Math.max(0, Math.min(innerHeight - 90, a.y + dy)); }
    else { w.w = Math.max(240, a.w + dx); w.h = Math.max(120, a.h + dy); }
    paint();
  };
  const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); saveWins(); };
  addEventListener("pointermove", mv); addEventListener("pointerup", up);
}
function Win({ id, sub, children, title, tag, cls, style }: any) {
  const w = S.wins[id], d = WINS[id] ?? { title, key: "" };
  if (!w?.open) return null;
  return html`<section id=${id} class=${`win${cls ? ` ${cls}` : ""}${S.panel === id ? " front" : ""}`} tabindex="-1" aria-label=${d.key ? `${d.title}, ${d.key}` : d.title}
      style=${`left:${w.x}px;top:${w.y}px;width:${w.w}px;height:${w.h}px;z-index:${10 + w.z};${style ?? ""}`} onPointerDown=${() => front(id)}>
    <header class="tbar" onPointerDown=${(e: PointerEvent) => dragWin(e, id, "move")} data-hint=${`${d.title}: drag the title bar to move, the corner to resize.${d.key ? ` ${d.key} shows or hides it.` : ""}`}>
      <b>${d.title}</b><span class="sub">${sub}</span>${tag ?? html`<kbd>${d.key}</kbd>`}
      <button class="x" onClick=${() => toggleWin(id, false)} aria-label=${`Close ${d.title}`} data-hint=${d.key ? `Close (${d.key} brings it back)` : "Close"}>×</button></header>
    <div class="wbody">${children}</div>
    <i class="grip" onPointerDown=${(e: PointerEvent) => dragWin(e, id, "size")} aria-hidden="true"></i></section>`;
}

// ---- toolbar ----
const fmtT = (ms: number) => { const s = Math.max(0, ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`; };
const ago = (at: number) => { const s = Math.round((Date.now() - at) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };
const NAMES: Record<string, string> = { "claude-code": "Claude Code", "claude-ai": "Claude" };
/** Voices of the running run that wait for the outside harness to answer (a harness channel's note). */
export const waiting = (): any[] => (S.run.running ? [...S.run.voices.values()].filter((v: any) => v.status === "waiting") : []);
export const waitFor = (v: any) => {
  const c = String(v?.source ?? "");
  return c.startsWith("mcp:") ? `⏳ waiting for ${NAMES[c.slice(4)] ?? c.slice(4)}` : "⏳ waiting for your harness: ask it to answer (voice_reply)"; // a run started in the studio has no known client
};
export const who = (src: string) => src?.startsWith("mcp:") ? `via MCP · ${NAMES[src.slice(4)] ?? src.slice(4)}` : src === "cli" ? "CLI" : src ?? "";

// tempo: wheel or drag up/down previews locally; one edit (one undo step) lands when the gesture settles
let tempoT: any;
const setTempo = (v: number) => { S.bpm = Math.round(Math.max(10, Math.min(999, v))); paint(); clearTimeout(tempoT); tempoT = setTimeout(() => post("/api/tempo", { bpm: S.bpm }), 450); };
function tempoDrag(ev: PointerEvent) {
  if (ev.button !== 0) return;
  const y0 = ev.clientY, b0 = bpm();
  const mv = (e: PointerEvent) => setTempo(b0 + (y0 - e.clientY) / 3);
  const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); };
  addEventListener("pointermove", mv); addEventListener("pointerup", up);
}

function Toolbar() {
  const r: Run = S.run, pats = S.project?.patterns ?? [], on = playing(), wt = waiting();
  const budget = r.budget ?? S.project?.budgets?.runUsd, pct = budget ? Math.min(100, (r.cost / budget) * 100) : 0;
  const h = S.lastHarness, live = h && Date.now() - h.at < 600_000;
  return html`<header id="toolbar" aria-label="Transport and status">
    <div class="brand" aria-hidden="true">AgentLoops</div>
    <div class="grp">
      <button class=${`tp play${on ? " on" : ""}`} onClick=${play} aria-pressed=${on} aria-label=${on ? "Stop (Space)" : "Play (Space)"}
        data-hint=${on ? "Stop (Space): ends the current run and the loop. The take is still saved." : S.mode === "pat" ? "Play the pattern (Space). It repeats until you stop it; edits land on the next repeat." : "Play the song once (Space)"}>${on ? "■" : "▶"}</button>
      <span class="seg" role="group" aria-label="Play mode (L)">
        <button aria-pressed=${S.mode === "pat"} onClick=${() => { S.mode = "pat"; paint(); }} data-hint="Pattern mode: loop the selected pattern until Stop (L)">PAT</button><button aria-pressed=${S.mode === "song"} onClick=${() => { S.mode = "song"; paint(); }} data-hint="Song mode: play the arrangement in the Playlist once (L)">SONG</button>
      </span>
      <span class="patsel">
        <select aria-label="Pattern" value=${curPattern()?.id} onChange=${(e: any) => { S.pattern = e.target.value; paint(); }} onContextMenu=${patternMenu} data-hint="Selected pattern: shown in the rack and piano roll, played in PAT mode, placed by clicking the Playlist. Right-click for clone, rename and delete.">
          ${pats.map((p: any) => html`<option value=${p.id}>${p.name ?? p.id}</option>`)}</select>
        <button onClick=${newPattern} aria-label="New pattern" data-hint="New empty pattern">+</button>
        <button onClick=${(e: MouseEvent) => openLoop(e, "pattern")} disabled=${!curPattern()} aria-label="Pattern length and loop" data-hint="Pattern length and loop: max passes, until">⟳</button>
        <button onClick=${patternMenu} aria-label="Pattern menu" data-hint="New, clone, rename or delete the pattern">⋯</button></span>
      <select class="reps" aria-label="Stop after N repeats" value=${String(S.repeats)} onChange=${(e: any) => { S.repeats = +e.target.value; paint(); }} data-hint="PAT play: stop after this many repeats (∞ loops until Stop or the spend cap)">
        ${[0, 1, 2, 3, 4, 8, 16].map((n) => html`<option value=${String(n)}>${n ? `×${n}` : "×∞"}</option>`)}</select>
    </div>
    <div class="lcd" data-hint="Song position bar:step:tick, the repeat (PAT loop) and pass, and the elapsed time of the run">
      <span class="big" id="lcd-pos">1:01:00</span>
      <span class="meta"><span>${r.repeat ? `repeat ${r.repeat}` : r.id && !r.pattern ? "song" : "—"}</span><span>pass ${r.pass + 1}</span></span>
      <span class="big dim" id="lcd-time">00:00.0</span>
    </div>
    <div class="lcd tempo" tabindex="0" role="spinbutton" aria-label="Tempo, BPM" aria-valuenow=${bpm()} aria-valuemin="10" aria-valuemax="999"
      onWheel=${(e: WheelEvent) => { e.preventDefault(); setTempo(bpm() + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 10 : 1)); }} onPointerDown=${tempoDrag}
      onKeyDown=${(e: KeyboardEvent) => { const d = ({ ArrowUp: 1, ArrowDown: -1 } as any)[e.key]; if (d) { e.preventDefault(); setTempo(bpm() + d * (e.shiftKey ? 10 : 1)); } }}
      data-hint="Tempo: scroll or drag up/down (Shift: by 10). A speed limit for Play: fast agents play at tempo, slow ones hold the playhead.">
      <span class="big">${bpm().toFixed(0)}</span><span class="meta"><span>BPM</span><span>${S.bpm != null ? "…" : "tempo"}</span></span></div>
    <div class="grp snd">
      <button class=${`spk${sound.on ? " on" : ""}`} aria-pressed=${sound.on} aria-label="Sound" onClick=${() => { setOn(!sound.on); paint(); }}
        onWheel=${(e: WheelEvent) => { e.preventDefault(); setVol(sound.vol + (e.deltaY < 0 ? 0.05 : -0.05)); paint(); }}
        data-hint=${`Sound ${sound.on ? "on" : "off"}, volume ${Math.round(sound.vol * 100)}%. Click to toggle, scroll to change the volume. Each voice is a tone at its note's key while the agent runs; Master frames chime, errors blip.`}>${sound.on ? "♪" : "♪̸"}<small>${Math.round(sound.vol * 100)}</small></button>
      <button class=${`metro${sound.metro ? " on" : ""}`} aria-pressed=${sound.metro} aria-label="Metronome" onClick=${() => { setMetro(!sound.metro); paint(); }} data-hint="Metronome: a click on each beat while playing, accent on the bar">♩</button>
      <button class="metro" aria-label="Export audio" onClick=${(e: MouseEvent) => exportAudio(e.shiftKey)} disabled=${!!S.exporting} data-hint=${`Export audio: bounce the ${S.mode === "pat" ? "current pattern" : "song"} to a WAV, offline, with the same instruments (Ctrl+Alt+R). Shift+click: Save MP3 to project folder (slower: the studio renders it).`}>${S.exporting ? "…" : "⤓"}</button>
    </div>
    <div class="grp">
      <button onClick=${() => post("/api/undo")} disabled=${!S.project} data-hint="Undo the latest edit, whoever made it: you, Claude Code or another client (Ctrl+Z)">↶</button>
      <label class="tog" data-hint="Song mode: replay unchanged voices from earlier takes instead of running them again (PAT loops always do)"><input type="checkbox" checked=${S.cache} onChange=${(e: any) => { S.cache = e.target.checked; }}/>Cache</label>
    </div>
    ${S.mode === "pat" ? (() => {
      const lp = S.loop, cap = lp?.running ? lp.capUsd : loopCap(), spent = lp ? lp.spentUsd + (lp.running && r.running ? r.cost : 0) : 0, lpct = Math.min(100, (spent / cap) * 100);
      return html`<button class="cpu loopcap" role="meter" aria-label="This loop's spend against its cap" aria-valuenow=${spent} aria-valuemin="0" aria-valuemax=${cap}
        onClick=${() => { const v = prompt("Spend cap for a PAT loop, in dollars: the loop stops when its repeats together reach it", cap.toFixed(2)); if (v != null && +v > 0) { S.capUsd = +v; paint(); } }}
        data-hint=${`This loop: $${spent.toFixed(4)} of its $${cap.toFixed(2)} spend cap, over every repeat (this repeat: $${r.cost.toFixed(4)} of the $${budget ?? "—"} run budget). Click to change the cap.`}>
        <span class="bars">${Array.from({ length: 10 }, (_, i) => html`<i class=${i * 10 < lpct ? (i >= 8 ? "hot" : "lit") : ""}></i>`)}</span>
        <span class="num"><small>this loop</small> $${spent.toFixed(2)}<small>/ $${cap.toFixed(2)}</small></span></button>`;
    })() : html`<div class="cpu" role="meter" aria-label="Run cost against budget" aria-valuenow=${r.cost} aria-valuemin="0" aria-valuemax=${budget ?? 0}
      data-hint=${`Cost of the ${r.running ? "current" : "last"} run: $${r.cost.toFixed(4)} of the $${budget ?? "—"} run budget`}>
      <span class="bars">${Array.from({ length: 10 }, (_, i) => html`<i class=${i * 10 < pct ? (i >= 8 ? "hot" : "lit") : ""}></i>`)}</span>
      <span class="num">$${r.cost.toFixed(2)}<small>/ ${budget != null ? `$${Number(budget).toFixed(2)}` : "—"}</small></span></div>`}
    ${S.notice ? html`<button class="notice" role="status" onClick=${() => { S.notice = null; paint(); }} data-hint="Click to dismiss">${S.notice}</button>` : null}
    <button class=${`errs ${S.errors.length ? "bad" : "ok"}`} onClick=${() => { S.showErrors = !S.showErrors; paint(); }} aria-expanded=${S.showErrors} data-hint="Validation errors: click for path, message and fix">${S.errors.length ? `⚠ ${S.errors.length}` : "✓"}</button>
    <button class=${`harness${live ? " live" : ""}`} onClick=${openConnect} data-hint=${(h ? `Last outside edit: ${h.tool ?? h.type} ${h.summary ?? ""}. ` : "Edits and runs from Claude Code or any MCP client show up here. ") + "Click to connect a harness."}>${h ? `⇄ ${NAMES[h.source.slice(4)] ?? h.source.slice(4)} · ${h.type === "edit" ? "edit" : "run"} · ${ago(h.at)}` : "⇄ connect"}</button>
    ${wt.length ? html`<span class="paused" role="status" data-hint="The run is paused until the harness answers with voice_reply. Stop (Space) ends it.">${waitFor(wt[0])}${wt.length > 1 ? ` · ${wt.length} voices` : ""}</span>` : null}
    <div id="hint" role="status" aria-live="polite">${hintText}</div>
  </header>`;
}

// ---- Connect a harness: writes the project-local MCP config + AGENTS.md for the chosen coding agent ----
const HARNESS_LIST: { id: string; name: string; desc: string }[] = [];
const copy = (text: string) => navigator.clipboard.writeText(text).then(() => setHint("Copied"), () => setHint("Copy failed: select the text and copy it by hand"));
async function connect(id: string) {
  S.connect.busy = id; paint();
  try {
    const r = await fetch("/api/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ harness: id }) }), j = await r.json();
    S.connect.res[id] = r.ok ? j : { error: j.error };
  } catch (e: any) { S.connect.res[id] = { error: e.message }; }
  S.connect.busy = null; paint();
}
export async function openConnect() {
  if (!HARNESS_LIST.length) HARNESS_LIST.push(...(await (await fetch("/api/harnesses")).json()));
  openWin("connect", 560, 520);
}
function Connect() {
  const c = S.connect;
  return html`<div class="connect">
    <p class="blurb">Pick the coding agent you use. Studio writes its project-local MCP settings (and AGENTS.md) next to ${S.file}; files that already exist are left alone.</p>
    ${HARNESS_LIST.map((x) => { const r = c.res[x.id]; return html`<div class="hrow" key=${x.id}>
      <div class="hhead"><span><b>${x.name}</b><span class="muted"> ${x.desc}</span></span>
        <button onClick=${() => connect(x.id)} disabled=${c.busy === x.id}>${c.busy === x.id ? "…" : r && !r.error ? "Set up again" : "Set up"}</button></div>
      ${r?.error ? html`<p class="bad">${r.error}</p>` : r ? html`
        ${r.wrote.length ? html`<p>Wrote ${r.wrote.map((f: string) => html`<code>${f}</code> `)}</p>` : null}
        ${r.skipped.length ? html`<p class="muted">Already there, skipped ${r.skipped.map((f: string) => html`<code>${f}</code> `)}</p>` : null}
        <p class="next"><span>Next: ${r.next}</span><button onClick=${() => copy(r.next)} aria-label="Copy the next step">Copy</button></p>
        ${r.snippet ? html`<div class="snip"><button onClick=${() => copy(r.snippet)} aria-label="Copy the snippet">Copy</button><pre>${r.snippet}</pre></div>` : null}` : null}
    </div>`; })}</div>`;
}

function Errors() {
  if (!S.showErrors) return null;
  return html`<div id="errors" role="dialog" aria-label="Validation errors">${S.errors.length ? html`<ul>${S.errors.map((x: any) => html`<li><code>${x.path || "/"}</code> ${x.message}<br/><span class="muted">fix: ${x.fix}</span></li>`)}</ul>` : html`<p class="muted">No validation errors.</p>`}</div>`;
}

function App() {
  const pat = curPattern(), ch = selChannel(), mb = S.monitorBus;
  return html`${Toolbar()}${Errors()}
    <main id="desk" onContextMenu=${(e: Event) => (e.target as HTMLElement).closest(".nocm") && e.preventDefault()}>
      ${S.wins.playlist.open ? Playlist() : html`<p class="desk-empty">F5 shows the Playlist.</p>`}
      <${Win} id="rack" sub=${`${pat?.name ?? pat?.id ?? "no pattern"} · ${pat?.lengthSteps ?? 16} steps`}>${Rack()}<//>
      <${Win} id="piano" sub=${`${chName(ch ?? "")} · ${pat?.name ?? ""}`}>${Piano()}<//>
      <${Win} id="mixer" sub=${`${(S.project?.mixer?.buses?.length ?? 0) + 1} buses · monitoring ${mb}`}>${Mixer()}<//>
      <${Win} id="tracer" sub=${S.latest ? `take ${S.latest.run.id}` : ""}>${Tracer()}<//>
      <${Win} id="monitor" sub=${S.monTab === "live" ? "live, this pass" : S.monTab === "bus" ? `bus ${mb}` : "Master"}>${Monitor()}<//>
      <${Win} id="browser" sub="drag or double-click">${Browser()}<//>
      <${Win} id="connect" title="Connect a harness" sub="coding agents" tag=${html`<span></span>`}>${Connect()}<//>
      ${Object.keys(S.wins).filter((k) => k.startsWith("ch:") && S.wins[k].open).map((k) => {
        const c = (S.project.channels ?? []).find((x: any) => x.id === k.slice(3));
        return html`<${Win} key=${k} id=${k} cls="chwin" title=${c?.name ?? k.slice(3)} style=${`--c:${c?.color ?? "#9aa5ae"}`} sub=${c ? `→ ${c.output && c.output !== "master" ? (S.project.mixer?.buses ?? []).find((x: any) => x.id === c.output)?.name ?? c.output : "Master"}` : "deleted"} tag=${html`<span class="plug">${c?.generator?.plugin ?? "—"}</span>`}>${ChannelWin(k.slice(3))}<//>`;
      })}
    </main>${Menu()}${Picker()}${SlotEditor()}${LoopPop()}`;
}

let hintText = "";
const DEFAULT_HINT = "Space play/stop · L pattern/song · Ctrl+Z undo · F5 playlist · F6 rack · F7 piano roll · F8 add channel · Alt+F8 browser · F9 mixer · F10 tracer · F11 monitor";
export const setHint = (t: string) => { if (t !== hintText) { hintText = t; paint(); } };

let queued = false;
const root = document.getElementById("app")!;
export function paint() {
  if (queued) return; queued = true;
  requestAnimationFrame(() => { queued = false; if (S.project) { document.title = `${S.project.name ?? S.file} — AgentLoops`; render(App(), root); reportView(); } });
}

// ---- the playhead: interpolated from the last barrier's wall clock and the tempo, clamped at the next barrier (a stall) ----
let ptsMemo: any = {}, lastBeat = -1;
function points(r: Run) {
  if (ptsMemo.p === S.project && ptsMemo.id === r.id) return ptsMemo.v;
  const ps: number[] = [];
  const add = (pat: any, s: number, len: number) => {
    if (!pat) return;
    for (const st of Object.values<number[]>(pat.steps ?? {})) st.forEach((v, i) => v && i * STEP < len && ps.push(s + i * STEP));
    for (const ns of Object.values<any[]>(pat.notes ?? {})) for (const n of ns) if (pos(n.start) < len) ps.push(s + pos(n.start));
    ps.push(s + len);
  };
  if (r.pattern) { const pat = (S.project.patterns ?? []).find((p: any) => p.id === r.pattern); add(pat, 0, patLen(pat)); }
  else for (const c of clipsOf()) add(c.p, c.s, c.l);
  ptsMemo = { p: S.project, id: r.id, v: ps.sort((a, b) => a - b) };
  return ptsMemo.v;
}
export function head() {
  const r: Run = S.run;
  if (!r.id) return { t: 0, stalled: false };
  if (!r.running || !r.pace) return { t: r.tick, stalled: false };
  const mpt = 60000 / r.pace / 96, t = r.tick + (Date.now() - r.at) / mpt, next = points(r).find((x: number) => x > r.tick) ?? r.tick;
  return { t: Math.min(t, next), stalled: t > next + 150 / mpt };
}
/** a meter's held peak: holds 1.5 s, then falls at half a meter per second */
function peak(m: any, now: number) { const t = now - m.pkAt; return t < 1500 ? m.pk : Math.max(0, m.pk - (t - 1500) / 2000); }
function tick() {
  requestAnimationFrame(tick);
  if (!S.project) return;
  const r: Run = S.run, { t, stalled } = head(), { pat, rel } = relTick(r, t), cp = curPattern(), de = document.documentElement;
  de.style.setProperty("--ph", String(t));
  de.style.setProperty("--php", String(rel));
  document.body.classList.toggle("running", r.running);
  document.body.classList.toggle("stalled", stalled);
  document.body.classList.toggle("ph-here", !!r.id && pat === cp?.id);
  const p = document.getElementById("lcd-pos"), tm = document.getElementById("lcd-time");
  if (p) p.textContent = lcdPos(t);
  if (tm) tm.textContent = fmtT(r.start ? (r.end ?? (r.running ? Date.now() : r.start)) - r.start : 0);
  const step = r.running && pat === cp?.id ? Math.floor(rel / STEP) : -1;
  const beat = r.running && r.pace ? Math.floor(t / 96) : -1; // metronome: a click per beat while the head moves, accent on the bar
  if (beat !== lastBeat) { if (beat >= 0 && !stalled) click(beat % 4 === 0); lastBeat = beat; }
  document.querySelectorAll<HTMLElement>(".leds i").forEach((el, i) => el.classList.toggle("on", i === step));
  for (const el of document.querySelectorAll<HTMLElement>(".meter[data-bus]")) { // decaying level, held peak
    const m = S.meters[el.dataset.bus!], now = Date.now(), lv = m ? m.lv * Math.exp(-(now - m.at) / 900) : 0, pk = m ? Math.max(lv, peak(m, now)) : 0, [a, b, c] = el.children as any;
    if (a) a.style.height = `${lv * 100}%`; if (b) b.style.height = `${lv * 86}%`; if (c) { c.style.bottom = `calc(${pk * 100}% - 2px)`; c.style.opacity = pk > 0.02 ? "1" : "0"; }
  }
  const now = Date.now(); // hits (a voice starting, a frame reaching a bus) fade out over 900 ms; JS-driven so every frame and screenshot agrees
  document.querySelectorAll<HTMLElement>(".hit").forEach((el) => { el.style.opacity = String(Math.max(0, 1 - (now - +el.dataset.t!) / 900)); });
  const busy = stalled ? [...new Set([...r.voices.values()].filter((v: any) => v.status === "running" || v.status === "waiting").map((v: any) => chName(v.channel)))] : [];
  document.querySelectorAll<HTMLElement>(".ph-tag").forEach((el) => { el.textContent = busy.length ? `⏳ ${busy.join(", ")}…` : ""; });
}
requestAnimationFrame(tick);

// ---- shared with the agent: studio_view reads this, studio_focus moves it ----
let lastView = "";
function reportView() {
  const v = { panel: WINS[S.panel]?.panel ?? null, pattern: curPattern()?.id ?? null, channel: selChannel() ?? null, voice: S.voice,
    selection: S.voice != null ? `voice:${S.voice}` : S.channel ? `channel:${S.channel}` : S.pattern ? `pattern:${S.pattern}` : null,
    windows: Object.keys(WINS).filter((k) => S.wins[k].open).map((k) => WINS[k].panel) };
  const j = JSON.stringify(v);
  if (j === lastView) return;
  lastView = j; fetch("/api/view", { method: "POST", headers: { "content-type": "application/json" }, body: j }).catch(() => {});
}
function showFocus(f: any) {
  if (f.pattern) S.pattern = f.pattern;
  if (f.channel) S.channel = f.channel;
  if (f.voice != null) S.voice = f.voice;
  if (f.bus) { S.monitorBus = f.bus; S.monTab = f.bus === "master" ? "master" : "bus"; }
  const panel = f.panel ?? (f.voice != null ? "tracer" : f.bus ? "mixer" : f.channel ? "pianoroll" : f.pattern ? "rack" : null);
  const id = Object.keys(WINS).find((k) => WINS[k].panel === panel);
  if (id) toggleWin(id, true);
  const ids = [f.channel && `ch:${f.channel}`, f.pattern && `pat:${f.pattern}`, f.bus && `bus:${f.bus}`, f.voice != null && `voice:${f.voice}`].filter(Boolean) as string[];
  for (const x of ids) S.flash.add(x);
  paint();
  requestAnimationFrame(() => requestAnimationFrame(() => { // after the repaint
    const el = id ? document.getElementById(id) : null;
    el?.classList.add("flash"); el?.focus({ preventScroll: true });
    if (f.voice != null) document.querySelector(`[data-k="v:${f.voice}"]`)?.scrollIntoView({ block: "nearest" });
    setTimeout(() => { for (const x of ids) S.flash.delete(x); el?.classList.remove("flash"); paint(); }, 1500);
  }));
}

// ---- wiring ----
const hintOf = (ev: Event) => setHint((ev.target as HTMLElement).closest?.<HTMLElement>("[data-hint]")?.dataset.hint ?? DEFAULT_HINT);
document.addEventListener("mouseover", hintOf);
document.addEventListener("focusin", hintOf);
document.addEventListener("keydown", (ev) => {
  const t = ev.target as HTMLElement;
  if (KEYS[ev.key] && !ev.ctrlKey && !ev.altKey) { ev.preventDefault(); return toggleWin(KEYS[ev.key]); }
  if (ev.key === "F8") { ev.preventDefault(); return ev.altKey ? toggleWin("browser") : openPicker("gen"); }
  if (t.closest("input, select, textarea, [contenteditable]")) return;
  if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === "z") { ev.preventDefault(); return void post("/api/undo"); }
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.key === " " && !t.closest("button")) { ev.preventDefault(); play(); }
  else if ((ev.key === "r" || ev.key === "R") && ev.ctrlKey && ev.altKey) { ev.preventDefault(); exportAudio(ev.shiftKey); }
  else if (ev.key === "l" || ev.key === "L") { S.mode = S.mode === "pat" ? "song" : "pat"; paint(); }
  else if (ev.key === "Escape") { Object.assign(S, { showErrors: false, menu: null, picker: null, slotEd: null, pop2: null }); paint(); }
});
// a click outside closes the open menu, picker or popover (capture phase: before the click can open the next one)
document.addEventListener("pointerdown", (e) => {
  if ((e.target as HTMLElement).closest?.(".menu, .picker, .pop2") || !(S.menu || S.picker || S.slotEd || S.pop2)) return;
  Object.assign(S, { menu: null, picker: null, slotEd: null, pop2: null }); paint();
}, true);
setInterval(() => S.project && paint(), 1000); // "3s ago" labels

// ?export=<id>: a headless browser opened by the host only renders that export (no state, no SSE, no windows) and never goes on to boot the studio
const xq = new URLSearchParams(location.search), xid = xq.get("export");
if (xid) {
  await hostExport({ id: xid, arrangement: xq.get("arrangement") ?? undefined, pattern: xq.get("pattern") ?? undefined, stems: xq.get("stems") === "1" });
  await new Promise(() => {});
}

const boot = JSON.parse(document.getElementById("boot")?.textContent ?? "null") ?? await (await fetch("/api/state")).json();
await loadCatalog();
setState(boot, false);
S.wins = loadWins(); zTop = Math.max(...Object.values<any>(S.wins).map((w) => w.z ?? 0));
for (const e of boot.events ?? []) onEvent(e, false);
if (S.run.running && !boot.running) S.run.running = false; // the log ended mid-run (studio restarted)
hintText = DEFAULT_HINT;
paint();
const es = new EventSource("/api/events");
es.addEventListener("state", (m) => { setState(JSON.parse(m.data), true); paint(); });
es.addEventListener("event", (m) => { onEvent(JSON.parse(m.data), true); paint(); });
es.addEventListener("focus", (m) => showFocus(JSON.parse(m.data)));
es.addEventListener("export", (m) => { // audio_export: answer at once so the host knows this tab is rendering
  const x = JSON.parse(m.data);
  fetch(`/api/export/${x.id}/ack`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
  S.notice = "Rendering audio for the agent…"; paint();
  hostExport(x).finally(() => { S.notice = "Audio rendered for the agent"; paint(); });
});
es.addEventListener("export-cancel", (m) => { cancelled.add(JSON.parse(m.data).id); });
es.addEventListener("loop", (m) => { S.loop = JSON.parse(m.data); paint(); });
