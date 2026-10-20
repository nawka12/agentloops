#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { harnessFiles, HARNESSES } from "./connect.ts";
import { loadProject, pos, starter, STEP, validate, type Err } from "./project.ts";
import { loggedRender } from "./sync.ts";

const USAGE = `usage:
  agentloops validate <file> [--json]
  agentloops render <file> [--arrangement id] [--pattern id] [--input f.json] [--cache fresh|prefer] [--budget n] [--json]
  agentloops score <file> [--pattern id]
  agentloops mcp [--project <file>] [--scope read|edit|run] [--budget <usd>]   (Studio MCP server on stdio)
  agentloops init [dir] [--harness claude-code|codex|cursor|opencode|other]
  agentloops studio [file] [--port 4870] [--browser] [--no-open]   (local web UI on 127.0.0.1)
      opens in an app window in your default browser if it is Chromium-family (else the first Chromium-family one on PATH; AGENTLOOPS_BROWSER=<path> picks one)
      and quits a few seconds after the window closes;
      --browser uses the default browser instead (quit with Ctrl+C); no file opens the first song in ~/AgentLoops
  agentloops install   (Linux: app-menu entry, icon and *.alp.json file type under $XDG_DATA_HOME)`;

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
  const channels: any[] = p.channels ?? []; // tolerate half-built projects (the Studio MCP calls this mid-edit)
  const chName = (id: string) => channels.find((c: any) => c.id === id)?.name ?? id;
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
      const c = channels.find((x: any) => x.id === ch);
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

/** Create <dir>/song.alp.json plus harness files (see connect.ts). Existing files are skipped, except the AgentLoops SKILL.md (always rewritten). */
function init(dir: string, harness = "other") {
  const song = join(dir, "song.alp.json");
  if (existsSync(song)) console.log(`skipped ${song} (already exists)`);
  else { mkdirSync(dir, { recursive: true }); writeFileSync(song, JSON.stringify(starter(), null, 2) + "\n"); console.log(`created ${song}`); }
  const r = harnessFiles(dir, harness, "song.alp.json");
  for (const f of r.wrote) console.log(`created ${join(dir, f)}`);
  for (const f of r.skipped) console.log(`skipped ${join(dir, f)} (already exists)`);
  console.log(`next: ${r.next}`);
  if (r.snippet) console.log(`\n${r.snippet}`);
}

const BROWSERS = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "brave-browser", "microsoft-edge-stable", "microsoft-edge"];
const MAC_APPS = ["Google Chrome", "Chromium", "Brave Browser", "Microsoft Edge"];
/** first executable named `cmd` on PATH */
export function onPath(cmd: string, path = process.env.PATH ?? ""): string | undefined {
  for (const d of path.split(delimiter)) { const f = join(d, cmd); try { accessSync(f, constants.X_OK); return f; } catch {} }
}
/** Linux default browser's desktop id (e.g. google-chrome.desktop), from xdg-settings; undefined elsewhere or on error */
export function defaultBrowser(): string | undefined {
  if (process.platform !== "linux") return;
  try { return spawnSync("xdg-settings", ["get", "default-web-browser"], { encoding: "utf8" }).stdout.trim() || undefined; } catch { return; }
}
/** A Chromium-family browser for the app window: $AGENTLOOPS_BROWSER, else the default browser if Chromium-family (Linux), else /Applications (macOS), else PATH. `which`, `exists` and `dflt` are injectable for tests. */
export function findBrowser(which: (cmd: string) => string | undefined = onPath, env = process.env, platform = process.platform, exists = existsSync, dflt: () => string | undefined = defaultBrowser): string | undefined {
  if (env.AGENTLOOPS_BROWSER) return env.AGENTLOOPS_BROWSER;
  if (platform === "darwin") return MAC_APPS.map((a) => `/Applications/${a}.app/Contents/MacOS/${a}`).find((f) => exists(f));
  const d = platform === "linux" ? dflt() : undefined; // flatpak exports and native packages both put the binary on PATH under its desktop id
  if (d && /chrom|brave|edge|vivaldi/i.test(d)) { const f = which(d.replace(/\.desktop$/, "")); if (f) return f; }
  for (const b of BROWSERS) { const f = which(b); if (f) return f; }
}

function openDefault(url: string) {
  const [cmd, ...args] = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
/** App window in a running Chromium if one turns up (returns true), else the default browser (false). */
function openWindow(url: string, browserFlag?: boolean): boolean {
  const exe = browserFlag ? undefined : findBrowser();
  if (!exe) { openDefault(url); return false; }
  // detached: if this starts the browser cold, Ctrl+C on the studio must not take the user's whole browser down with it
  spawn(exe, [`--app=${url}`, "--no-first-run", "--no-default-browser-check", "--class=AgentLoops"], { stdio: "ignore", detached: true }).on("error", () => openDefault(url)).unref();
  return true; // the browser usually hands the window to its running process and exits at once
}

/** the first song in ~/AgentLoops; the folder is made the way `init` makes it when it has none */
function homeSong(): string {
  const dir = join(homedir(), "AgentLoops"), first = () => existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".alp.json")).sort()[0] : undefined;
  if (!first()) init(dir);
  return join(dir, first()!);
}

/** Desktop entry Exec argument: quote if it has spaces or reserved characters; escape "`$\ inside, double every backslash, % is a field code */
export const execArg = (a: string) => (/[\s"'`$\\<>~|&;*?#()%]/.test(a) ? `"${a.replace(/(["`$\\])/g, "\\$1")}"` : a).replace(/\\/g, "\\\\").replace(/%/g, "%%");

/** Linux app-menu integration: .desktop entry, icon and a MIME type for *.alp.json under $XDG_DATA_HOME */
function install() {
  if (process.platform !== "linux") { console.log("agentloops install is Linux-only (app-menu entry); nothing to do here"); return; }
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), cli = fileURLToPath(import.meta.url);
  const files: Record<string, string> = {
    "applications/agentloops.desktop": `[Desktop Entry]
Type=Application
Name=AgentLoops
Comment=Studio for multi-agent songs
Exec=${execArg(process.execPath)} ${execArg(cli)} studio %f
Icon=agentloops
MimeType=application/x-agentloops-song;
StartupWMClass=AgentLoops
Terminal=false
Categories=AudioVideo;Audio;Development;
`,
    "mime/packages/agentloops.xml": `<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/x-agentloops-song">
    <comment>AgentLoops song</comment>
    <sub-class-of type="application/json"/>
    <glob pattern="*.alp.json"/>
  </mime-type>
</mime-info>
`,
  };
  const write = (rel: string, put: (f: string) => void) => { const f = join(data, rel); mkdirSync(join(f, ".."), { recursive: true }); put(f); console.log(`wrote ${f}`); };
  for (const [rel, text] of Object.entries(files)) write(rel, (f) => writeFileSync(f, text));
  write("icons/hicolor/scalable/apps/agentloops.svg", (f) => copyFileSync(new URL("../ui/icon.svg", import.meta.url), f));
  spawnSync("update-mime-database", [join(data, "mime")], { stdio: "ignore" }); // either may be missing: the entries still work after the next login
  spawnSync("update-desktop-database", [join(data, "applications")], { stdio: "ignore" });
  console.log(`to remove: rm ${["applications/agentloops.desktop", "icons/hicolor/scalable/apps/agentloops.svg", "mime/packages/agentloops.xml"].map((r) => join(data, r)).join(" ")}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: {
      json: { type: "boolean" }, arrangement: { type: "string" }, pattern: { type: "string" }, input: { type: "string" }, cache: { type: "string" }, budget: { type: "string" },
      project: { type: "string" }, scope: { type: "string" }, harness: { type: "string" }, port: { type: "string" }, "no-open": { type: "boolean" }, browser: { type: "boolean" },
    },
  });
  if (cmd === "mcp") {
    if (values.scope && !["read", "edit", "run"].includes(values.scope)) { console.error("--scope must be read, edit or run"); process.exit(2); }
    const { serve } = await import("./mcp.ts"); // lazy: keeps the other commands from loading the MCP SDK
    return serve({ project: values.project, scope: (values.scope ?? "edit") as any, budget: values.budget ? Number(values.budget) : undefined });
  }
  if (cmd === "init") {
    if (values.harness && values.harness !== "agents-md" && !HARNESSES.some((x) => x.id === values.harness)) { console.error(`--harness must be one of ${HARNESSES.map((x) => x.id).join(", ")}`); process.exit(2); }
    return init(positionals[0] ?? ".", values.harness);
  }
  if (cmd === "install") return install();
  const file = cmd === "studio" ? positionals[0] ?? homeSong() : positionals[0];
  if (cmd === "studio") {
    const { studio } = await import("./studio.ts");
    let appWindow = false; // set once openWindow has launched an app window; only then does closing the window quit
    const s = await studio({ file, port: values.port ? Number(values.port) : 4870, onClosed: () => { if (appWindow) { console.error("agentloops studio: window closed, quitting"); process.exit(0); } } });
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0)); // the exit handler removes .agentloops/studio.json
    console.error(`agentloops studio: ${s.url}  (Ctrl+C to quit)`);
    if (!values["no-open"]) appWindow = openWindow(s.url, values.browser);
    return;
  }
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
  const r = await loggedRender(proj, {
    arrangement: values.arrangement, pattern: values.pattern, cache: values.cache as any,
    input: values.input ? JSON.parse(readFileSync(values.input, "utf8")) : undefined,
    budget: values.budget ? Number(values.budget) : undefined,
  }, "cli");
  if (values.json) console.log(JSON.stringify(r.master.map((f: any) => ({ id: f.id, source: f.source, text: f.text, json: f.json, meta: f.meta })), null, 2));
  else console.log(r.master.map((f: any) => f.text ?? JSON.stringify(f.json)).join("\n\n"));
  console.error(`passes ${r.passes} · voices run ${r.voicesRun} · cache hits ${r.cacheHits} · cost $${r.costUsd.toFixed(4)} · take ${r.takeId}` + (r.stopped ? ` · STOPPED: ${r.stopped}` : ""));
  process.exit(r.stopped ? 1 : 0);
}

if (import.meta.main) main().catch((e) => { console.error(e.message); process.exit(1); });
