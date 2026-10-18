// Playlist, Channel Rack, Piano Roll, Mixer and Tracer.
import { $, chColor, curPattern, esc, fl, patch, ptr, S, set, setHint, waitFor, waiting } from "./main.ts";

const BAR = 384, STEP = 24;
/** tick count or "bar:step[:tick]" -> ticks (mirror of src/project.ts pos) */
const pos = (v: any): number => {
  if (Number.isInteger(v)) return v;
  const m = /^(\d+):(\d+)(?::(\d+))?$/.exec(String(v));
  return m ? (+m[1] - 1) * BAR + (+m[2] - 1) * STEP + +(m[3] ?? 0) : 0;
};
const posStr = (t: number) => `${Math.floor(t / BAR) + 1}:${String(Math.floor((t % BAR) / STEP) + 1).padStart(2, "0")}`;
const loopTxt = (lp: any) => (lp ? `⟳${lp.until ? ` until ${lp.until}` : ""}${lp.max ? `, max ${lp.max}` : ""}` : "");
const chName = (id: string) => (S.project.channels ?? []).find((c: any) => c.id === id)?.name ?? id;

// ---- Playlist: tracks, clips, loop markers, playhead, take lanes ----
export function playlist() {
  const a = S.project.arrangements?.[0], pats: any[] = S.project.patterns ?? [];
  if (!a) return set($("playlist"), `<h2>Playlist</h2><p class="empty-note">No arrangement yet. Place a pattern clip with arrangement_upsert.</p>`);
  const clips = (a.clips ?? []).map((c: any) => { const p = pats.find((x) => x.id === c.ref); return { ...c, p, s: pos(c.start ?? 0), l: c.len ?? (p?.lengthSteps ?? 16) * STEP }; });
  const nBars = Math.max(4, ...clips.map((c: any) => Math.ceil((c.s + c.l) / BAR) + 1)), total = nBars * BAR;
  const pct = (t: number) => `${(t / total) * 100}%`;
  const r = S.run, songRun = r.id && !r.pattern;
  const head = songRun && r.pos ? `<div class="playhead" style="left:calc(90px + (100% - 90px) * ${pos(r.pos) / total})" aria-hidden="true"></div>` : "";
  const tracks: any[] = a.tracks?.length ? a.tracks : [{ name: "Main" }];
  const lane = (inner: string, cls = "") => `<div class="lane ${cls}" style="--bw:calc(100% / ${nBars})">${inner}</div>`;
  const rows = tracks.map((t: any, i: number) => `<div class="track"><b>${esc(t.name)}</b>${lane(clips.filter((c: any) => (c.track ?? 0) === i).map((c: any) => {
    const lp = c.loop ?? c.p?.loop;
    return `<div class="clip${r.running && songRun ? " running" : ""}${fl(`pat:${c.ref}`)}${fl("arr")}" style="left:${pct(c.s)};width:${pct(c.l)}" data-hint="Clip ${esc(c.p?.name ?? c.ref)} at ${posStr(c.s)}, ${c.l / STEP} steps${lp ? `. Loops ${esc(loopTxt(lp))}` : ""}">${esc(c.p?.name ?? c.ref)}<span class="loop">${esc(loopTxt(lp))}</span></div>`;
  }).join(""))}</div>`).join("");
  // take lanes: one per pass of the latest take, a chip per voice
  const tk = S.latest, first = clips.find((c: any) => c.loop ?? c.p?.loop) ?? clips[0];
  const passes = new Map<number, any[]>();
  for (const v of tk?.voices ?? []) (passes.get(v.pass) ?? passes.set(v.pass, []).get(v.pass)!).push(v);
  const takeRows = [...passes].map(([p, vs]) => `<div class="track"><b class="muted">Pass ${p + 1}</b>${lane(`<div class="chips" style="left:${pct(first?.s ?? 0)}">${vs.map((v) =>
    `<span class="chip ${v.status}" style="background:${esc(chColor(v.channel))}" data-hint="${esc(chName(v.channel))} · pass ${p + 1} · ${esc(v.status)}${v.cached ? " · cached" : ""} · $${v.costUsd.toFixed(4)}: ${esc(String(v.text ?? "").slice(0, 120))}">${esc(chName(v.channel).slice(0, 8))}${v.cached ? " ⧉" : ""}</span>`).join("")}</div>`, "small")}</div>`).join("");
  set($("playlist"), `<h2>Playlist <span class="muted">${esc(a.name ?? a.id)}${tk ? ` · take ${esc(tk.run.id)}, ${tk.run.passes} passes` : ""}</span><kbd>F5</kbd></h2>
    <div class="body"><div class="pl"><div class="ruler"><span></span><div class="bars">${Array.from({ length: nBars }, (_, i) => `<span>${i + 1}</span>`).join("")}</div></div>
    ${rows}${takeRows || `<div class="track"><b class="muted">Takes</b>${lane(`<span class="muted" style="padding:3px 6px;display:block">No takes yet. Press Space to play.</span>`, "small")}</div>`}${head}</div></div>`);
}

// ---- Channel Rack: step rows for the current pattern ----
export function rack() {
  const pat = curPattern(), chs: any[] = S.project.channels ?? [];
  if (!pat) return set($("rack"), `<h2>Channel rack</h2><p class="empty-note">No patterns yet.</p>`);
  const n = pat.lengthSteps ?? 16, sel = selChannel();
  const rows = chs.map((c) => {
    const steps: number[] = pat.steps?.[c.id] ?? [], starts = new Set((pat.notes?.[c.id] ?? []).map((x: any) => Math.floor((pos(x.start) % (n * STEP)) / STEP)));
    const cells = Array.from({ length: n }, (_, i) => `<button class="step${starts.has(i) ? " note" : ""}" data-act="step" data-ch="${esc(c.id)}" data-i="${i}" data-k="s:${esc(c.id)}:${i}" aria-pressed="${!!steps[i]}" aria-label="${esc(c.name ?? c.id)} step ${i + 1}" data-hint="${esc(c.name ?? c.id)} · step ${i + 1}${starts.has(i) ? " · a piano-roll note starts here" : ""} · click to toggle a step note (key 60)"></button>`).join("");
    return `<div class="row${fl(`ch:${c.id}`)}" style="--c:${esc(c.color ?? "#9aa5ae")}">
      <span class="swatch" style="background:${esc(c.color ?? "#9aa5ae")}"></span>
      <button class="name" data-act="channel" data-ch="${esc(c.id)}" data-k="n:${esc(c.id)}" aria-current="${c.id === sel}" data-hint="${esc(c.name ?? c.id)}: ${esc(c.generator?.plugin)} · context ${esc(c.context ?? "fresh")} · inputs ${esc((c.inputs ?? []).map((i: any) => i.bus).join(", ") || "none")}. Click to open in the piano roll">${esc(c.name ?? c.id)}</button>
      <div class="steps" style="--n:${n}">${cells}</div>
      <span class="out" data-hint="Output bus">→ ${esc(c.output ?? "master")}<span class="badge">${esc(c.generator?.plugin)}</span></span></div>`;
  }).join("");
  set($("rack"), `<h2>Channel rack <span class="muted">${esc(pat.name ?? pat.id)} · ${n} steps${pat.loop ? ` · ${esc(loopTxt(pat.loop))}` : ""}</span><kbd>F6</kbd></h2><div class="body${fl(`pat:${pat.id}`)}">${rows}</div>`);
}
const selChannel = () => {
  const pat = curPattern(), chs: any[] = S.project.channels ?? [];
  if (chs.some((c) => c.id === S.channel)) return S.channel;
  return chs.find((c) => pat?.notes?.[c.id] || pat?.steps?.[c.id])?.id ?? chs[0]?.id;
};
function toggleStep(ch: string, i: number) {
  const pat = curPattern(), pi = S.project.patterns.indexOf(pat), n = pat.lengthSteps ?? 16;
  const arr = Array.from({ length: n }, (_, j) => (pat.steps?.[ch]?.[j] ? 1 : 0));
  arr[i] = arr[i] ? 0 : 1;
  const summary = `${arr[i] ? "set" : "cleared"} step ${i + 1} of ${ch} in ${pat.id}`;
  patch(pat.steps ? [{ op: "add", path: `/patterns/${pi}/steps/${ptr(ch)}`, value: arr }] : [{ op: "add", path: `/patterns/${pi}/steps`, value: { [ch]: arr } }], summary);
}

// ---- Piano Roll: canvas, instruction rows, notes with badges ----
const PR = { label: 120, row: 30, head: 18 };
let geo: any = null;
export function piano() {
  const pat = curPattern(), ch = (S.project.channels ?? []).find((c: any) => c.id === selChannel());
  const el = $("piano");
  if (!el.querySelector("canvas")) {
    el.innerHTML = `<h2></h2><div class="body"><canvas tabindex="0" role="img"></canvas><ul class="sr"></ul></div>`;
    const cv = el.querySelector("canvas")!;
    cv.addEventListener("click", (ev) => clickPiano(ev.offsetX, ev.offsetY));
    cv.addEventListener("mousemove", (ev) => { const h = hit(ev.offsetX, ev.offsetY); setHint(h?.note ? noteHint(h.note) : h ? `Click to add a one-step ${h.instr.name} note at ${posStr(h.step * STEP)}` : "Piano roll"); });
  }
  el.querySelector("h2")!.innerHTML = `Piano roll <span class="muted">${esc(ch?.name ?? "no channel")} · ${esc(pat?.name ?? "")}</span><kbd>F7</kbd>`;
  el.querySelector(".body")!.className = `body${ch ? fl(`ch:${ch.id}`) : ""}`;
  const notes = pianoNotes(pat, ch);
  set(el.querySelector("ul")!, notes.map((x) => `<li><button data-act="delnote" data-j="${x.j}" ${x.j < 0 ? "disabled" : ""}>Delete ${esc(x.instr?.name)} note at ${posStr(x.s)}</button></li>`).join(""));
  el.querySelector("canvas")!.setAttribute("aria-label", `Piano roll for ${ch?.name ?? "no channel"}: ${notes.length} notes. Click an empty cell to add a note, a note to delete it.`);
  drawPiano();
}
function pianoNotes(pat: any, ch: any) {
  if (!pat || !ch) return [];
  const len = (pat.lengthSteps ?? 16) * STEP;
  const ns = (pat.notes?.[ch.id] ?? []).map((n: any, j: number) => ({ n, j, s: pos(n.start) % len, len: n.len ?? STEP, key: n.key ?? 60 }));
  (pat.steps?.[ch.id] ?? []).forEach((v: number, i: number) => v && ns.push({ n: { key: 60 }, j: -1, step: i, s: i * STEP, len: STEP, key: 60 }));
  return ns.map((x: any) => ({ ...x, instr: (ch.keymap ?? []).find((k: any) => k.key === x.key) }));
}
const noteHint = (x: any) => `${x.instr?.name ?? `key ${x.key}`} at ${posStr(x.s)}, ${x.len / STEP} steps${x.n.when ? ` · when ${x.n.when}` : ""}${x.n.pass ? ` · pass ${x.n.pass}` : ""}${x.n.slide ? " · slide (continues the previous voice's conversation)" : ""}${x.j < 0 ? " · step note from the rack" : ""} · click to delete`;
function hit(x: number, y: number) {
  if (!geo || x < PR.label || y < PR.head) return null;
  const r = Math.floor((y - PR.head) / PR.row), step = Math.floor((x - PR.label) / geo.col);
  const instr = geo.rows[r];
  if (!instr || step >= geo.n) return null;
  const note = geo.notes.find((nt: any) => nt.key === instr.key && step >= nt.s / STEP && step < (nt.s + nt.len) / STEP);
  return { instr, step, note };
}
function clickPiano(x: number, y: number) {
  const h = hit(x, y), pat = curPattern(), ch = selChannel();
  if (!h) return;
  const pi = S.project.patterns.indexOf(pat), base = `/patterns/${pi}/notes`;
  if (h.note?.j >= 0) return patch([{ op: "remove", path: `${base}/${ptr(ch)}/${h.note.j}` }], `deleted ${h.note.instr?.name} note at ${posStr(h.note.s)} of ${ch}`);
  if (h.note) return toggleStep(ch, h.note.step);
  const note = { start: posStr(h.step * STEP), len: STEP, key: h.instr.key };
  patch(!pat.notes ? [{ op: "add", path: base, value: { [ch]: [note] } }] : !pat.notes[ch] ? [{ op: "add", path: `${base}/${ptr(ch)}`, value: [note] }] : [{ op: "add", path: `${base}/${ptr(ch)}/-`, value: note }], `added ${h.instr.name} note at ${note.start} of ${ch}`);
}
document.addEventListener("click", (ev) => {
  const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!t) return;
  const a = t.dataset.act;
  if (a === "step") toggleStep(t.dataset.ch!, +t.dataset.i!);
  else if (a === "channel") { S.channel = t.dataset.ch; piano(); rack(); }
  else if (a === "voice") { S.voice = S.voice === +t.dataset.v! ? null : +t.dataset.v!; tracer(); }
  else if (a === "delnote") { const pat = curPattern(), ch = selChannel(); patch([{ op: "remove", path: `/patterns/${S.project.patterns.indexOf(pat)}/notes/${ptr(ch)}/${t.dataset.j}` }], `deleted note ${t.dataset.j} of ${ch}`); }
});

export function drawPiano() {
  const cv = $("piano").querySelector("canvas") as HTMLCanvasElement | null, pat = curPattern(), ch = (S.project?.channels ?? []).find((c: any) => c.id === selChannel());
  if (!cv) return;
  const box = cv.parentElement!, dpr = devicePixelRatio || 1, W = box.clientWidth, H = box.clientHeight;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px"; }
  const g = cv.getContext("2d")!; g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = "#1f262b"; g.fillRect(0, 0, W, H);
  if (!pat || !ch) { geo = null; return; }
  const n = pat.lengthSteps ?? 16, col = (W - PR.label) / n, rows = [...(ch.keymap ?? [])].sort((a: any, b: any) => b.key - a.key);
  const notes = pianoNotes(pat, ch), color = ch.color ?? "#9aa5ae", t = performance.now();
  geo = { n, col, rows, notes };
  rows.forEach((k: any, r: number) => { // row stripes + labels
    const y = PR.head + r * PR.row;
    g.fillStyle = r % 2 ? "#283036" : "#2c353c"; g.fillRect(PR.label, y, W - PR.label, PR.row);
    g.fillStyle = "#343d45"; g.fillRect(0, y, PR.label, PR.row - 1);
    g.fillStyle = "#d5dbe0"; g.font = "12px system-ui, sans-serif"; g.textBaseline = "middle"; g.fillText(k.name ?? `key ${k.key}`, 8, y + PR.row / 2);
    g.fillStyle = "#8b969f"; g.font = "10px system-ui, sans-serif"; g.fillText(String(k.key), PR.label - 22, y + PR.row / 2);
  });
  for (let i = 0; i <= n; i++) { // grid: steps, beats, bars
    const x = PR.label + i * col;
    g.fillStyle = i % 16 === 0 ? "#5b6670" : i % 4 === 0 ? "#434d55" : "#323a41"; g.fillRect(Math.round(x), PR.head, 1, rows.length * PR.row);
    if (i % 4 === 0 && i < n) { g.fillStyle = "#8b969f"; g.font = "10px system-ui, sans-serif"; g.fillText(posStr(i * STEP), x + 3, PR.head / 2); }
  }
  const voices = [...S.run.voices.values()].filter((v: any) => v.channel === ch.id);
  for (const x of notes) {
    const r = rows.findIndex((k: any) => k.key === x.key);
    if (r < 0) continue;
    const nx = PR.label + (x.s / STEP) * col + 1, ny = PR.head + r * PR.row + 3, nw = Math.max(6, (x.len / STEP) * col - 2), nh = PR.row - 6;
    const vs = voices.filter((v: any) => v.key === x.key), wt = S.run.running && vs.some((v: any) => v.status === "waiting"), running = wt || (S.run.running && vs.some((v: any) => v.status === "running")), failed = vs.some((v: any) => v.status === "failed");
    g.globalAlpha = x.j < 0 ? 0.6 : 1;
    g.fillStyle = failed ? "#e2574c" : color; g.beginPath(); g.roundRect(nx, ny, nw, nh, 3); g.fill();
    if (running) { g.globalAlpha = 0.35 + 0.35 * Math.sin(t / 160); g.strokeStyle = "#fff"; g.lineWidth = 2; g.stroke(); }
    g.globalAlpha = 1; g.fillStyle = "#16130e"; g.font = "600 11px system-ui, sans-serif";
    g.save(); g.beginPath(); g.rect(nx, ny, nw, nh); g.clip();
    let bx = nx + 6; g.fillText(x.instr?.name ?? `key ${x.key}`, bx, ny + nh / 2); bx += g.measureText(x.instr?.name ?? "").width + 8;
    for (const b of [wt && "⏳ harness", x.n.when && `if ${x.n.when}`, x.n.pass && `pass ${x.n.pass}`, x.n.slide && "slide ↝", x.j < 0 && "step"].filter(Boolean) as string[]) {
      g.font = "10px system-ui, sans-serif"; const bw = g.measureText(b).width + 10;
      g.fillStyle = "#0006"; g.beginPath(); g.roundRect(bx, ny + 5, bw, nh - 10, 7); g.fill();
      g.fillStyle = "#f4f1e8"; g.fillText(b, bx + 5, ny + nh / 2); bx += bw + 4;
    }
    g.restore();
  }
}

// ---- Mixer: strips (Master last), slots, sends, live meters ----
export function mixer() {
  const buses = [...(S.project.mixer?.buses ?? []), { id: "master", name: "Master", ...(S.project.mixer?.master ?? {}) }];
  const m = S.run.buses, max = Math.max(1, ...Object.values<any>(m).map((b) => b.frames));
  const MODE: Record<string, string> = { final: "F", all: "A", sidechain: "SC" };
  const strips = buses.map((b: any, i: number) => {
    const mt = m[b.id] ?? { frames: 0, cost: 0, errors: 0 }, sends = b.id === "master" ? [] : b.sends ?? [{ to: "master", mode: "all" }];
    const slots = [...(b.slots ?? []), ...Array(Math.max(0, 3 - (b.slots?.length ?? 0))).fill(null)];
    const h = Math.round((mt.frames / max) * 100);
    return `<div class="strip${b.id === "master" ? " master" : ""}${fl(`bus:${b.id}`)}" data-hint="Bus ${esc(b.name ?? b.id)}${b.join ? ` · join ${esc(b.join)}` : ""}">
      <h3><i>${b.id === "master" ? "M" : i + 1}</i>${esc(b.name ?? b.id)}</h3>
      <div class="meter" role="meter" aria-label="${esc(b.id)} frames this run" aria-valuenow="${mt.frames}" aria-valuemin="0" aria-valuemax="${max}" data-hint="Frames that reached ${esc(b.id)} in the ${S.run.running ? "current" : "last"} run"><i style="height:${h}%"></i><i style="height:${Math.round(h * 0.86)}%"></i></div>
      <div class="stat"><span>${mt.frames} fr</span><span>$${mt.cost.toFixed(3)}</span><span class="${mt.errors ? "err" : ""}">⚠${mt.errors}</span></div>
      ${slots.map((s: any, j: number) => s ? `<div class="slot" data-hint="Slot ${j + 1}: ${esc(s.plugin)} ${esc(JSON.stringify(s.params ?? {}).slice(0, 140))}">${j + 1} ${esc(s.plugin.replace("fx.", ""))}${s.plugin === "fx.gate" && s.params?.condition?.startsWith("side") ? " ◀SC" : ""}</div>` : `<div class="slot empty">${j + 1} —</div>`).join("")}
      ${sends.map((s: any) => `<div class="send" data-hint="Send to ${esc(s.to)}, mode ${esc(s.mode)}">→ ${esc(s.to)} ${MODE[s.mode] ?? esc(s.mode)}</div>`).join("")}
      ${b.id === "master" ? (b.targets ?? []).map((t: any) => `<div class="send muted">⇥ ${esc(t.type)}</div>`).join("") : ""}</div>`;
  }).join("");
  set($("mixer"), `<h2>Mixer <span class="muted">${buses.length} buses</span><kbd>F9</kbd></h2><div class="body"><div class="strips">${strips}</div></div>`);
}

// ---- Tracer: voice Gantt by wall time + frame list ----
export function tracer() {
  const tk = S.latest, wt = waiting();
  // the live run is not in a take yet: say what it is waiting for
  const bar = wt.length ? `<div class="waitbar" role="status">${esc(waitFor(wt[0]))}: ${wt.map((v: any) => `<b>${esc(chName(v.channel))}</b> ${esc((S.project.channels ?? []).find((c: any) => c.id === v.channel)?.keymap?.find((k: any) => k.key === v.key)?.name ?? "")} <span class="muted">(pass ${v.pass + 1}, voice ${v.voice})</span>`).join(" · ")}</div>` : "";
  if (!tk) return set($("tracer"), `<h2>Tracer<kbd>F10</kbd></h2>${bar}<p class="empty-note">No takes yet. Run the song (Space) or let your harness call run_start.</p>`);
  const vs: any[] = tk.voices.filter((v: any) => v.startMs != null), end = Math.max(1, ...vs.map((v) => v.endMs ?? v.startMs));
  const gantt = vs.map((v) => `<button class="vrow" data-act="voice" data-v="${v.voice}" data-k="v:${v.voice}" aria-pressed="${S.voice === v.voice}" data-hint="${esc(chName(v.channel))} · pass ${v.pass + 1} · ${esc(v.status)} · ${(v.endMs ?? v.startMs) - v.startMs} ms · $${v.costUsd.toFixed(4)}${v.cached ? " · cached" : ""}. Click to filter frames">
    <span>${esc(chName(v.channel))} · pass ${v.pass + 1}</span><span class="vtrack"><i class="${esc(v.status)}" style="background:${esc(chColor(v.channel))};left:${(v.startMs / end) * 100}%;width:${(((v.endMs ?? v.startMs) - v.startMs) / end) * 100}%"></i></span></button>`).join("");
  const frames = (tk.frames ?? []).filter((f: any) => S.voice == null || f.voice === S.voice);
  const list = frames.map((f: any) => `<div class="frame"><header><span class="k ${esc(f.kind)}">${esc(f.kind)}</span><span class="trust ${esc(f.trust)}">${esc(f.trust ?? "trusted")}</span><span>${esc(chName(f.channel))} → ${esc(f.bus)} · pass ${f.pass + 1}${f.final ? " · final" : ""}</span></header>
    <p>${esc(f.text ?? "")}${f.json !== undefined ? `<span class="muted">${f.text ? "\n" : ""}${esc(JSON.stringify(f.json))}</span>` : ""}</p></div>`).join("");
  const r = tk.run;
  set($("tracer"), `<h2>Tracer <span class="muted">take ${esc(r.id)} · ${esc(r.status)}${r.stopped ? `: ${esc(r.stopped)}` : ""} · ${r.passes} passes · ${vs.length} voices · $${r.costUsd.toFixed(4)} · ${end} ms</span><kbd>F10</kbd></h2>${bar}
    <div class="body"><div class="tr"><div class="gantt">${gantt}</div><div class="frames">${S.voice != null ? `<p class="muted">Frames of one voice. Click it again to show all.</p>` : ""}${list}</div></div></div>`);
}
