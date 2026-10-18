// Runs song-supplied JS in a long-lived child process: no fs or child processes (Node permission model), and each script gets a fresh vm context
// with no require, process, import or fetch.
// ponytail: Node 24's permission model has no network flag, so a vm escape (a V8 bug) could still reach network modules via process.getBuiltinModule;
// fs and child processes stay denied. Upgrade path: a container or network namespace around the child.
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 30_000; // ponytail: one fixed limit for every script; make it a project setting if a song needs longer
type Call = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
let child: ChildProcess | undefined;
const pending = new Map<number, Call>();
let seq = 0;

// An idle sandbox must not keep the process alive (render, tests); a call in flight must.
const hold = (c: ChildProcess, on: boolean) => { on ? c.ref() : c.unref(); on ? c.channel?.ref() : c.channel?.unref(); };

function spawn(): ChildProcess {
  const path = fileURLToPath(new URL("./sandbox-child.ts", import.meta.url));
  const c = fork(path, [], { execArgv: ["--permission", `--allow-fs-read=${path}`, "--max-old-space-size=256", "--disable-warning=ExperimentalWarning"] });
  c.on("error", () => {});
  c.on("message", (m: { id: number; ok: boolean; out: string }) => {
    const p = settle(m.id);
    if (!p) return;
    if (!m.ok) return p.reject(new Error(m.out));
    try { p.resolve(m.out === "" ? undefined : JSON.parse(m.out)); } catch (e: any) { p.reject(e); }
  });
  c.on("exit", () => { if (child === c) stop("sandbox crashed"); });
  hold(c, false);
  return c;
}

function settle(id: number) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  if (!pending.size && child) hold(child, false);
  return p;
}

/** Kill the child (the next call respawns it) and fail every call still waiting on it. */
function stop(why: string) {
  const c = child;
  child = undefined;
  c?.kill("SIGKILL");
  for (const id of [...pending.keys()]) settle(id)!.reject(new Error(why));
}

/** Run `code` as an async function body with `ctx = data`. Resolves to the returned value as plain JSON data. */
export function runScript(code: string, data: object, opts: { timeoutMs?: number } = {}): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const json = JSON.stringify(data), id = ++seq;
  return new Promise((resolve, reject) => {
    const c = (child ??= spawn());
    const timer = setTimeout(() => {
      settle(id);
      reject(new Error(`script timed out after ${timeoutMs} ms`));
      stop("sandbox restarted");
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    hold(c, true);
    c.send({ id, code, json, timeoutMs });
  });
}
