// Cross-process sync between `agentloops mcp`, `agentloops studio` and the CLI: atomic project writes,
// a version stamp for reload-before-edit, and the shared append-only event log.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
