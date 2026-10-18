// AgentLoops Studio, browser side. Served type-stripped by src/studio.ts.
// ponytail: plain DOM re-render; adopt Preact when panels gain rich interactive state
import { drawPiano, mixer, piano, playlist, rack, tracer } from "./panels.ts";

export const esc = (s: any) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const ptr = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
export const $ = (id: string) => document.getElementById(id)!;

type Run = { id?: string; running: boolean; start: number; end?: number; pos?: string; pass: number; cost: number; budget?: number; pattern?: string;
  voices: Map<number, any>; buses: Record<string, { frames: number; cost: number; errors: number }>; summary?: any; error?: string };
export const S: any = {
  project: null, errors: [], takes: [], latest: null, events: [] as any[], score: "",
  mode: "song", pattern: null as string | null, channel: null as string | null, cache: false, voice: null as number | null,
  run: { running: false, start: 0, pass: 0, cost: 0, voices: new Map(), buses: {} } as Run,
  flash: new Set<string>(), lastHarness: null as any,
};

export async function patch(ops: any[], summary: string) {
  const r = await fetch("/api/patch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ops, summary }) });
  if (!r.ok) setHint(`Edit refused: ${(await r.json()).error}`);
}
async function post(path: string, body: any = {}) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) setHint(`${path.slice(5)} refused: ${(await r.json()).error}`);
}
const play = () => S.run.running ? post("/api/stop")
  : post("/api/run", { ...(S.mode === "pat" ? { pattern: curPattern()?.id } : { arrangement: S.project.arrangements?.[0]?.id }), cache: S.cache ? "prefer" : "fresh" });
export const curPattern = () => (S.project?.patterns ?? []).find((p: any) => p.id === S.pattern) ?? S.project?.patterns?.[0];
export const chColor = (id: string) => (S.project?.channels ?? []).find((c: any) => c.id === id)?.color ?? "#9aa5ae";

// ---- run state, rebuilt from the shared event log ----
function applyEvent(e: any) {
  const r: Run = S.run;
  if (e.type === "run.start") S.run = { id: e.runId, running: true, start: e.at, pass: 0, cost: 0, budget: e.budget, pattern: e.pattern, voices: new Map(), buses: {} };
  else if (e.runId && e.runId !== r.id) return; // a voice line from an older run
  else if (e.type === "run.end") {
    Object.assign(r, { running: false, end: e.at, summary: e.summary, error: e.error, cost: e.summary?.costUsd ?? r.cost });
    // live meters only see frames voices wrote directly; the summary also counts frames that came through sends
    for (const [id, b] of Object.entries<any>(e.summary?.buses ?? {})) r.buses[id] = { cost: 0, ...r.buses[id], frames: b.frames, errors: b.errors };
  }
  else if (["barrier", "pass", "voice"].includes(e.type)) {
    r.pass = e.pass; r.cost = e.costUsd; if (e.pos) r.pos = e.pos;
    if (e.type === "voice") {
      r.voices.set(e.voice, { ...r.voices.get(e.voice), ...e, status: e.phase === "start" ? "running" : e.status });
      if (e.phase === "end") {
        const b = (r.buses[e.bus] ??= { frames: 0, cost: 0, errors: 0 });
        b.frames += e.frames ?? 0; b.cost += e.voiceCostUsd ?? 0; if (e.status === "failed") b.errors++;
      }
    }
  }
}
function onEvent(e: any, live: boolean) {
  S.events.push(e); if (S.events.length > 400) S.events.shift();
  if (String(e.source).startsWith("mcp:") && (e.type === "edit" || e.type === "run.start")) { S.lastHarness = e; if (live) tryFlash(); }
  applyEvent(e);
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
  Object.assign(S, { project: st.project, errors: st.errors, takes: st.takes, latest: st.latest, score: st.score, file: st.file });
  if (S.pattern && !curPattern()?.id) S.pattern = null;
  if (ids.size) { pending = { ids, at: Date.now() }; tryFlash(); }
}

// ---- toolbar, feed, hint ----
const fmtT = (ms: number) => { if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`; const s = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const ago = (at: number) => { const s = Math.round((Date.now() - at) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };
const NAMES: Record<string, string> = { "claude-code": "Claude Code", "claude-ai": "Claude" };
export const who = (src: string) => src?.startsWith("mcp:") ? `via MCP · ${NAMES[src.slice(4)] ?? src.slice(4)}` : src === "cli" ? "CLI" : src ?? "";

function toolbarCtl() {
  const pats = S.project?.patterns ?? [];
  set($("tb-ctl"), `
    <button class="play" data-act="play" aria-pressed="${S.run.running}" aria-label="${S.run.running ? "Stop" : "Play"} (Space)" data-hint="${S.run.running ? "Stop the run (Space). The take is still saved." : `Play the ${S.mode === "pat" ? "pattern" : "song"} (Space)`}" data-k="play">${S.run.running ? "■" : "▶"}</button>
    <span class="seg" role="group" aria-label="Play mode (L)">
      <button data-act="mode" data-v="pat" aria-pressed="${S.mode === "pat"}" data-hint="Pattern mode: loop the selected pattern on its own (L)" data-k="pat">PAT</button><button data-act="mode" data-v="song" aria-pressed="${S.mode === "song"}" data-hint="Song mode: play the arrangement (L)" data-k="song">SONG</button>
    </span>
    <label data-hint="Pattern shown in the rack and piano roll, and played in PAT mode"><span class="sr">Pattern</span>
      <select data-act="pattern" data-k="patsel">${pats.map((p: any) => `<option value="${esc(p.id)}"${p.id === curPattern()?.id ? " selected" : ""}>${esc(p.name ?? p.id)}</option>`).join("")}</select></label>
    <label data-hint="Replay unchanged voices from earlier takes instead of running them again"><input type="checkbox" data-act="cache" data-k="cache"${S.cache ? " checked" : ""}> Cache</label>
    <span class="muted" data-hint="Project file">${esc(S.project?.name)} <small>${esc(S.file)}</small></span>`);
}
function toolbarStatus() {
  const r: Run = S.run, budget = r.budget ?? S.project?.budgets?.runUsd, pct = budget ? Math.min(100, (r.cost / budget) * 100) : 0;
  const h = S.lastHarness, live = h && Date.now() - h.at < 600_000;
  const el = (r.end ?? (r.running ? Date.now() : r.start)) - r.start;
  set($("tb-status"), `
    <span class="lcd" data-hint="Position bar:step of the last barrier, and pass">${esc(r.pos ?? "1:01")}<small>pass ${r.pass + 1}</small></span>
    <span class="lcd" data-hint="Elapsed wall time of the ${r.running ? "current" : "last"} run">${fmtT(r.start ? el : 0)}</span>
    <span class="cost" data-hint="Cost of the ${r.running ? "current" : "last"} run against the run budget">$${r.cost.toFixed(2)} / $${budget != null ? Number(budget).toFixed(2) : "—"}<span class="bar"><i class="${pct > 80 ? "hot" : ""}" style="width:${pct}%"></i></span></span>
    <button class="errs ${S.errors.length ? "bad" : "ok"}" data-act="errors" data-k="errs" aria-expanded="${!$("errors").hidden}" data-hint="Validation errors: click for path, message and fix">${S.errors.length ? `⚠ ${S.errors.length} error${S.errors.length > 1 ? "s" : ""}` : "✓ valid"}</button>
    <span class="harness${live ? " live" : ""}" data-hint="${h ? `Last outside edit: ${esc(h.tool ?? h.type)} ${esc(h.summary ?? "")}` : "Edits from Claude Code or any MCP client show up here"}">${h ? `⇄ ${esc(NAMES[h.source.slice(4)] ?? h.source.slice(4))} · ${h.type === "edit" ? "edit" : "run"} · ${ago(h.at)}` : "⇄ no harness yet"}</span>`);
  const e = $("errors");
  if (!e.hidden) set(e, S.errors.length ? `<ul>${S.errors.map((x: any) => `<li><code>${esc(x.path || "/")}</code> ${esc(x.message)}<br><span class="muted">fix: ${esc(x.fix)}</span></li>`).join("")}</ul>` : `<p class="muted">No validation errors.</p>`);
}
function feed() {
  const items = S.events.filter((e: any) => e.type === "edit" || e.type.startsWith("run.") || (e.type === "voice" && e.status === "failed")).slice(-60).reverse();
  set($("feed"), `<h2>Activity <span class="muted">${items.length}</span></h2><div class="body"><ul class="feed">${items.map((e: any) => {
    const t = new Date(e.at).toLocaleTimeString([], { hour12: false });
    const what = e.type === "edit" ? `${esc(e.tool)} <span class="muted">${esc(e.summary)}</span>`
      : e.type === "run.start" ? `Run started · ${esc(e.pattern ? `pattern ${e.pattern}` : "song")}`
      : e.type === "run.end" ? (e.error ? `Run failed: ${esc(e.error)}` : `Run done · ${e.summary.passes} passes · ${e.summary.voicesRun} voices · $${e.summary.costUsd.toFixed(4)}${e.summary.stopped ? ` · stopped: ${esc(e.summary.stopped)}` : ""}`)
      : `Voice failed: ${esc(e.channel)} · ${esc(e.error)}`;
    const cls = e.type === "run.end" ? (e.error || e.summary?.stopped ? "fail" : "end") : e.type === "voice" ? "fail" : "";
    return `<li class="${cls}"><header><span class="src${String(e.source).startsWith("mcp:") ? " mcp" : ""}">${esc(who(e.source))}</span><span>${t}</span></header>${what}</li>`;
  }).join("") || `<li class="muted">Nothing yet. Edits and runs from the studio, the CLI and MCP clients land here.</li>`}</ul></div>`);
}

/** innerHTML swap that keeps keyboard focus on the element with the same data-k. */
export function set(el: HTMLElement, html: string) {
  const a = document.activeElement as HTMLElement | null, k = el.contains(a) ? a?.dataset.k : null;
  el.innerHTML = html;
  if (k) (el.querySelector(`[data-k="${CSS.escape(k)}"]`) as HTMLElement | null)?.focus();
}
let hintText = "";
export const setHint = (t: string) => { if (t !== hintText) $("hint").textContent = hintText = t; };
const DEFAULT_HINT = "Space play/stop · L pattern/song · F5 playlist · F6 rack · F7 piano roll · F9 mixer · F10 tracer";

let queued = false;
export function paint() {
  if (queued) return; queued = true;
  requestAnimationFrame(() => {
    queued = false;
    if (!S.project) return;
    toolbarCtl(); toolbarStatus(); feed(); playlist(); rack(); piano(); mixer(); tracer();
    if (S.run.running) animate();
  });
}
let anim = 0;
function animate() { cancelAnimationFrame(anim); const f = () => { drawPiano(); if (S.run.running) anim = requestAnimationFrame(f); }; anim = requestAnimationFrame(f); }

// ---- wiring ----
document.addEventListener("click", (ev) => {
  const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!t) return;
  const a = t.dataset.act;
  if (a === "play") play();
  else if (a === "mode") { S.mode = t.dataset.v; paint(); }
  else if (a === "errors") { $("errors").hidden = !$("errors").hidden; paint(); }
});
document.addEventListener("change", (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.dataset.act === "pattern") { S.pattern = t.value; paint(); }
  if (t.dataset.act === "cache") S.cache = t.checked;
});
const hintOf = (ev: Event) => setHint((ev.target as HTMLElement).closest?.<HTMLElement>("[data-hint]")?.dataset.hint ?? DEFAULT_HINT);
document.addEventListener("mouseover", hintOf);
document.addEventListener("focusin", hintOf);
const KEYS: Record<string, string> = { F5: "playlist", F6: "rack", F7: "piano", F9: "mixer", F10: "tracer" };
document.addEventListener("keydown", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.closest("input, select, textarea, [contenteditable]") || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (KEYS[ev.key]) { ev.preventDefault(); $(KEYS[ev.key]).focus(); }
  else if (ev.key === " " && !t.closest("button")) { ev.preventDefault(); play(); }
  else if (ev.key === "l" || ev.key === "L") { S.mode = S.mode === "pat" ? "song" : "pat"; paint(); }
  else if (ev.key === "Escape") $("errors").hidden = true, paint();
});
setInterval(() => { if (S.project) toolbarStatus(); }, 1000);

const boot = JSON.parse($("boot")?.textContent ?? "null") ?? await (await fetch("/api/state")).json();
setState(boot, false);
for (const e of boot.events ?? []) onEvent(e, false);
setHint(DEFAULT_HINT);
paint();
const es = new EventSource("/api/events");
es.addEventListener("state", (m) => { setState(JSON.parse(m.data), true); paint(); });
es.addEventListener("event", (m) => { onEvent(JSON.parse(m.data), true); paint(); });
