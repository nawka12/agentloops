// Studio v2b "Make music": the channel window, plugin and processor pickers, context menus, the slot and loop editors, the Browser.
// Every edit is one JSON Patch as source "studio" (one undo step). Text fields commit on blur or after 600 ms idle; validation errors show inline and never block.
import { S, curPattern, html, openWin, paint, patch, post, ptr, toggleWin } from "./main.ts";

export const cat: any = { plugins: [], presets: [] };
export const loadCatalog = async () => { try { Object.assign(cat, await (await fetch("/api/catalog")).json()); } catch {} };
let songList: any = null, songsAsked = false;
export const loadSongs = async () => { songsAsked = true; try { songList = await (await fetch("/api/songs")).json(); paint(); } catch {} };

export const EFFORT = ["low", "medium", "high", "xhigh", "max"];
const COLORS = ["#e8a33d", "#5aa9e6", "#93e04a", "#e0607e", "#9b7ede", "#4fd1c1", "#d6c25a", "#f08a5d"];
export const LABEL: Record<string, string> = { script: "Script", "llm.agent": "Agent", harness: "You (harness)", "fx.gate": "Gate", "fx.validator": "Validator", "fx.formatter": "Formatter", "fx.limiter": "Limiter" };
const DESC: Record<string, string> = {
  script: "Runs a JavaScript function body. Free and instant: sketch a song before you use real models.",
  "llm.agent": "A Claude model with a system prompt and optional MCP tools. Every voice it plays costs money.",
  harness: "Your harness (Claude Code over Studio MCP) plays it under its own login. The run waits for its reply.",
  "fx.gate": "Passes a frame only while a condition holds, for example the verdict on a sidechain.",
  "fx.validator": "Checks a frame's JSON against a schema, then drops it, errors, or asks the voice to retry.",
  "fx.formatter": "Rewrites each frame's text from a template.",
  "fx.limiter": "Caps the cost or tokens that pass through the bus.",
};
/** what a new channel starts with, per generator */
const STARTER: Record<string, any> = {
  script: { params: { code: "return `${ctx.note.name}: ${ctx.prompt}`;" }, keymap: [{ key: 60, name: "Run", template: "Say something about {{note.text}}" }] },
  "llm.agent": { params: { model: "claude-sonnet-5-5", system: "You are a helpful, precise assistant.", effort: "medium" }, keymap: [{ key: 60, name: "Prompt", template: "Write about: {{note.text}}" }] },
  harness: { params: { instructions: "" }, keymap: [{ key: 60, name: "Do", template: "{{note.text}}" }] },
};
const PROC_DEFAULT: Record<string, any> = {
  "fx.gate": { condition: "true", hold: "none" }, "fx.validator": { schema: { type: "object" }, onFail: "drop" },
  "fx.formatter": { template: "{{frame.text}}" }, "fx.limiter": { ceiling: 1, unit: "usd", action: "block" },
};
const needsKey = (pl: string) => pl === "llm.agent";
export const keyBadge = (k: boolean) => k
  ? html`<span class="kb key" data-hint="Runs a real model: needs ANTHROPIC_API_KEY, and each voice costs money (cached voices are free)">API key</span>`
  : html`<span class="kb free" data-hint="Runs without an API key, at no cost">no API key needed</span>`;

// ---- patch helpers ----
const jp = (keys: (string | number)[]) => keys.map((k) => "/" + ptr(String(k))).join("");
/** ops that set the value at `keys` (or remove it when v is undefined), creating missing parent objects */
export function setAt(root: any, keys: (string | number)[], v: any): any[] {
  let o = root, i = 0;
  for (; i < keys.length - 1 && o?.[keys[i]] != null && typeof o[keys[i]] === "object"; i++) o = o[keys[i]];
  const path = jp(keys.slice(0, i + 1));
  if (i < keys.length - 1) return v === undefined ? [] : [{ op: "add", path, value: keys.slice(i + 1).reduceRight((acc: any, k) => ({ [k]: acc }), v) }];
  if (v === undefined) return o != null && Object.hasOwn(o, keys[i]) ? [{ op: "remove", path }] : [];
  return [{ op: "add", path, value: v }];
}
/** append to the array at `keys`, creating it */
const addTo = (keys: (string | number)[], v: any) => Array.isArray(keys.reduce((o: any, k) => o?.[k], S.project)) ? [{ op: "add", path: jp(keys) + "/-", value: v }] : setAt(S.project, keys, [v]);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
export const uid = (base: string, taken: string[]) => { const b = slug(base); if (!taken.includes(b)) return b; for (let i = 2; ; i++) if (!taken.includes(`${b}-${i}`)) return `${b}-${i}`; };
const ids = (xs: any): string[] => (Array.isArray(xs) ? xs : []).map((x: any) => x?.id);
export const allBuses = () => [...ids(S.project.mixer?.buses), "master"];
export const busKeys = (id: string) => (id === "master" ? ["mixer", "master"] : ["mixer", "buses", ids(S.project.mixer?.buses).indexOf(id)]);
export const busOf = (id: string) => (id === "master" ? { id: "master", name: "Master", ...(S.project.mixer?.master ?? {}) } : (S.project.mixer?.buses ?? []).find((b: any) => b.id === id));
const set = (keys: (string | number)[], v: any, summary: string) => patch(setAt(S.project, keys, v), summary);

// ---- form fields: a draft per field while typing; one patch on blur or after 600 ms idle ----
const drafts = new Map<string, string>(), ftimer: Record<string, any> = {};
type FO = { area?: boolean; mono?: boolean; ph?: string; num?: boolean; json?: boolean; rows?: number; label?: string; hint?: string; err?: string };
export function field(k: string, val: any, commit: (v: any) => any, o: FO = {}) {
  const shown = o.json ? (val === undefined ? "" : JSON.stringify(val, null, 2)) : val == null ? "" : String(val);
  const d = drafts.get(k), text = d ?? shown;
  const parse = (t: string) => (o.num ? (t.trim() === "" ? undefined : Number(t)) : o.json ? (t.trim() === "" ? undefined : JSON.parse(t)) : t);
  let bad = "";
  if (d != null) try { const v = parse(d); if (o.num && v !== undefined && !Number.isFinite(v)) bad = "not a number"; } catch (e: any) { bad = `JSON: ${e.message}`; }
  const flush = () => {
    clearTimeout(ftimer[k]);
    const t = drafts.get(k);
    if (t == null) return;
    if (t === shown) { drafts.delete(k); return; }
    let v: any; try { v = parse(t); } catch { return; } // a parse error stays visible as a draft
    if (o.num && v !== undefined && !Number.isFinite(v)) return;
    Promise.resolve(commit(v)).finally(() => { if (drafts.get(k) === t) { drafts.delete(k); paint(); } });
  };
  const onInput = (e: any) => { drafts.set(k, e.target.value); clearTimeout(ftimer[k]); ftimer[k] = setTimeout(flush, 600); if (o.json || o.num) paint(); };
  const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Enter" && !o.area) { e.preventDefault(); flush(); } };
  const serr = o.err ? (S.errors as any[]).find((x) => x.path === o.err || x.path.startsWith(o.err + "/")) : null, msg = bad || serr?.message;
  const cls = `fld${o.mono ? " mono" : ""}${msg ? " bad" : ""}`;
  const el = o.area
    ? html`<textarea class=${cls} rows=${o.rows ?? 3} value=${text} placeholder=${o.ph} onInput=${onInput} onBlur=${flush} data-hint=${o.hint} spellcheck=${!o.mono} aria-label=${o.label}></textarea>`
    : html`<input class=${cls} value=${text} placeholder=${o.ph} onInput=${onInput} onBlur=${flush} onKeyDown=${onKeyDown} data-hint=${o.hint} inputmode=${o.num ? "decimal" : undefined} aria-label=${o.label}/>`;
  const em = msg ? html`<em class="ferr" data-hint=${serr?.fix ? `fix: ${serr.fix}` : undefined}>${msg}</em>` : null;
  return o.label ? html`<label class="row"><span>${o.label}</span><span class="fcell">${el}${em}</span></label>` : html`<span class="fcell">${el}${em}</span>`;
}
const sel = (v: any, opts: [string, string][], on: (v: string) => void, hint?: string, label?: string) =>
  html`<select value=${v} onChange=${(e: any) => on(e.target.value)} data-hint=${hint} aria-label=${label}>${opts.map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select>`;
const row = (label: string, el: any, hint?: string) => html`<label class="row" data-hint=${hint}><span>${label}</span><span class="fcell">${el}</span></label>`;

// ---- popovers: context menu, pickers ----
const place = (x: number, y: number, w: number, h: number) => `left:${Math.max(4, Math.min(x, innerWidth - w - 8))}px;top:${Math.max(4, Math.min(y, innerHeight - h - 8))}px`;
export const menu = (e: MouseEvent, items: any[]) => { e.preventDefault(); e.stopPropagation(); S.menu = { x: e.clientX, y: e.clientY, items: items.filter(Boolean) }; paint(); };
export function Menu() {
  const m = S.menu;
  if (!m) return null;
  return html`<div class="menu" role="menu" style=${place(m.x, m.y, 210, m.items.length * 25 + 8)} onContextMenu=${(e: Event) => e.preventDefault()}>
    ${m.items.map((it: any) => it === "-" ? html`<hr/>` : html`<button role=${it.on != null ? "menuitemcheckbox" : "menuitem"} aria-checked=${it.on} class=${it.danger ? "danger" : ""} data-hint=${it.hint}
      onClick=${() => { S.menu = null; paint(); it.act(); }}><i class="chk">${it.on ? "✓" : ""}</i>${it.label}</button>`)}</div>`;
}
export const openPicker = (kind: "gen" | "proc", e?: MouseEvent | null, extra: any = {}) => { S.picker = { kind, x: e?.clientX ?? innerWidth / 2 - 180, y: e?.clientY ?? 140, ...extra }; paint(); };
export function Picker() {
  const pk = S.picker;
  if (!pk) return null;
  const gen = pk.kind === "gen", items = cat.plugins.filter((p: any) => p.kind === (gen ? "generator" : "processor"));
  return html`<div class="picker" role="dialog" aria-label=${gen ? "Add a channel" : "Insert a processor"} style=${place(pk.x, pk.y, 360, 64 + items.length * 62)}
      onKeyDown=${(e: KeyboardEvent) => { if (e.key === "Escape") { S.picker = null; paint(); } }}>
    <header>${gen ? "Add a channel" : `Insert into ${busOf(pk.bus)?.name ?? pk.bus}, slot ${pk.slot + 1}`}<button class="x" aria-label="Close" onClick=${() => { S.picker = null; paint(); }}>×</button></header>
    ${items.map((p: any) => html`<button class="pick" data-id=${p.id} data-hint=${p.summary} onClick=${() => { S.picker = null; paint(); gen ? addChannel(p.id) : insertProc(pk.bus, pk.slot, p.id); }}>
      <span class="l1"><b>${LABEL[p.id] ?? p.id}</b><code>${p.id}</code>${gen ? keyBadge(needsKey(p.id)) : null}</span><span class="d">${DESC[p.id] ?? p.summary}</span></button>`)}
    ${gen ? html`<footer class="muted">More ready-made instruments are in the Browser (Alt+F8).</footer>` : null}</div>`;
}

// ---- channels ----
export const openChannel = (id: string) => { S.channel = id; openWin(`ch:${id}`); };
export function addChannel(plugin: string, preset?: any) {
  const p = S.project, chs: any[] = p.channels ?? [], base = preset?.name ?? LABEL[plugin] ?? plugin;
  const id = uid(base, [...ids(chs), ...allBuses()]), name = chs.some((c) => c.name === base) ? `${base} ${chs.length + 1}` : base, st = STARTER[plugin];
  const ch = { id, name, color: preset?.color ?? COLORS[chs.length % COLORS.length], generator: { plugin, params: structuredClone(st.params) }, keymap: structuredClone(st.keymap),
    inputs: [], context: "fresh", polyphony: 1, ...structuredClone(preset?.channel ?? {}), output: id };
  return patch([...addTo(["mixer", "buses"], { id, name, slots: [] }), ...addTo(["channels"], ch)], `added ${preset ? `preset ${preset.id}` : plugin} channel ${id}`)
    .then((ok) => { if (!ok) return; const r = S.wins.rack; if (r) r.h = Math.max(r.h, 96 + 30 * Math.min(10, chs.length + 1)); openChannel(id); });
}
export function cloneChannel(id: string) {
  const chs: any[] = S.project.channels ?? [], c = chs.find((x) => x.id === id), nid = uid(id, [...ids(chs), ...allBuses()]);
  return patch(addTo(["channels"], { ...structuredClone(c), id: nid, name: `${c.name ?? id} 2`, mute: undefined, solo: undefined }), `cloned ${id} as ${nid}`).then((ok) => { if (ok) openChannel(nid); });
}
export function renameChannel(id: string) {
  const ci = ids(S.project.channels).indexOf(id), c = S.project.channels[ci], n = prompt("Channel name", c.name ?? id); // ponytail: native prompt/confirm dialogs, restyle if they jar
  if (n && n !== c.name) set(["channels", ci, "name"], n, `renamed ${id} to ${n}`);
}
export function deleteChannel(id: string) {
  const p = S.project, ci = ids(p.channels).indexOf(id), c = p.channels[ci], pats = (p.patterns ?? []).filter((x: any) => x.notes?.[id] || x.steps?.[id]);
  if (!confirm(`Delete the channel ${c.name ?? id}?${pats.length ? ` Its notes and steps in ${pats.length} pattern${pats.length > 1 ? "s" : ""} go too.` : ""} Undo brings it back.`)) return;
  const ops: any[] = [];
  (p.patterns ?? []).forEach((x: any, pi: number) => { for (const k of ["notes", "steps"]) if (x[k]?.[id]) ops.push({ op: "remove", path: `/patterns/${pi}/${k}/${ptr(id)}` }); });
  ops.push({ op: "remove", path: `/channels/${ci}` });
  delete S.wins[`ch:${id}`];
  patch(ops, `deleted channel ${id}`);
}
const newBusFor = (ci: number) => {
  const c = S.project.channels[ci], n = prompt("Name of the new bus", c.name ?? c.id);
  if (!n) return paint();
  const bid = uid(n, allBuses());
  patch([...addTo(["mixer", "buses"], { id: bid, name: n, slots: [] }), ...setAt(S.project, ["channels", ci, "output"], bid)], `routed ${c.id} to a new bus ${bid}`);
};

/** the dragged item of a type, from the Browser */
const DT = (t: string) => `application/x-alp-${t}`;
export const dropOk = (t: string) => (e: DragEvent) => { if (e.dataTransfer?.types.includes(DT(t))) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } };
export const dragData = (e: DragEvent, t: string) => { try { const s = e.dataTransfer?.getData(DT(t)); return s ? JSON.parse(s) : null; } catch { return null; } };

const cwTab: Record<string, string> = {};
const TABS = [["general", "General"], ["keymap", "Instructions"], ["inputs", "Inputs"], ["routing", "Routing"]];
/** FL's channel settings window: one per channel, several open at once */
export function ChannelWin(id: string) {
  const chs: any[] = S.project.channels ?? [], ci = chs.findIndex((c) => c.id === id), c = chs[ci];
  if (!c) return html`<p class="empty-note">This channel no longer exists.</p>`;
  const K = (...k: (string | number)[]) => ["channels", ci, ...k], P = (...k: (string | number)[]) => jp(K(...k)), fk = (k: string) => `${id}:${k}`;
  const tab = cwTab[id] ?? "general", pl = c.generator?.plugin, ps = c.generator?.params ?? {}, km: any[] = c.keymap ?? [], ins: any[] = c.inputs ?? [];
  const buses = allBuses(), busOpts = (cur: string) => [...buses, ...(cur && !buses.includes(cur) ? [cur] : [])].map((b) => [b, b === "master" ? "Master" : busOf(b)?.name ? `${busOf(b).name} (${b})` : b] as [string, string]);
  const pf = (k: string, label: string, o: FO = {}) => field(fk(k), ps[k], (v) => set(K("generator", "params", k), v === "" ? undefined : v, `${k} on ${id}`), { label, err: P("generator", "params", k), ...o });
  const switchPlugin = (v: string) => {
    if (v === pl) return;
    const keys = Object.keys(ps);
    if (keys.length && !confirm(`Switch ${c.name ?? id} to ${LABEL[v]}? Its ${pl} params (${keys.join(", ")}) are discarded. The instructions stay.`)) return paint();
    set(K("generator"), { plugin: v, params: structuredClone(STARTER[v]?.params ?? {}) }, `${id} plays ${v}`);
  };
  let body: any;
  if (tab === "general") {
    const gens = cat.plugins.filter((x: any) => x.kind === "generator"), models: string[] = gens.find((x: any) => x.id === "llm.agent")?.models ?? [];
    const servers = Object.keys(S.project.tools ?? {}), tools: string[] = Array.isArray(ps.tools) ? ps.tools : [];
    const params = pl === "script" ? html`${pf("code", "Code", { area: true, mono: true, rows: 9, ph: "return 'hello';", hint: "An async function body. Return a string, {text, json}, or an array of those." })}
        <p class="cheat"><code>ctx.prompt</code> the instruction's filled-in template, <code>ctx.inputs.${"<as>"}.text</code> / <code>.json</code>, <code>ctx.note.text</code>, <code>ctx.loop.index</code> (0-based) and <code>.pass</code>, <code>ctx.trigger.payload</code>. Return a string or <code>{ text, json }</code>.</p>`
      : pl === "llm.agent" ? html`
        ${row("Model", sel(ps.model ?? "", [["", "default (claude-opus-5-5)"], ...[...models, ...(ps.model && !models.includes(ps.model) ? [ps.model] : [])].map((m) => [m, m] as [string, string])], (v) => set(K("generator", "params", "model"), v || undefined, `model ${v} on ${id}`), "The Claude model this channel runs", "Model"))}
        ${pf("system", "System prompt", { area: true, rows: 5, ph: "You are…" })}
        ${row("Effort", sel(ps.effort ?? "", [["", "default"], ...EFFORT.map((x) => [x, x] as [string, string])], (v) => set(K("generator", "params", "effort"), v || undefined, `effort ${v} on ${id}`), "Reasoning effort: also the rack knob, and each note's velocity", "Effort"))}
        ${pf("maxTokens", "Max tokens", { num: true, ph: "16000" })}
        ${pf("maxTurns", "Max turns", { num: true, ph: "10", hint: "Model calls per voice, tool calls included" })}
        ${row("Tools", servers.length ? html`<span class="chips">${servers.map((s) => html`<button type="button" class="chip" aria-pressed=${tools.includes(s)} data-hint=${`Allow every tool of the ${s} server`}
            onClick=${() => set(K("generator", "params", "tools"), tools.includes(s) ? tools.filter((t) => t !== s) : [...tools, s], `tools on ${id}`)}>${s}</button>`)}</span>`
          : html`<span class="muted">This song has no tool servers yet. Add one under <code>tools</code> in the song file.</span>`, "MCP tool servers this agent may call")}`
      : pl === "harness" ? html`${pf("instructions", "Instructions", { area: true, rows: 5, ph: "A role or system text shown to your harness with every request" })}${pf("timeoutMs", "Timeout (ms)", { num: true, ph: "1800000" })}` : null;
    body = html`<div class="form">
      ${field(fk("name"), c.name, (v) => { const b = busOf(c.output), bi = ids(S.project.mixer?.buses).indexOf(c.output); // the channel's own bus keeps its name in step
        return patch([...setAt(S.project, K("name"), v || undefined), ...(v && bi >= 0 && b.name === c.name ? setAt(S.project, ["mixer", "buses", bi, "name"], v) : [])], `renamed ${id} to ${v}`); }, { label: "Name", err: P("name") })}
      ${row("Color", html`<input type="color" value=${c.color ?? "#9aa5ae"} onChange=${(e: any) => set(K("color"), e.target.value, `color of ${id}`)} aria-label="Color"/>`)}
      ${row("Generator", html`${sel(pl, gens.map((g: any) => [g.id, `${LABEL[g.id] ?? g.id} (${g.id})`] as [string, string]), switchPlugin, "Switching keeps the instructions and asks before it discards the params", "Generator")}${keyBadge(needsKey(pl))}`)}
      ${params}</div>`;
  } else if (tab === "keymap") {
    const nextKey = () => { const ks = km.map((k) => k.key).filter(Number.isInteger); return ks.length ? Math.max(...ks) + 2 : 60; };
    const addRow = (r: any) => patch(addTo(K("keymap"), { key: nextKey(), ...r }), `added instruction ${r.name} to ${id}`);
    const mv = (j: number, to: number) => patch([{ op: "move", from: P("keymap", j), path: P("keymap", to) }], `moved instruction ${km[j].name ?? j} of ${id}`);
    body = html`<p class="blurb">Each instruction is one row of the piano roll: a note on that row runs its template. Steps in the rack play key 60. Drag a template from the Browser onto this table.</p>
      <div class="kmap" onDragOver=${dropOk("instr")} onDrop=${(e: DragEvent) => { const t = dragData(e, "instr"); if (t) { e.preventDefault(); addRow(t); } }}>
        <div class="kh"><span>Key</span><span>Name</span><span>Template</span><span>Output schema (JSON)</span><span></span></div>
        ${km.map((k, j) => html`<div class="kr">
          ${field(fk(`k${j}.key`), k.key, (v) => set(K("keymap", j, "key"), v, `instruction key on ${id}`), { num: true, err: P("keymap", j, "key"), label: undefined, hint: "The piano-roll row. 60 is the default; steps use it" })}
          ${field(fk(`k${j}.name`), k.name, (v) => set(K("keymap", j, "name"), v || undefined, `instruction name on ${id}`), { ph: "Name" })}
          ${field(fk(`k${j}.tpl`), k.template, (v) => set(K("keymap", j, "template"), v || undefined, `template on ${id}`), { area: true, rows: 2, ph: "{{note.text}}", hint: "{{note.text}}, {{inputs.<as>}}, {{loop.pass}}, {{trigger.payload.<field>}}" })}
          ${field(fk(`k${j}.sch`), k.schema, (v) => set(K("keymap", j, "schema"), v, `output schema on ${id}`), { area: true, rows: 2, mono: true, json: true, ph: "none: plain text", hint: "A JSON Schema for structured output. Empty means plain text." })}
          <span class="acts"><button disabled=${j === 0} onClick=${() => mv(j, j - 1)} aria-label="Move up" data-hint="Move this instruction up">↑</button><button disabled=${j === km.length - 1} onClick=${() => mv(j, j + 1)} aria-label="Move down" data-hint="Move this instruction down">↓</button><button class="danger" onClick=${() => patch([{ op: "remove", path: P("keymap", j) }], `deleted instruction ${k.name ?? k.key} of ${id}`)} aria-label="Delete instruction" data-hint="Delete this instruction. Notes on its row turn into validation errors.">✕</button></span></div>`)}
      </div>
      <button class="add" onClick=${() => addRow({ name: "New", template: "{{note.text}}" })} data-hint="Add an instruction: a new piano-roll row">+ Instruction</button>`;
  } else if (tab === "inputs") {
    const setBus = (j: number, b: string) => { const x = ins[j]; patch([...setAt(S.project, K("inputs", j, "bus"), b), ...(x.as == null || x.as === x.bus ? setAt(S.project, K("inputs", j, "as"), b) : [])], `input ${j + 1} of ${id} reads ${b}`); };
    body = html`<p class="blurb">An input is a snapshot of what a bus emitted before this voice starts. Templates read it as <code>{{inputs.${"<as>"}}}</code>, scripts as <code>ctx.inputs.${"<as>"}</code>.</p>
      <div class="ins"><div class="kh"><span>Bus</span><span>Window</span><span>Select</span><span>As</span><span></span></div>
      ${ins.map((x, j) => html`<div class="kr">
        ${sel(x.bus, busOpts(x.bus), (v) => setBus(j, v), "The bus to read", "Bus")}
        ${sel(typeof x.window === "string" ? x.window : x.window ? "last" : "last", [["last", "last frame"], ["pass", "this pass"], ["run", "whole run"]], (v) => set(K("inputs", j, "window"), v, `input window on ${id}`), "Which frames: the latest, all of this pass, or all of the run", "Window")}
        ${sel(x.select ?? "final", [["final", "final"], ["all", "all"]], (v) => set(K("inputs", j, "select"), v, `input select on ${id}`), "final: only each voice's answer. all: tool calls and partials too", "Select")}
        ${field(fk(`in${j}.as`), x.as, (v) => set(K("inputs", j, "as"), v || undefined, `input name on ${id}`), { ph: x.bus, err: P("inputs", j) })}
        <span class="acts"><button class="danger" onClick=${() => patch([{ op: "remove", path: P("inputs", j) }], `removed input ${x.bus} of ${id}`)} aria-label="Remove input" data-hint="Remove this input">✕</button></span></div>`)}</div>
      <button class="add" data-hint="Read another bus" onClick=${() => { const b = buses.find((x) => x !== c.output && x !== "master") ?? "master"; patch(addTo(K("inputs"), { bus: b, window: "last", select: "final", as: b }), `${id} reads ${b}`); }}>+ Input</button>`;
  } else {
    body = html`<div class="form">
      ${row("Output bus", sel(c.output ?? "master", [...busOpts(c.output ?? "master"), ["__new", "New bus…"]], (v) => (v === "__new" ? newBusFor(ci) : set(K("output"), v, `routed ${id} to ${v}`)), "The mixer bus this channel's frames go to", "Output bus"), undefined)}
      ${row("Context", sel(c.context ?? "fresh", [["fresh", "fresh: a new conversation per note"], ["persistent", "persistent: one conversation for the run"], ["per-pattern", "per pattern"]], (v) => set(K("context"), v, `context ${v} on ${id}`), "How long a conversation lasts across notes", "Context"))}
      ${field(fk("poly"), c.polyphony, (v) => set(K("polyphony"), v, `polyphony on ${id}`), { label: "Polyphony", num: true, ph: "4", err: P("polyphony"), hint: "Voices that may run at once (a chord fans out)" })}
      ${field(fk("retries"), c.retries, (v) => set(K("retries"), v, `retries on ${id}`), { label: "Retries", num: true, ph: "1", err: P("retries") })}
      ${row("On fail", sel(c.onFail ?? "stop", [["stop", "stop the run"], ["skip", "skip: record the error, go on"]], (v) => set(K("onFail"), v, `onFail ${v} on ${id}`), "What a failed voice does to the run", "On fail"))}
    </div>`;
  }
  return html`<div class="cw" style=${`--c:${c.color ?? "#9aa5ae"}`}>
    <nav class="tabs" role="tablist">${TABS.map(([k, l]) => html`<button role="tab" aria-selected=${tab === k} onClick=${() => { cwTab[id] = k; paint(); }}>${l}${k === "keymap" ? html`<small>${km.length}</small>` : k === "inputs" ? html`<small>${ins.length}</small>` : null}</button>`)}</nav>
    <div class="cw-body">${body}</div>
    <footer class="cw-foot"><button onClick=${() => { S.channel = id; toggleWin("piano", true); }} data-hint="Select this channel in the piano roll">Show in piano roll</button><span class="sp"></span>
      <button onClick=${() => cloneChannel(id)} data-hint="Copy this channel's settings into a new channel (notes stay here)">Clone</button>
      <button class="danger" onClick=${() => deleteChannel(id)} data-hint="Delete the channel with its notes and steps (asks first)">Delete…</button></footer></div>`;
}

// ---- mixer ----
export function addBus() {
  const n = (S.project.mixer?.buses?.length ?? 0) + 1, id = uid(`bus ${n}`, allBuses());
  patch(addTo(["mixer", "buses"], { id, name: `Bus ${n}`, slots: [] }), `added bus ${id}`).then((ok) => { if (ok) { S.monitorBus = id; paint(); } });
}
const slotsOf = (bus: string) => [...(busOf(bus)?.slots ?? [])];
const setSlots = (bus: string, slots: any[], summary: string) => set([...busKeys(bus), "slots"], slots, summary);
export function insertProc(bus: string, j: number, plugin: string) {
  const s = slotsOf(bus), at = Math.min(j, s.length);
  s.splice(at, 0, { plugin, params: structuredClone(PROC_DEFAULT[plugin] ?? {}) });
  setSlots(bus, s, `inserted ${plugin} on ${bus}, slot ${at + 1}`).then((ok) => { if (ok) { S.slotEd = { bus, j: at, x: S.picker?.x ?? innerWidth / 2 - 160, y: S.picker?.y ?? 200 }; paint(); } });
}
export const removeSlot = (bus: string, j: number) => { const s = slotsOf(bus), [x] = s.splice(j, 1); setSlots(bus, s, `removed ${x.plugin} from ${bus}`); };
export const moveSlot = (bus: string, from: number, to: number) => { const s = slotsOf(bus), [x] = s.splice(from, 1); s.splice(Math.min(to, s.length), 0, x); setSlots(bus, s, `moved ${x.plugin} on ${bus} to slot ${Math.min(to, s.length) + 1}`); };
export const SEND_MODES = ["final", "all", "sidechain"];
/** FL routing: a strip's send toggle adds a send from the selected strip to it (in the current mode) or removes the one there. Cycles are refused. */
export function toggleSend(from: string, to: string) {
  const cur: any[] = busOf(from).sends ?? [{ to: "master", mode: "all" }], has = cur.find((s) => s.to === to), mode = S.sendMode;
  patch(setAt(S.project, [...busKeys(from), "sends"], has ? cur.filter((s) => s !== has) : [...cur, { to, mode }]), has ? `removed send ${from} → ${to}` : `send ${from} → ${to} (${mode})`, { refuse: "cycle" });
}
export function busMenu(e: MouseEvent, b: any) {
  const isM = b.id === "master", bi = isM ? -1 : ids(S.project.mixer?.buses).indexOf(b.id);
  menu(e, [
    !isM && { label: "Rename…", act: () => { const n = prompt("Bus name", b.name ?? b.id); if (n) set(["mixer", "buses", bi, "name"], n, `renamed bus ${b.id}`); } },
    { label: "Join: aligned", on: (b.join ?? "aligned") === "aligned", hint: "Hold frames until every source of this barrier is done, then release them in channel order (reproducible)", act: () => set([...busKeys(b.id), "join"], undefined, `${b.id} join aligned`) },
    { label: "Join: stream", on: b.join === "stream", hint: "Pass frames through as they arrive", act: () => set([...busKeys(b.id), "join"], "stream", `${b.id} join stream`) },
    !isM && "-",
    !isM && { label: "Delete…", danger: true, act: () => {
      if (!confirm(`Delete the bus ${b.name ?? b.id}? Channels routed to it go to Master, and sends to it are removed.`)) return;
      const p = S.project, ops: any[] = [];
      (p.channels ?? []).forEach((c: any, ci: number) => { if (c.output === b.id) ops.push({ op: "remove", path: `/channels/${ci}/output` }); });
      (p.mixer.buses as any[]).forEach((x, j) => { if (x.sends?.some((s: any) => s.to === b.id)) ops.push({ op: "add", path: `/mixer/buses/${j}/sends`, value: x.sends.filter((s: any) => s.to !== b.id) }); });
      ops.push({ op: "remove", path: `/mixer/buses/${bi}` });
      if (S.monitorBus === b.id) S.monitorBus = "master";
      patch(ops, `deleted bus ${b.id}`);
    } },
  ]);
}
export function SlotEditor() {
  const ed = S.slotEd, b = ed && busOf(ed.bus), s = b?.slots?.[ed?.j];
  if (!s) return null;
  const K = [...busKeys(ed.bus), "slots", ed.j, "params"], q = s.params ?? {}, k = (n: string) => `slot:${ed.bus}:${ed.j}:${n}`;
  const pf = (n: string, label: string, o: FO = {}) => field(k(n), q[n], (v) => set([...K, n], v === "" ? undefined : v, `${s.plugin} ${n} on ${ed.bus}`), { label, err: jp([...K, n]), ...o });
  const ps = (n: string, label: string, opts: [string, string][], d: string, hint?: string) => row(label, sel(q[n] ?? d, opts, (v) => set([...K, n], v, `${s.plugin} ${n} ${v} on ${ed.bus}`), hint, label));
  const form = s.plugin === "fx.gate" ? html`${pf("condition", "Condition", { mono: true, ph: "side.last.json.approved", hint: "CEL: frame (this frame), side.last (the latest sidechain frame), loop.index, bus('id').last" })}
      ${ps("hold", "Hold", [["none", "none: drop a failing frame"], ["pass", "pass: wait for the sidechain, until the pass ends"]], "none")}`
    : s.plugin === "fx.validator" ? html`${pf("schema", "Schema", { area: true, mono: true, json: true, rows: 5 })}${ps("onFail", "On fail", [["drop", "drop"], ["error", "error"], ["retry", "retry the voice"]], "drop")}`
    : s.plugin === "fx.formatter" ? pf("template", "Template", { area: true, rows: 3, ph: "{{frame.text}}" })
    : s.plugin === "fx.limiter" ? html`${pf("ceiling", "Ceiling", { num: true, ph: "1" })}${ps("unit", "Unit", [["usd", "usd"], ["tokens", "tokens"]], "usd")}${ps("action", "Action", [["block", "block"], ["stop", "stop the run"]], "block")}`
    : html`<p class="muted">No editor for ${s.plugin}.</p>`;
  return html`<div class="pop2" role="dialog" aria-label="Processor settings" style=${place(ed.x, ed.y, 340, 220)} onKeyDown=${(e: KeyboardEvent) => { if (e.key === "Escape") { S.slotEd = null; paint(); } }}>
    <header>${LABEL[s.plugin] ?? s.plugin} on ${b.name ?? b.id}, slot ${ed.j + 1}<button class="x" aria-label="Close" onClick=${() => { S.slotEd = null; paint(); }}>×</button></header>
    <div class="form">${form}</div><p class="blurb">${DESC[s.plugin] ?? ""}</p></div>`;
}

// ---- patterns and loops ----
const pats = (): any[] => S.project.patterns ?? [];
export function newPattern() {
  const n = pats().length + 1, id = uid(`pattern ${n}`, ids(pats()));
  patch(addTo(["patterns"], { id, name: `Pattern ${n}`, lengthSteps: 16 }), `new pattern ${id}`).then((ok) => { if (ok) { S.pattern = id; paint(); } });
}
export function clonePattern(pat: any) {
  const id = uid(pat.id, ids(pats()));
  patch(addTo(["patterns"], { ...structuredClone(pat), id, name: `${pat.name ?? pat.id} 2` }), `cloned pattern ${pat.id} as ${id}`).then((ok) => { if (ok) { S.pattern = id; paint(); } });
}
export function renamePattern(pat: any) { const n = prompt("Pattern name", pat.name ?? pat.id); if (n) set(["patterns", pats().indexOf(pat), "name"], n, `renamed pattern ${pat.id}`); }
export function deletePattern(pat: any) {
  const arrs: any[] = S.project.arrangements ?? [], uses = arrs.flatMap((a, ai) => (a.clips ?? []).map((c: any, j: number) => [ai, j, c.ref]).filter((x: any) => x[2] === pat.id));
  if (!confirm(`Delete the pattern ${pat.name ?? pat.id}?${uses.length ? ` Its ${uses.length} clip${uses.length > 1 ? "s" : ""} in the playlist go too.` : ""}`)) return;
  patch([...uses.reverse().map(([ai, j]) => ({ op: "remove", path: `/arrangements/${ai}/clips/${j}` })), { op: "remove", path: `/patterns/${pats().indexOf(pat)}` }], `deleted pattern ${pat.id}`);
}
export function makeUnique(j: number) {
  const c = S.project.arrangements[0].clips[j], pat = pats().find((x) => x.id === c.ref), id = uid(pat.id, ids(pats()));
  patch([...addTo(["patterns"], { ...structuredClone(pat), id, name: `${pat.name ?? pat.id} (unique)` }), { op: "add", path: `/arrangements/0/clips/${j}/ref`, value: id }], `made clip ${j + 1} unique as ${id}`);
}
export const openLoop = (e: MouseEvent, kind: "pattern" | "clip", j?: number) => { S.pop2 = { kind, j, x: e.clientX - 20, y: e.clientY + 14 }; paint(); };
export const patternMenu = (e: MouseEvent) => {
  const pat = curPattern();
  menu(e, [{ label: "New pattern", act: newPattern }, pat && { label: "Clone", act: () => clonePattern(pat) }, pat && { label: "Rename…", act: () => renamePattern(pat) },
    pat && { label: "Length and loop…", act: () => openLoop(e, "pattern") }, pat && "-", pat && { label: "Delete…", danger: true, act: () => deletePattern(pat) }]);
};
export function LoopPop() {
  const pp = S.pop2;
  if (!pp) return null;
  const isPat = pp.kind === "pattern", pat = curPattern(), clip = !isPat && S.project.arrangements?.[0]?.clips?.[pp.j];
  const K = isPat ? ["patterns", pats().indexOf(pat)] : ["arrangements", 0, "clips", pp.j], o = isPat ? pat : clip;
  if (!o) return null;
  const lp = o.loop, L = [...K, "loop"], k = (n: string) => `loop:${K.join("/")}:${n}`;
  const lens = [16, 32, 64];
  return html`<div class="pop2" role="dialog" aria-label="Loop settings" style=${place(pp.x, pp.y, 330, 230)} onKeyDown=${(e: KeyboardEvent) => { if (e.key === "Escape") { S.pop2 = null; paint(); } }}>
    <header>${isPat ? `Pattern ${pat.name ?? pat.id}` : `Clip ${pp.j + 1} (${clip.ref})`}<button class="x" aria-label="Close" onClick=${() => { S.pop2 = null; paint(); }}>×</button></header>
    <div class="form">
      ${isPat ? row("Length", html`<span class="seg">${lens.map((n) => html`<button type="button" aria-pressed=${(pat.lengthSteps ?? 16) === n} onClick=${() => set([...K, "lengthSteps"], n, `${pat.id} is ${n} steps`)}>${n}</button>`)}</span>`, "Steps in the pattern (16 per bar)") : null}
      ${row("Loop", html`<input type="checkbox" checked=${!!lp} aria-label="Loop" onChange=${(e: any) => set(L, e.target.checked ? { max: 4 } : undefined, `${e.target.checked ? "loop" : "no loop"} on ${isPat ? pat.id : `clip ${pp.j + 1}`}`)}/>`,
        isPat ? "Replay the pattern pass after pass, up to max passes or until the condition holds" : "A clip loop overrides its pattern's loop")}
      ${lp ? html`${field(k("max"), lp.max, (v) => set([...L, "max"], v, "loop max"), { label: "Max passes", num: true, err: jp([...L, "max"]), hint: "Required: the loop never runs more passes than this" })}
        ${field(k("until"), lp.until, (v) => set([...L, "until"], v || undefined, "loop until"), { label: "Until", mono: true, ph: "bus('review').last.json.approved", err: jp([...L, "until"]), hint: "CEL, checked at the end of each pass: loop.index, bus('id').last.text / .json, run.costUsd" })}` : null}
    </div>${!isPat && !lp && pat?.loop ? html`<p class="blurb">Without its own loop the clip uses the pattern's.</p>` : null}</div>`;
}

// ---- Browser (Alt+F8): songs, instruments, processors, instruction templates; drag or double-click ----
const INSTR = [
  { name: "Summarize", hint: "Three sentences from the source input.", template: "Summarize this in three sentences:\n{{inputs.source}}" },
  { name: "Critique as JSON", hint: "A verdict with an output schema: gate on approved.", template: "Critique this draft. Approve it only if it is clear, correct and complete.\n{{inputs.draft}}",
    schema: { type: "object", required: ["approved", "notes"], properties: { approved: { type: "boolean" }, notes: { type: "string" } } } },
  { name: "Revise using review", hint: "Rewrite the last draft from the review input.", template: "Revise your draft using this review:\n{{inputs.review}}" },
  { name: "Extract JSON", hint: "Pull structured fields out of text.", template: "Extract the people, dates and amounts in this text as JSON:\n{{inputs.source}}", schema: { type: "object" } },
];
export const addPreset = (pr: any) => addChannel(pr.channel.generator.plugin, pr);
export async function openSong(b: any) { if (await post("/api/open", b)) loadSongs(); }
export function Browser() {
  if (!songsAsked) loadSongs();
  const item = (label: any, hint: string, drag: [string, any] | null, open?: () => void, badge?: any) =>
    html`<div class="bi" tabindex="0" role="button" draggable=${drag ? "true" : "false"} data-hint=${hint} onDblClick=${open} onKeyDown=${(e: KeyboardEvent) => { if (e.key === "Enter") open?.(); }}
      onDragStart=${(e: DragEvent) => { if (!drag) return; e.dataTransfer!.setData(DT(drag[0]), JSON.stringify(drag[1])); e.dataTransfer!.effectAllowed = "copy"; }}><span class="nm">${label}</span>${badge}</div>`;
  const sl = songList, procs = cat.plugins.filter((p: any) => p.kind === "processor");
  return html`<div class="br">
    <details open><summary data-hint="Songs in this folder, and the bundled demos">Songs</summary>
      ${(sl?.local ?? []).map((s: any) => item(html`${s.name}<small>${s.file}</small>`, s.file === sl.current ? "The song that is open now" : `Double-click to open ${s.file}. Your edits to this song are already saved.`,
        null, s.file === sl.current ? undefined : () => openSong({ file: s.file }), s.file === sl.current ? html`<span class="kb on">open</span>` : null))}
      <div class="bsub">Demos</div>
      ${(sl?.demos ?? []).map((s: any) => item(html`${s.name}<small>${s.file}</small>`, `Double-click to open a copy of the demo ${s.file} in this folder. The demo itself is never edited.`, null, () => openSong({ demo: s.file }), html`<span class="kb">demo</span>`))}</details>
    <details open><summary data-hint="Ready-made channels: drag one onto the channel rack, or double-click it">Instruments</summary>
      ${cat.presets.map((p: any) => item(p.name, `${p.description} Drag onto the channel rack or double-click to add it.`, ["preset", p.id], () => addPreset(p), keyBadge(p.needsKey)))}</details>
    <details open><summary data-hint="Mixer effects: drag one onto a slot">Processors</summary>
      ${procs.map((p: any) => item(LABEL[p.id] ?? p.id, `${DESC[p.id] ?? p.summary} Drag onto a mixer slot.`, ["proc", p.id]))}</details>
    <details open><summary data-hint="Prompt templates: drag one onto a channel window's instruction table">Instructions</summary>
      ${INSTR.map((t) => item(html`${t.name}${t.schema ? html`<small>JSON</small>` : null}`, `${t.hint} Drag onto a channel window's instruction table.`, ["instr", { name: t.name, template: t.template, ...(t.schema ? { schema: t.schema } : {}) }]))}</details>
  </div>`;
}
