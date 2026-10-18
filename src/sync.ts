// Cross-process sync between `agentloops mcp`, `agentloops studio` and the CLI: atomic project writes,
// a version stamp for reload-before-edit, and the shared append-only event log.
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { render, type RunOpts } from "./engine.ts";

/** mtime + inode: atomic renames change the inode, so same-millisecond writes still differ. null if missing. */
export const version = (file: string) => { try { const s = statSync(file); return `${s.mtimeMs}:${s.ino}`; } catch { return null; } };

/** Write pretty JSON via tmp + rename so a watcher in another process never reads half a file. Returns the new version. */
export function writeJson(file: string, p: any) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n");
  renameSync(tmp, file);
  return version(file);
}

/** Reload `s.p` from disk if the file changed since `s.ver` (another process edited it). Keeps the old copy on a parse error. */
export function refresh(s: { file: string; p: any; ver?: string | null }) {
  const v = version(s.file);
  if (v && v !== s.ver) try { s.p = JSON.parse(readFileSync(s.file, "utf8")); s.ver = v; } catch {}
  return s;
}

export const eventsFile = (dir: string) => join(dir, ".agentloops", "events.jsonl");
/** Append one event line. ponytail: no rotation; the log grows until someone deletes it. */
export function appendEvent(dir: string, e: object) {
  mkdirSync(join(dir, ".agentloops"), { recursive: true });
  appendFileSync(eventsFile(dir), JSON.stringify({ ...e, at: Date.now() }) + "\n");
}

/** `agentloops studio` publishes {port, token, pid, file} here (mode 0600) while it runs; `agentloops mcp` relays to it. */
export const studioFile = (dir: string) => join(dir, ".agentloops", "studio.json");
/** The live studio hosting `file`, or null. A studio.json whose pid is dead is deleted. ponytail: a reused pid looks alive; the failed connection then deletes it. */
export function findStudio(file: string): { port: number; token: string; pid: number; file: string } | null {
  const f = studioFile(dirname(file));
  try {
    const i = JSON.parse(readFileSync(f, "utf8"));
    if (resolve(i.file) !== file) return null; // another project's studio, same folder
    try { process.kill(i.pid, 0); } catch (e: any) { if (e.code !== "EPERM") { rmSync(f, { force: true }); return null; } }
    return i;
  } catch { return null; }
}

/** render() that logs run.start, every engine event, and run.end (with the result summary) to the event log. */
export async function loggedRender(proj: { p: any; dir: string }, opts: RunOpts, source: string) {
  const runId = opts.runId ?? randomUUID().slice(0, 8);
  const log = (e: object) => { try { appendEvent(proj.dir, { ...e, runId, source }); } catch {} };
  log({ type: "run.start", pattern: opts.pattern, arrangement: opts.arrangement, budget: opts.budget ?? proj.p.budgets?.runUsd });
  try {
    const r = await render(proj, { ...opts, runId, onEvent: (e) => { log(e); opts.onEvent?.(e); } });
    log({ type: "run.end", summary: { takeId: r.takeId, passes: r.passes, costUsd: r.costUsd, stopped: r.stopped, voicesRun: r.voicesRun, cacheHits: r.cacheHits, skipped: r.skipped, buses: r.buses } });
    return r;
  } catch (e: any) { log({ type: "run.end", error: e.message }); throw e; }
}
