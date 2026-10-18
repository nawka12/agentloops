// Playlist, Channel Rack, Piano Roll, Mixer, Tracer and Monitor, with FL's mouse grammar:
// left-click draws or places, right-click deletes, drag moves, the right edge resizes, Shift+drag box-selects, the wheel turns knobs. One drag = one patch = one undo step.
import { wdiff } from "./diff.ts";
import { BAR, STEP, S, chColor, playing, chName, curPattern, fl, html, noteKey, paint, patLen, patch, pos, posStr, ptr, relTick, toggleWin, waitFor, waiting } from "./main.ts";

const loopTxt = (lp: any) => (lp ? `⟳${lp.until ? ` until ${lp.until}` : ""}${lp.max ? ` · max ${lp.max}` : ""}` : "");
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const on = (mv: (e: PointerEvent) => void, up: (e: PointerEvent) => void) => {
  const u = (e: PointerEvent) => { removeEventListener("pointermove", mv); removeEventListener("pointerup", u); up(e); };
  addEventListener("pointermove", mv); addEventListener("pointerup", u);
};
const timers: Record<string, any> = {};
/** run `fn` once the gesture (wheel ticks) settles: one edit per gesture */
const later = (k: string, fn: () => void, ms = 450) => { clearTimeout(timers[k]); timers[k] = setTimeout(fn, ms); };
const recentHit = (v: any) => v.startAt && Date.now() - v.startAt < 1500;
/** voices of the current run, by channel, keyed to their pattern-relative tick */
function liveVoices(patId: string) {
  const out: any[] = [];
  for (const v of S.run.voices.values()) { if (v.tick == null) continue; const { pat, rel } = relTick(S.run, v.tick); if (pat === patId) out.push({ ...v, rel }); }
  return out;
}
/** the latest output line of a note: live from this session's runs, else from the latest take */
const preview = (patId: string, ch: string, key: number, rel: number) =>
  S.preview.get(noteKey(patId, ch, key, rel)) ?? (S.latest?.voices ?? []).findLast((v: any) => v.channel === ch && v.key === key && v.status === "done")?.text;

// ---- Playlist: the background window. Clips, loop markers, output previews, playhead ----
const PL = { label: 112, bar: 132, track: 52 }, PPT_PL = PL.bar / 384; // 384 = BAR (a literal: main.ts is still initializing when this module runs)
export const clipsOf = () => {
  const a = S.project?.arrangements?.[0], pats: any[] = S.project?.patterns ?? [];
  return (a?.clips ?? []).map((c: any, j: number) => { const p = pats.find((x) => x.id === c.ref); return { ...c, j, p, s: pos(c.start ?? 0), l: c.len ?? patLen(p), track: c.track ?? 0 }; });
};
let pl: any = null; // clip drag in progress
function plDown(ev: PointerEvent) {
  const grid = (ev.currentTarget as HTMLElement), r = grid.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
  const el = (ev.target as HTMLElement).closest<HTMLElement>(".clip"), clips = clipsOf(), ai = 0, a = S.project.arrangements?.[0];
  const tick = Math.max(0, Math.round(x / PPT_PL / 96 - 0.5) * 96), track = Math.floor(y / PL.track);
  if (!el) {
    if (ev.button !== 0) return;
    const pat = curPattern();
    if (!pat) return;
    const clip = { type: "pattern", ref: pat.id, track, start: posStr(tick) };
    return patch(a ? [{ op: "add", path: `/arrangements/${ai}/clips${a.clips ? "/-" : ""}`, value: a.clips ? clip : [clip] }]
      : [{ op: "add", path: "/arrangements", value: [{ id: "main", name: "Main", tracks: [{ name: "Track 1" }], clips: [clip] }] }], `placed ${pat.id} at ${clip.start}, track ${track + 1}`);
  }
  const c = clips[+el.dataset.j!];
  if (ev.button === 2) return patch([{ op: "remove", path: `/arrangements/${ai}/clips/${c.j}` }], `deleted clip ${c.ref} at ${posStr(c.s)}`);
  if (ev.button !== 0) return;
  ev.preventDefault();
  const edge = ev.clientX > el.getBoundingClientRect().right - 8;
  pl = { j: c.j, mode: edge ? "size" : "move", x0: ev.clientX, y0: ev.clientY, dt: 0, dk: 0 };
  on((e) => {
    pl.dt = Math.round((e.clientX - pl.x0) / PPT_PL / (edge ? STEP : 96)) * (edge ? STEP : 96);
    pl.dk = edge ? 0 : Math.round((e.clientY - pl.y0) / PL.track); paint();
  }, () => {
    const d = pl; pl = null; paint();
    if (!d.dt && !d.dk) return;
    const base = `/arrangements/${ai}/clips/${c.j}`;
    if (d.mode === "size") return patch([{ op: "add", path: `${base}/len`, value: Math.max(STEP, c.l + d.dt) }], `resized clip ${c.ref} to ${Math.max(STEP, c.l + d.dt) / STEP} steps`);
    const s = Math.max(0, c.s + d.dt), t = Math.max(0, c.track + d.dk);
    patch([{ op: "add", path: `${base}/start`, value: posStr(s) }, { op: "add", path: `${base}/track`, value: t }], `moved clip ${c.ref} to ${posStr(s)}, track ${t + 1}`);
  });
}
export function Playlist() {
  const a = S.project.arrangements?.[0], clips = clipsOf(), r = S.run, songRun = r.id && !r.pattern;
  const nBars = Math.max(8, ...clips.map((c: any) => Math.ceil((c.s + c.l) / BAR) + 2)), nTracks = Math.max(14, (a?.tracks?.length ?? 0), ...clips.map((c: any) => c.track + 2));
  const tracks = Array.from({ length: nTracks }, (_, i) => a?.tracks?.[i]?.name ?? `Track ${i + 1}`);
  const lines = (c: any) => { // the agent waveform: the clip's latest output lines
    const ks = [...S.preview.entries()].filter(([k]) => k.startsWith(`${c.ref}|`)).map(([k, t]) => ({ ch: k.split("|")[1], t }));
    const chs = new Set([...Object.keys(c.p?.notes ?? {}), ...Object.keys(c.p?.steps ?? {})]);
    const take = (S.latest?.voices ?? []).filter((v: any) => v.status === "done" && v.text && chs.has(v.channel)).map((v: any) => ({ ch: v.channel, t: String(v.text) }));
    return (ks.length ? ks : take).slice(-3);
  };
  return html`<section id="playlist" class=${`playlist${S.panel === "playlist" ? " front" : ""}`} tabindex="-1" aria-label="Playlist, F5" onPointerDown=${() => { S.panel = "playlist"; }}>
    <header class="pl-head"><b>Playlist</b><span class="sub">${a?.name ?? a?.id ?? "no arrangement yet"} · paint with <i>${curPattern()?.name ?? "—"}</i></span><kbd>F5</kbd></header>
    <div class="pl-scroll">
      <div class="pl-labels">${tracks.map((t) => html`<div class="tlabel" style=${`height:${PL.track}px`}>${t}</div>`)}</div>
      <div class="pl-main" style=${`width:${nBars * PL.bar}px`}>
        <div class="ruler" style=${`--bw:${PL.bar}px`}>${Array.from({ length: nBars }, (_, i) => html`<span>${i + 1}</span>`)}</div>
        <div class=${`pl-grid nocm${fl("arr")}`} style=${`--bw:${PL.bar}px;--th:${PL.track}px;height:${nTracks * PL.track}px`} onPointerDown=${plDown}
          data-hint="Click an empty spot to place the selected pattern. Drag a clip to move it, its right edge to resize, right-click to delete.">
          ${clips.map((c: any) => {
            const d = pl?.j === c.j ? pl : null, s = d?.mode === "move" ? Math.max(0, c.s + d.dt) : c.s, l = d?.mode === "size" ? Math.max(STEP, c.l + d.dt) : c.l, t = Math.max(0, c.track + (d?.dk ?? 0));
            const lp = c.loop ?? c.p?.loop, live = r.running && songRun && relTick(r, r.tick).pat === c.ref;
            return html`<div class=${`clip${live ? " live" : ""}${d ? " drag" : ""}${fl(`pat:${c.ref}`)}`} data-j=${c.j} style=${`left:${s * PPT_PL}px;width:${l * PPT_PL}px;top:${t * PL.track + 2}px;height:${PL.track - 4}px`}
                data-hint=${`Clip ${c.p?.name ?? c.ref} at ${posStr(c.s)}, ${c.l / STEP} steps${lp ? `, loops ${loopTxt(lp)}` : ""}. Drag to move, right edge to resize, right-click to delete.`}>
              <header>${c.p?.name ?? c.ref}<span class="loop">${loopTxt(lp)}</span></header>
              <div class="wave">${lines(c).map((x: any) => html`<span style=${`--c:${chColor(x.ch)}`}>${x.t}</span>`)}</div></div>`;
          })}
          ${songRun ? html`<div class="ph song" aria-hidden="true"><span class="ph-tag"></span></div>` : null}
        </div>
      </div>
    </div></section>`;
}

// ---- Channel Rack: mute LED, effort knob, name, steps grouped by beat, mixer target ----
const EFFORT = ["low", "medium", "high", "xhigh", "max"];
let sp: any = null; // step paint in progress: {ch, val, arr}
const knob: Record<string, string> = {}, target: Record<string, string> = {};
export const selChannel = () => {
  const pat = curPattern(), chs: any[] = S.project?.channels ?? [];
  if (chs.some((c) => c.id === S.channel)) return S.channel;
  return chs.find((c) => pat?.notes?.[c.id] || pat?.steps?.[c.id])?.id ?? chs[0]?.id;
};
const stepsOf = (pat: any, ch: string) => Array.from({ length: pat.lengthSteps ?? 16 }, (_, j) => (pat.steps?.[ch]?.[j] ? 1 : 0));
function commitSteps(pat: any, ch: string, arr: number[], summary: string) {
  const pi = S.project.patterns.indexOf(pat);
  patch(pat.steps ? [{ op: "add", path: `/patterns/${pi}/steps/${ptr(ch)}`, value: arr }] : [{ op: "add", path: `/patterns/${pi}/steps`, value: { [ch]: arr } }], summary);
}
function stepDown(ev: PointerEvent, pat: any, ch: string, i: number) {
  if (ev.button !== 0 && ev.button !== 2) return;
  ev.preventDefault();
  const orig = stepsOf(pat, ch);
  sp = { ch, val: ev.button === 0 ? 1 : 0, arr: [...orig] }; sp.arr[i] = sp.val; paint();
  on(() => {}, () => {
    const d = sp; sp = null; paint();
    const n = d.arr.filter((v: number, j: number) => v !== orig[j]).length;
    if (n) commitSteps(pat, ch, d.arr, `${d.val ? "set" : "cleared"} ${n} step${n > 1 ? "s" : ""} of ${ch} in ${pat.id}`);
  });
}
function toggleFlag(ci: number, c: any, k: "mute" | "solo", exclusive = false) {
  const ops: any[] = [{ op: "add", path: `/channels/${ci}/${k}`, value: !c[k] }];
  if (exclusive && !c[k]) (S.project.channels as any[]).forEach((o, j) => j !== ci && o.solo && ops.push({ op: "add", path: `/channels/${j}/solo`, value: false }));
  patch(ops, `${c[k] ? "un" : ""}${k}d ${c.id}`);
}
export function Rack() {
  const pat = curPattern(), chs: any[] = S.project.channels ?? [];
  if (!pat) return html`<p class="empty-note">No patterns yet. Ask your harness for one (pattern_upsert).</p>`;
  const n = pat.lengthSteps ?? 16, sel = selChannel(), solo = chs.some((c) => c.solo), voices = liveVoices(pat.id);
  const buses = [...(S.project.mixer?.buses ?? []).map((b: any) => b.id), "master"];
  const groups = (cells: any[]) => Array.from({ length: Math.ceil(n / 4) }, (_, g) => html`<span class=${`beat${g % 2 ? " odd" : ""}`}>${cells.slice(g * 4, g * 4 + 4)}</span>`);
  const rows = chs.map((c, ci) => {
    const steps = sp?.ch === c.id ? sp.arr : stepsOf(pat, c.id), starts = new Set((pat.notes?.[c.id] ?? []).map((x: any) => Math.floor((pos(x.start) % (n * STEP)) / STEP)));
    const hits = new Map<number, any>(); for (const v of voices) if (v.channel === c.id) hits.set(Math.floor(v.rel / STEP), v);
    const audible = !c.mute && (!solo || c.solo), isLlm = c.generator?.plugin === "llm.agent", eff = knob[c.id] ?? c.generator?.params?.effort, out = target[c.id] ?? c.output ?? "master";
    const ei = EFFORT.indexOf(eff), bi = buses.indexOf(out);
    const cells = steps.map((on: number, i: number) => {
      const v = hits.get(i);
      return html`<button class=${`step${on ? " on" : ""}${starts.has(i) ? " starts" : ""}${v && (v.status === "running" || v.status === "waiting") ? " live" : ""}`} aria-pressed=${!!on} aria-label=${`${c.name ?? c.id} step ${i + 1}`}
        onPointerDown=${(e: PointerEvent) => stepDown(e, pat, c.id, i)} onPointerEnter=${() => { if (sp?.ch === c.id && sp.arr[i] !== sp.val) { sp.arr[i] = sp.val; paint(); } }}
        onKeyDown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); const a = stepsOf(pat, c.id); a[i] = a[i] ? 0 : 1; commitSteps(pat, c.id, a, `${a[i] ? "set" : "cleared"} step ${i + 1} of ${c.id}`); } }}
        data-hint=${`${c.name ?? c.id} · step ${i + 1}${starts.has(i) ? " · a piano-roll note starts here" : ""}. Left-click or drag to set steps, right-click to clear (key 60).`}>${v && recentHit(v) ? html`<i class="hit" data-t=${v.startAt}></i>` : null}</button>`;
    });
    return html`<div class=${`ch-row${fl(`ch:${c.id}`)}${audible ? "" : " quiet"}`} style=${`--c:${c.color ?? "#9aa5ae"}`}>
      <button class=${`led${audible ? " lit" : ""}${c.solo ? " solo" : ""}`} aria-pressed=${!c.mute} aria-label=${`${c.name ?? c.id}: ${c.mute ? "muted" : "on"}${c.solo ? ", solo" : ""}`}
        onClick=${(e: MouseEvent) => toggleFlag(ci, c, e.ctrlKey || e.metaKey ? "solo" : "mute", true)}
        data-hint=${`${c.mute ? "Muted" : "On"}${c.solo ? " · solo" : ""}. Click to ${c.mute ? "unmute" : "mute"}, Ctrl+click to ${c.solo ? "unsolo" : "solo"} (only soloed channels play).`}></button>
      ${isLlm ? html`<span class="knob" tabindex="0" role="slider" aria-label=${`${c.name ?? c.id} effort`} aria-valuetext=${eff ?? "default"} style=${`--a:${ei < 0 ? 0 : -135 + ei * 67.5}deg`}
          onWheel=${(e: WheelEvent) => { e.preventDefault(); const v = EFFORT[clamp((ei < 0 ? 1 : ei) + (e.deltaY < 0 ? 1 : -1), 0, EFFORT.length - 1)]; knob[c.id] = v; paint();
            later(`k:${c.id}`, () => { delete knob[c.id]; patch([{ op: "add", path: `/channels/${ci}/generator/params${c.generator.params ? "/effort" : ""}`, value: c.generator.params ? v : { effort: v } }], `effort ${v} on ${c.id}`); }); }}
          data-hint=${`Effort: ${eff ?? "default"}. Scroll to change (low … max).`}><i></i></span>` : html`<span class="knob none" aria-hidden="true"></span>`}
      <button class="name" aria-current=${c.id === sel} onClick=${() => { S.channel = c.id; toggleWin("piano", true); }}
        data-hint=${`${c.name ?? c.id}: ${c.generator?.plugin} · context ${c.context ?? "fresh"} · listens to ${(c.inputs ?? []).map((i: any) => i.bus).join(", ") || "nothing"}. Click to open it in the piano roll.`}>${c.name ?? c.id}</button>
      <div class="steps nocm">${groups(cells)}</div>
      <span class="target" tabindex="0" role="spinbutton" aria-label=${`${c.name ?? c.id} output bus`} aria-valuetext=${out}
        onWheel=${(e: WheelEvent) => { e.preventDefault(); const v = buses[clamp(bi + (e.deltaY < 0 ? -1 : 1), 0, buses.length - 1)]; target[c.id] = v; paint();
          later(`t:${c.id}`, () => { delete target[c.id]; if (v !== (c.output ?? "master")) patch([{ op: "add", path: `/channels/${ci}/output`, value: v }], `routed ${c.id} to ${v}`); }); }}
        data-hint=${`Output: mixer bus ${out}. Scroll to route it to another bus.`}>${out === "master" ? "M" : bi + 1}</span></div>`;
  });
  return html`<div class=${`rack${fl(`pat:${pat.id}`)}`}>
    <div class="ch-row leds-row" aria-hidden="true"><span></span><span><span class="ph-tag"></span></span><span class="loop">${loopTxt(pat.loop)}</span><div class="steps leds">${groups(Array.from({ length: n }, () => html`<i></i>`))}</div><span></span></div>
    ${rows}</div>`;
}

// ---- Piano Roll: instruction rows, notes with output previews; draw, move, resize, delete, box-select, properties ----
const PR = { col: 30, row: 34, label: 118 };
let pr: any = null, selNotes = new Set<number>(), lastLen = 96, pop: any = null;
function pianoNotes(pat: any, ch: any) {
  if (!pat || !ch) return [];
  const len = patLen(pat);
  const ns = (pat.notes?.[ch.id] ?? []).map((n: any, j: number) => ({ n, j, s: pos(n.start) % len, len: n.len ?? STEP, key: n.key ?? 60 }));
  (pat.steps?.[ch.id] ?? []).forEach((v: number, i: number) => v && ns.push({ n: { key: 60 }, j: -1, step: i, s: i * STEP, len: STEP, key: 60 }));
  return ns.map((x: any) => ({ ...x, instr: (ch.keymap ?? []).find((k: any) => k.key === x.key) }));
}
const notesPath = (pat: any, ch: string) => `/patterns/${S.project.patterns.indexOf(pat)}/notes/${ptr(ch)}`;
function prDown(ev: PointerEvent, pat: any, ch: any, rows: any[], notes: any[]) {
  const grid = ev.currentTarget as HTMLElement, rc = grid.getBoundingClientRect(), x = ev.clientX - rc.left, y = ev.clientY - rc.top;
  const step = Math.floor(x / PR.col), row = Math.floor(y / PR.row), el = (ev.target as HTMLElement).closest<HTMLElement>(".note"), n = pat.lengthSteps ?? 16;
  const note = el ? notes[+el.dataset.i!] : null, base = notesPath(pat, ch.id);
  pop = null;
  if (ev.button === 2) {
    if (!note) return;
    if (note.j < 0) { const a = stepsOf(pat, ch.id); a[note.step] = 0; return commitSteps(pat, ch.id, a, `cleared step ${note.step + 1} of ${ch.id}`); }
    selNotes.delete(note.j);
    return patch([{ op: "remove", path: `${base}/${note.j}` }], `deleted ${note.instr?.name ?? "note"} at ${posStr(note.s)} of ${ch.id}`);
  }
  if (ev.button !== 0) return;
  ev.preventDefault();
  if (ev.shiftKey || (!note && ev.altKey)) { // box select
    pr = { mode: "box", x0: x, y0: y, x1: x, y1: y };
    return on((e) => { pr.x1 = e.clientX - rc.left; pr.y1 = e.clientY - rc.top; paint(); }, () => {
      const [l, r, t, b] = [Math.min(pr.x0, pr.x1), Math.max(pr.x0, pr.x1), Math.min(pr.y0, pr.y1), Math.max(pr.y0, pr.y1)];
      selNotes = new Set(notes.filter((nt) => nt.j >= 0 && nt.s / STEP * PR.col < r && (nt.s + nt.len) / STEP * PR.col > l && rows.findIndex((k) => k.key === nt.key) * PR.row < b && (rows.findIndex((k) => k.key === nt.key) + 1) * PR.row > t).map((nt) => nt.j));
      pr = null; paint();
    });
  }
  if (!note) {
    if (!rows[row] || step >= n) return;
    selNotes.clear();
    const nn = { start: posStr(step * STEP), len: Math.min(lastLen, (n - step) * STEP), key: rows[row].key };
    return patch(!pat.notes ? [{ op: "add", path: `/patterns/${S.project.patterns.indexOf(pat)}/notes`, value: { [ch.id]: [nn] } }] : !pat.notes[ch.id] ? [{ op: "add", path: base, value: [nn] }] : [{ op: "add", path: `${base}/-`, value: nn }],
      `drew ${rows[row].name ?? "note"} at ${nn.start} of ${ch.id}`);
  }
  if (note.j < 0) return; // a step note: edit it in the rack
  if (!selNotes.has(note.j)) selNotes = new Set([note.j]);
  const edge = ev.clientX > el!.getBoundingClientRect().right - 7;
  pr = { mode: edge ? "size" : "move", x0: ev.clientX, y0: ev.clientY, ds: 0, dr: 0 };
  paint();
  on((e) => { pr.ds = Math.round((e.clientX - pr.x0) / PR.col); pr.dr = edge ? 0 : Math.round((e.clientY - pr.y0) / PR.row); paint(); }, () => {
    const d = pr; pr = null; paint();
    if (!d.ds && !d.dr) return;
    const ops: any[] = [], len = patLen(pat);
    for (const nt of notes) {
      if (nt.j < 0 || !selNotes.has(nt.j)) continue;
      if (d.mode === "size") { const l = Math.max(STEP, nt.len + d.ds * STEP); ops.push({ op: "add", path: `${base}/${nt.j}/len`, value: l }); lastLen = l; continue; }
      const s = clamp(nt.s + d.ds * STEP, 0, len - STEP), r = clamp(rows.findIndex((k) => k.key === nt.key) + d.dr, 0, rows.length - 1);
      ops.push({ op: "add", path: `${base}/${nt.j}/start`, value: posStr(s) });
      if (rows[r].key !== nt.key) ops.push({ op: "add", path: `${base}/${nt.j}/key`, value: rows[r].key });
    }
    patch(ops, `${d.mode === "size" ? "resized" : "moved"} ${selNotes.size} note${selNotes.size > 1 ? "s" : ""} of ${ch.id}`);
  });
}
function savePop(pat: any, ch: any, form: HTMLFormElement) {
  const nt = pat.notes?.[ch.id]?.[pop.j], base = `${notesPath(pat, ch.id)}/${pop.j}`, f = new FormData(form), ops: any[] = [];
  for (const k of ["text", "when", "pass"]) {
    const v = String(f.get(k) ?? "").trim();
    if (v && v !== nt[k]) ops.push({ op: "add", path: `${base}/${k}`, value: v });
    else if (!v && nt[k] != null) ops.push({ op: "remove", path: `${base}/${k}` });
  }
  if (!!f.get("slide") !== !!nt.slide) ops.push({ op: "add", path: `${base}/slide`, value: !!f.get("slide") });
  pop = null; paint();
  patch(ops, `edited note ${posStr(pos(nt.start))} of ${ch.id}`);
}
document.addEventListener("keydown", (ev) => {
  if ((ev.key !== "Delete" && ev.key !== "Backspace") || !selNotes.size || (ev.target as HTMLElement).closest("input, textarea, select")) return;
  const pat = curPattern(), ch = selChannel(), base = notesPath(pat, ch);
  patch([...selNotes].sort((a, b) => b - a).map((j) => ({ op: "remove", path: `${base}/${j}` })), `deleted ${selNotes.size} notes of ${ch}`);
  selNotes.clear();
});
export function Piano() {
  const pat = curPattern(), ch = (S.project.channels ?? []).find((c: any) => c.id === selChannel());
  if (!pat || !ch) return html`<p class="empty-note">Pick a channel in the rack.</p>`;
  const n = pat.lengthSteps ?? 16, rows = [...(ch.keymap ?? [])].sort((a: any, b: any) => b.key - a.key), notes = pianoNotes(pat, ch), color = ch.color ?? "#9aa5ae";
  const voices = liveVoices(pat.id).filter((v) => v.channel === ch.id), W = n * PR.col;
  const pn = pop && pat.notes?.[ch.id]?.[pop.j];
  return html`<div class=${`pr${fl(`ch:${ch.id}`)}`} style=${`--c:${color};--col:${PR.col}px;--row:${PR.row}px`}>
    <div class="pr-scroll">
      <div class="pr-keys">${rows.map((k: any) => html`<div class="pkey" data-hint=${`Instruction ${k.name}: ${k.template ?? "{{note.text}}"}`}><b>${k.name ?? `key ${k.key}`}</b><small>${k.key}</small></div>`)}</div>
      <div class="pr-main" style=${`width:${W}px`}>
        <div class="ruler" style=${`--bw:${PR.col * 4}px`}>${Array.from({ length: Math.ceil(n / 4) }, (_, i) => html`<span>${posStr(i * 4 * STEP)}</span>`)}</div>
        <div class="pr-grid nocm" style=${`height:${rows.length * PR.row}px`} onPointerDown=${(e: PointerEvent) => prDown(e, pat, ch, rows, notes)}
          onDblClick=${(e: MouseEvent) => { const el = (e.target as HTMLElement).closest<HTMLElement>(".note"), nt = el && notes[+el.dataset.i!]; if (nt && nt.j >= 0) { pop = { j: nt.j, x: nt.s / STEP * PR.col, y: (rows.findIndex((k: any) => k.key === nt.key) + 1) * PR.row }; paint(); } }}
          data-hint="Click to draw a note, drag a note to move it, its right edge to resize. Right-click deletes, Shift+drag selects, double-click edits the note.">
          ${notes.map((x: any, i: number) => {
            const r = rows.findIndex((k: any) => k.key === x.key);
            if (r < 0) return null;
            const d = pr && x.j >= 0 && selNotes.has(x.j) ? pr : null, ds = d?.mode === "move" ? d.ds : 0, dr = d?.mode === "move" ? d.dr : 0, dl = d?.mode === "size" ? d.ds : 0;
            const vs = voices.filter((v) => v.key === x.key && v.rel === x.s), lv = vs.at(-1), live = S.run.running && vs.some((v) => v.status === "running" || v.status === "waiting");
            const wt = S.run.running && vs.some((v) => v.status === "waiting"), failed = lv?.status === "failed", out = preview(pat.id, ch.id, x.key, x.s);
            const badges = [wt && "⏳ harness", x.n.when && `if ${x.n.when}`, x.n.pass && `pass ${x.n.pass}`, x.n.slide && "slide ↝", x.j < 0 && "step"].filter(Boolean);
            return html`<div class=${`note${x.j < 0 ? " stepnote" : ""}${live ? " lit" : ""}${failed ? " failed" : ""}${x.j >= 0 && selNotes.has(x.j) ? " sel" : ""}`} data-i=${i}
                style=${`left:${(x.s / STEP + ds) * PR.col + 1}px;top:${clamp(r + dr, 0, rows.length - 1) * PR.row + 2}px;width:${Math.max(8, (x.len / STEP + dl) * PR.col - 2)}px`}
                data-hint=${`${x.instr?.name ?? `key ${x.key}`} at ${posStr(x.s)}, ${x.len / STEP} steps${x.n.when ? ` · when ${x.n.when}` : ""}${x.n.pass ? ` · pass ${x.n.pass}` : ""}${x.n.slide ? " · slide: continues the previous voice's conversation" : ""}${out ? ` · last output: ${String(out).slice(0, 120)}` : ""}${x.j < 0 ? " · a step from the rack" : ". Drag to move, right edge to resize, double-click to edit, right-click to delete."}`}>
              <span class="l1"><b>${x.instr?.name ?? `key ${x.key}`}</b>${badges.map((b) => html`<span class="badge">${b}</span>`)}</span>
              <span class="out">${failed ? lv.error ?? "failed" : out ?? ""}</span><span class="tag">⏳ ${ch.name ?? ch.id}…</span>
              ${lv && recentHit(lv) ? html`<i class="hit" data-t=${lv.startAt}></i>` : null}</div>`;
          })}
          ${pr?.mode === "box" ? html`<div class="box" style=${`left:${Math.min(pr.x0, pr.x1)}px;top:${Math.min(pr.y0, pr.y1)}px;width:${Math.abs(pr.x1 - pr.x0)}px;height:${Math.abs(pr.y1 - pr.y0)}px`}></div>` : null}
          <div class="ph pat" aria-hidden="true"><span class="ph-tag"></span></div>
        </div>
      </div>
    </div>
    ${pn ? html`<form class="pop" style=${`left:${PR.label + pop.x}px;top:${pop.y + 22}px`} onSubmit=${(e: Event) => { e.preventDefault(); savePop(pat, ch, e.target as HTMLFormElement); }}
        onKeyDown=${(e: KeyboardEvent) => { if (e.key === "Escape") { pop = null; paint(); } }}>
      <label>Text<input name="text" value=${pn.text ?? ""} placeholder="note.text in the template" autofocus/></label>
      <label>When<input name="when" value=${pn.when ?? ""} placeholder="CEL, e.g. loop.index > 0"/></label>
      <label>Pass<input name="pass" value=${pn.pass ?? ""} placeholder="N:M, e.g. 1:2"/></label>
      <label class="chk"><input type="checkbox" name="slide" checked=${!!pn.slide}/>Slide: continue the previous voice's conversation</label>
      <footer><button type="button" onClick=${() => { pop = null; paint(); }}>Cancel</button><button type="submit" class="primary">Save note</button></footer></form>` : null}
    <ul class="sr">${notes.filter((x: any) => x.j >= 0).map((x: any) => html`<li><button onClick=${() => patch([{ op: "remove", path: `${notesPath(pat, ch.id)}/${x.j}` }], `deleted note ${x.j} of ${ch.id}`)}>Delete ${x.instr?.name} note at ${posStr(x.s)}</button></li>`)}</ul>
  </div>`;
}

// ---- Mixer: strips (Master last), live meters, slots, sends; click a strip to monitor it ----
export function Mixer() {
  const buses = [...(S.project.mixer?.buses ?? []), { id: "master", name: "Master", ...(S.project.mixer?.master ?? {}) }];
  const m = S.run.buses, max = Math.max(4, ...Object.values<any>(m).map((b) => b.frames));
  const MODE: Record<string, string> = { final: "F", all: "A", sidechain: "SC" };
  return html`<div class="strips">${buses.map((b: any, i: number) => {
    const mt = m[b.id] ?? { frames: 0, cost: 0, errors: 0 }, sends = b.id === "master" ? [] : b.sends ?? [{ to: "master", mode: "all" }];
    const slots = [...(b.slots ?? []), ...Array(Math.max(0, 4 - (b.slots?.length ?? 0))).fill(null)], lv = Math.round((mt.frames / max) * 100);
    return html`<button class=${`strip${b.id === "master" ? " master" : ""}${S.monitorBus === b.id ? " monitored" : ""}${fl(`bus:${b.id}`)}`} aria-pressed=${S.monitorBus === b.id}
        onClick=${() => { S.monitorBus = b.id; S.monTab = b.id === "master" ? "master" : "bus"; toggleWin("monitor", true); }} data-hint=${`Bus ${b.name ?? b.id}${b.join ? ` · join ${b.join}` : ""}. Click to hear it: the Monitor shows what this bus emits.`}>
      <h3><i>${b.id === "master" ? "M" : i + 1}</i>${b.name ?? b.id}</h3>
      <div class="meter" role="meter" aria-label=${`${b.id} frames this run`} aria-valuenow=${mt.frames} aria-valuemin="0" aria-valuemax=${max}>
        <i style=${`height:${lv}%`}></i><i style=${`height:${Math.round(lv * 0.86)}%`}></i>${mt.at ? html`<b class="hit pk" data-t=${mt.at}></b>` : null}</div>
      <div class="stat"><span>${mt.frames} fr</span><span>$${mt.cost.toFixed(3)}</span><span class=${mt.errors ? "err" : ""}>⚠${mt.errors}</span></div>
      ${slots.map((s: any, j: number) => s ? html`<div class="slot" data-hint=${`Slot ${j + 1}: ${s.plugin} ${JSON.stringify(s.params ?? {}).slice(0, 140)}`}>${j + 1} ${s.plugin.replace("fx.", "")}${s.plugin === "fx.gate" && s.params?.condition?.startsWith("side") ? " ◀SC" : ""}</div>` : html`<div class="slot empty">${j + 1} —</div>`)}
      ${sends.map((s: any) => html`<div class="send" data-hint=${`Send to ${s.to}, mode ${s.mode}`}>→ ${s.to} ${MODE[s.mode] ?? s.mode}</div>`)}
      ${b.id === "master" ? (b.targets ?? []).map((t: any) => html`<div class="send muted">⇥ ${t.type}</div>`) : null}</button>`;
  })}</div>`;
}

// ---- Tracer: voice Gantt by wall time + frame list ----
export function Tracer() {
  const tk = S.latest, wt = waiting();
  const bar = wt.length ? html`<div class="waitbar" role="status">${waitFor(wt[0])}: ${wt.map((v: any) => html`<b>${chName(v.channel)}</b> <span class="muted">(pass ${v.pass + 1}, voice ${v.voice})</span> `)}</div>` : null;
  if (!tk) return html`${bar}<p class="empty-note">No takes yet. Press Space to play, or let your harness call run_start.</p>`;
  const vs: any[] = tk.voices.filter((v: any) => v.startMs != null), end = Math.max(1, ...vs.map((v) => v.endMs ?? v.startMs));
  const frames = (tk.frames ?? []).filter((f: any) => S.voice == null || f.voice === S.voice), r = tk.run;
  return html`${bar}<div class="tr-head muted">take ${r.id} · ${r.status}${r.stopped ? `: ${r.stopped}` : ""} · ${r.passes} passes · ${vs.length} voices · $${r.costUsd.toFixed(4)} · ${end} ms</div>
    <div class="tr"><div class="gantt">${vs.map((v) => html`<button class=${`vrow${fl(`voice:${v.voice}`)}`} data-k=${`v:${v.voice}`} aria-pressed=${S.voice === v.voice} onClick=${() => { S.voice = S.voice === v.voice ? null : v.voice; paint(); }}
        data-hint=${`${chName(v.channel)} · pass ${v.pass + 1} · ${v.status} · ${(v.endMs ?? v.startMs) - v.startMs} ms · $${v.costUsd.toFixed(4)}${v.cached ? " · cached" : ""}. Click to filter frames.`}>
      <span>${chName(v.channel)} · pass ${v.pass + 1}${v.cached ? " ⧉" : ""}</span><span class="vtrack"><i class=${v.status} style=${`background:${chColor(v.channel)};left:${(v.startMs / end) * 100}%;width:${(((v.endMs ?? v.startMs) - v.startMs) / end) * 100}%`}></i></span></button>`)}</div>
    <div class="frames">${S.voice != null ? html`<p class="muted">Frames of one voice. Click it again to show all.</p>` : null}${frames.map((f: any) => html`<div class="frame"><header><span class=${`k ${f.kind}`}>${f.kind}</span><span class=${`trust ${f.trust}`}>${f.trust ?? "trusted"}</span><span>${chName(f.channel)} → ${f.bus} · pass ${f.pass + 1}${f.final ? " · final" : ""}</span></header>
      <p>${f.text ?? ""}${f.json !== undefined ? html`<span class="muted">${f.text ? "\n" : ""}${JSON.stringify(f.json)}</span>` : null}</p></div>`)}</div></div>`;
}

// ---- Monitor: the speaker. "Now playing" on Master (with what changed), every bus live for this pass, or one bus ----
let dismissed = (() => { try { return localStorage.getItem("agentloops.monitor.hint") === "0"; } catch { return false; } })();
let stick = true;
const fText = (f: any) => {
  const j = f.json !== undefined && f.json !== null ? JSON.stringify(f.json, null, 2) : null;
  return f.text && !(j && f.text === JSON.stringify(f.json)) ? f.text + (j ? `\n${j}` : "") : j ?? f.text ?? "";
};
/** finished runs grouped into distinct Master outputs: consecutive repeats with the same output are one version */
function versions() {
  const gs: any[] = [];
  for (const r of S.runs) {
    if (!r.ended || !r.master.length) continue;
    const text = r.master.map(fText).join("\n\n"), last = gs.at(-1);
    if (last?.text === text) last.runs.push(r); else gs.push({ text, runs: [r], ch: r.master.at(-1).channel });
  }
  return gs;
}
const span = (rs: any[]) => { const a = rs[0].repeat, b = rs.at(-1).repeat; return !a ? (rs.length > 1 ? `${rs.length} plays` : "song play") : a === b ? `repeat ${a}` : `repeats ${a}–${b}`; };
const Frame = (f: any, bus = false) => html`<article class=${`mf${f.kind === "error" ? " err" : ""}`} style=${`--c:${chColor(f.channel)}`}>
  <header><b>${chName(f.channel)}</b>${bus ? html`<span class="bus">→ ${f.bus}</span>` : null}<span>pass ${f.pass + 1}</span>${f.repeat ? html`<span>repeat ${f.repeat}</span>` : null}${f.kind !== "message" ? html`<span class="k">${f.kind}</span>` : null}${f.final ? null : html`<span class="k">partial</span>`}</header>
  ${fText(f) ? html`<p class=${f.json != null && !f.text ? "json" : ""}>${fText(f)}</p>` : null}</article>`;
function MasterView() {
  const gs = versions(), cur = S.runs.at(-1), arriving = cur && !cur.ended && cur.master.length ? cur : null, latest = gs.at(-1), prev = gs.at(-2);
  if (!latest && !arriving) return dismissed ? html`<p class="empty-note">${playing() ? "Playing. Nothing has reached Master yet." : "Nothing has reached Master yet."}</p>`
    : html`<div class="explain"><p>Press Space to play. Agents run when the playhead reaches their notes; what reaches Master appears here.</p>
      <button onClick=${() => { dismissed = true; try { localStorage.setItem("agentloops.monitor.hint", "0"); } catch {} paint(); }} aria-label="Dismiss">Got it</button></div>`;
  const dupes = latest ? latest.runs.slice(1) : [], cached = dupes.length && dupes.every((r: any) => r.cached); // the first run of a version made it; the rest replayed it
  return html`
    ${arriving ? html`<section class="np arriving" style=${`--c:${chColor(arriving.master.at(-1).channel)}`}><header><b>Arriving</b><span>${span([arriving])}, still playing</span></header>
      <p>${arriving.master.map(fText).join("\n\n")}</p></section>` : null}
    ${latest ? html`<section class="np" style=${`--c:${chColor(latest.ch)}`} data-hint=${prev ? "Master output of the latest repeat. Green words are new since the previous version, struck-through words were removed." : "Master output of the latest repeat"}>
      <header><b>Now playing</b><span>${span(latest.runs.slice(-1))}</span>${prev ? html`<span class="muted">changes since ${span(prev.runs.slice(-1))}</span>` : null}</header>
      <p>${prev ? wdiff(prev.text, latest.text).map((d) => d.op === "+" ? html`<ins>${d.t}</ins>` : d.op === "-" ? html`<del>${d.t}</del>` : d.t) : latest.text}</p>
      ${dupes.length ? html`<div class="same" data-hint="Later repeats produced exactly the same Master output (text and json)">♻ unchanged ×${latest.runs.length} <small>${span(latest.runs)}</small>${cached ? html`<span class="k">cached</span>` : null}</div>` : null}</section>` : null}
    ${gs.length > 1 ? html`<details class="hist"><summary data-hint="Earlier distinct Master outputs, newest first">History · ${gs.length} versions</summary>
      ${[...gs].reverse().map((g, i) => html`<details><summary>${i === 0 ? "now" : span(g.runs)} <span class="muted">${g.text.split("\n").find((l: string) => l.trim()) ?? ""}</span></summary><p>${g.text}</p></details>`)}</details>` : null}`;
}
function LiveView() {
  const r = S.run, fs = S.monitor.filter((f: any) => f.runId === r.id && f.pass === r.pass), latest = versions().at(-1);
  return html`${latest ? html`<div class="pin" style=${`--c:${chColor(latest.ch)}`} data-hint="The latest Master output, pinned"><b>Master</b> ${latest.text}</div>` : null}
    ${r.id ? html`<div class="divider">pass ${r.pass + 1}${r.repeat ? ` · repeat ${r.repeat}` : ""}${r.running ? "" : " · ended"}</div>` : null}
    ${fs.length ? fs.map((f: any) => Frame(f, true)) : html`<p class="empty-note">${r.running ? "Waiting for the first frame of this pass." : "Play to see every bus's frames as they arrive."}</p>`}`;
}
export function Monitor() {
  const tab = S.monTab, bus = S.monitorBus, set = (t: string) => { S.monTab = t; paint(); };
  return html`<div class="mon">
    <div class="mon-bar" role="tablist">
      <button role="tab" aria-selected=${tab === "master"} onClick=${() => set("master")} data-hint="Master: what the song outputs now, what changed, and earlier versions">Master</button>
      <button role="tab" aria-selected=${tab === "live"} onClick=${() => set("live")} data-hint="Live: every bus's frames for the current pass, as they arrive">Live</button>
      ${bus !== "master" ? html`<button role="tab" aria-selected=${tab === "bus"} onClick=${() => set("bus")} data-hint=${`Bus ${bus}: what it emits (click a mixer strip to switch)`}>bus ${bus}</button>` : null}
      <span class="sp"></span></div>
    <div class="mon-feed" ref=${(el: HTMLElement | null) => { if (el && stick && tab !== "master") el.scrollTop = el.scrollHeight; }} onScroll=${(e: Event) => { const el = e.target as HTMLElement; stick = el.scrollHeight - el.scrollTop - el.clientHeight < 30; }}
      aria-live="polite">
      ${tab === "live" ? LiveView() : tab === "bus" ? (S.monitor.some((f: any) => f.bus === bus) ? S.monitor.filter((f: any) => f.bus === bus).slice(-60).map((f: any) => Frame(f)) : html`<p class="empty-note">Nothing has reached ${bus} yet.</p>`) : MasterView()}
    </div></div>`;
}
