// Child half of sandbox.ts: runs each script in a fresh vm context, inside a process started with --permission (no fs, no child processes).
import vm from "node:vm";

// speed bump only: Node's permission model has no network flag (see sandbox.ts)
for (const k of ["fetch", "WebSocket", "EventSource"]) delete (globalThis as any)[k];

// Runs inside the context before any user code. Host functions arrive as __ globals, are captured in this closure and deleted, so scripts never reach them
// (a host function's .constructor is the host Function, which leads to process). Only strings and numbers cross back out.
const BOOT = `(() => {
  const g = globalThis, { __set: set, __clear: clear, __done: done, __code: code, __json: json } = g;
  for (const k of ["__set", "__clear", "__done", "__code", "__json"]) delete g[k];
  const { parse, stringify } = JSON, { then } = Promise.prototype, call = Reflect.apply;
  for (const k of ["prepareStackTrace", "stackTraceLimit"]) Object.defineProperty(Error, k, { value: k === "stackTraceLimit" ? 0 : undefined, writable: false, configurable: false }); // no CallSite objects for scripts
  const msg = (e) => { try { return String(e && e.message !== undefined ? e.message : e); } catch { return "script threw"; } };
  g.setTimeout = (f, ms, ...a) => set(() => { try { f(...a); } catch {} }, +ms || 0);
  g.clearTimeout = (id) => { clear(id); };
  const ok = (v) => { try { const s = v === undefined ? "" : stringify(v); done(true, s === undefined ? "" : s); } catch (e) { done(false, "script result is not JSON-able: " + msg(e)); } };
  const bad = (e) => { done(false, msg(e)); };
  try { call(then, new (async () => {}).constructor("ctx", code)(parse(json)), [ok, bad]); } catch (e) { bad(e); }
})()`;

process.on("disconnect", () => process.exit(0));
process.on("message", (m: { id: number; code: string; json: string; timeoutMs: number }) => {
  const reply = (ok: boolean, out: string) => process.send!({ id: m.id, ok, out });
  const timers = new Map<number, NodeJS.Timeout>();
  const stop = () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); };
  let n = 0;
  try {
    const cx: any = vm.createContext(Object.create(null)); // a plain {} sandbox would leak its host Object.prototype through this.constructor
    cx.__set = (cb: () => void, ms: number) => { const id = ++n; timers.set(id, setTimeout(() => { timers.delete(id); cb(); }, ms)); return id; };
    cx.__clear = (id: number) => { clearTimeout(timers.get(id)); timers.delete(id); };
    cx.__done = (ok: boolean, out: string) => { stop(); reply(ok, String(out)); };
    cx.__code = m.code;
    cx.__json = m.json;
    vm.runInContext(BOOT, cx, { timeout: m.timeoutMs });
  } catch (e: any) {
    stop();
    reply(false, e?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" ? `script timed out after ${m.timeoutMs} ms` : String(e?.message ?? e));
  }
});
