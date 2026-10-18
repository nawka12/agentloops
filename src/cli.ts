#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { render } from "./engine.ts";
import { loadProject, pos, STEP, validate, type Err } from "./project.ts";

const USAGE = `usage:
  agentloops validate <file> [--json]
  agentloops render <file> [--arrangement id] [--pattern id] [--input f.json] [--cache fresh|prefer] [--budget n] [--json]
  agentloops score <file> [--pattern id]`;

function load(file: string) {
  try { return loadProject(file); }
  catch (e: any) { console.error(`cannot load ${file}: ${e.message}`); process.exit(1); }
}
function printErrors(errs: Err[]) {
  for (const e of errs) console.error(`${e.path || "/"}: ${e.message}\n    fix: ${e.fix}`);
}

/** Text view of arrangement, patterns and mixer (SPEC 10.4). */
export function score(p: any, onlyPattern?: string): string {
  const out: string[] = [];
  const chName = (id: string) => p.channels.find((c: any) => c.id === id)?.name ?? id;
  const pats: any[] = (p.patterns ?? []).filter((x: any) => !onlyPattern || x.id === onlyPattern);
  if (!onlyPattern) for (const a of p.arrangements ?? []) {
    const cells: Record<string, string[]> = {}, bars = (c: any) => Math.floor((pos(c.start ?? 0) ?? 0) / 384);
    let nBars = 1;
    const label = (c: any) => {
      const pat = (p.patterns ?? []).find((x: any) => x.id === c.ref), lp = c.loop ?? pat?.loop;
      return (pat?.name ?? c.ref) + (lp ? ` ⟳${lp.until ? ` until ${lp.until}` : ""}${lp.max ? `, max ${lp.max}` : ""}` : "");
    };
    const tracks: string[] = (a.tracks ?? [{ name: "Main" }]).map((t: any) => t.name);
    for (const c of a.clips ?? []) {
      const t = tracks[c.track ?? 0] ?? tracks[0];
      (cells[t] ??= [])[bars(c)] = label(c);
      nBars = Math.max(nBars, bars(c) + 1);
    }
    const w = Math.max(12, ...Object.values(cells).flat().map((s) => s.length + 1));
    const nw = Math.max(...tracks.map((t) => t.length));
    const head = `ARRANGEMENT ${a.name ?? a.id}`, hw = Math.max(head.length, nw + 2) + 2;
    out.push(head.padEnd(hw) + Array.from({ length: nBars }, (_, i) => ("|" + (i + 1)).padEnd(w + 1)).join(""));
    for (const t of tracks) out.push(("  " + t).padEnd(hw) + Array.from({ length: nBars }, (_, i) => ("|" + (cells[t]?.[i] ?? "")).padEnd(w + 1)).join(""));
  }
  for (const pat of pats) {
    const n = pat.lengthSteps ?? 16;
    out.push(`PATTERN ${pat.name ?? pat.id} · ${n} steps` + (pat.loop ? ` ⟳${pat.loop.until ? ` until ${pat.loop.until}` : ""}${pat.loop.max ? `, max ${pat.loop.max}` : ""}` : ""));
    const rows = new Map<string, { starts: number[]; keys: Set<number> }>();
    const row = (ch: string) => rows.get(ch) ?? (rows.set(ch, { starts: [], keys: new Set() }), rows.get(ch)!);
    for (const [ch, steps] of Object.entries<number[]>(pat.steps ?? {})) steps.forEach((s, i) => { if (s) { row(ch).starts.push(i); row(ch).keys.add(60); } });
    for (const [ch, ns] of Object.entries<any[]>(pat.notes ?? {})) for (const x of ns) { row(ch).starts.push(Math.floor((pos(x.start) ?? 0) / STEP)); row(ch).keys.add(x.key ?? 60); }
    const lines = [...rows].map(([ch, r]) => {
      const c = p.channels.find((x: any) => x.id === ch);
      const ins = (c?.inputs ?? []).map((i: any) => i.bus).join(",");
      const grid = Array.from({ length: n }, (_, s) => {
        const k = r.starts.filter((x) => x === s).length;
        return (k === 0 ? "·" : k === 1 ? "■" : "■" + "⁰¹²³⁴⁵⁶⁷⁸⁹"[k % 10]) + (s % 4 === 3 && s < n - 1 ? " " : "");
      }).join("");
      const keys = (c?.keymap ?? []).filter((k: any) => r.keys.has(k.key)).map((k: any) =>
        k.schema?.properties ? `${k.name} {${Object.keys(k.schema.properties).join(", ")}}` : k.name).join(" | ");
      return [`${chName(ch)}${ins ? ` ← ${ins}` : ""} → ${c?.output ?? "master"}`, grid, keys];
    });
    const w = Math.max(0, ...lines.map((l) => l[0].length));
    for (const [a, g, k] of lines) out.push(`  ${a.padEnd(w)}  ${g}   ${k}`);
  }
  out.push("MIXER");
  const buses = [...(p.mixer?.buses ?? []), { id: "master", ...(p.mixer?.master ?? {}), sends: [] }];
  const procName = (s: any) => {
    const q = s.params ?? {}, n = s.plugin.replace("fx.", "");
    const arg = s.plugin === "fx.gate" ? q.condition + (q.hold === "pass" ? ", hold" : "") : s.plugin === "fx.limiter" ? `${q.ceiling} ${q.unit ?? "usd"}, ${q.action ?? "block"}` : s.plugin === "fx.validator" ? q.onFail ?? "drop" : "";
    return n[0].toUpperCase() + n.slice(1) + (arg ? `(${arg})` : "");
  };
  const iw = Math.max(...buses.map((b) => b.id.length));
  for (const b of buses) {
    const sends = b.id === "master" ? [] : (b.sends ?? [{ to: "master", mode: "all" }]);
    const parts = [...(b.slots ?? []).map(procName), ...sends.map((s: any) => `→ ${s.to} (${s.mode})`)];
    out.push(`  ${b.id.padEnd(iw)}  ${parts.join(" ")}${b.join === "stream" ? " [stream]" : ""}`.trimEnd());
  }
  return out.join("\n");
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: { json: { type: "boolean" }, arrangement: { type: "string" }, pattern: { type: "string" }, input: { type: "string" }, cache: { type: "string" }, budget: { type: "string" } },
  });
  const file = positionals[0];
  if (!["validate", "render", "score"].includes(cmd) || !file) { console.error(USAGE); process.exit(2); }
  const proj = load(file);
  const errs = validate(proj.p);

  if (cmd === "validate") {
    if (values.json) console.log(JSON.stringify({ ok: !errs.length, errors: errs }, null, 2));
    else if (errs.length) printErrors(errs); else console.log("ok");
    process.exit(errs.length ? 1 : 0);
  }
  if (errs.length) { printErrors(errs); process.exit(1); }
  if (cmd === "score") { console.log(score(proj.p, values.pattern)); return; }

  if (values.cache && !["fresh", "prefer"].includes(values.cache)) { console.error("--cache must be fresh or prefer"); process.exit(2); }
  const r = await render(proj, {
    arrangement: values.arrangement, pattern: values.pattern, cache: values.cache as any,
    input: values.input ? JSON.parse(readFileSync(values.input, "utf8")) : undefined,
    budget: values.budget ? Number(values.budget) : undefined,
  });
  if (values.json) console.log(JSON.stringify(r.master.map((f: any) => ({ id: f.id, source: f.source, text: f.text, json: f.json, meta: f.meta })), null, 2));
  else console.log(r.master.map((f: any) => f.text ?? JSON.stringify(f.json)).join("\n\n"));
  console.error(`passes ${r.passes} · voices run ${r.voicesRun} · cache hits ${r.cacheHits} · cost $${r.costUsd.toFixed(4)} · take ${r.takeId}` + (r.stopped ? ` · STOPPED: ${r.stopped}` : ""));
  process.exit(r.stopped ? 1 : 0);
}

if (import.meta.main) main().catch((e) => { console.error(e.message); process.exit(1); });
