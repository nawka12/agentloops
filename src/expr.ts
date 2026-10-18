import { Environment, parse } from "@marcbachmann/cel-js";

// One CEL environment for conditions, until, gates. `bus(name)` is a registered function that
// reads the context of the evaluation in flight (eval is synchronous, so a module variable is safe).
const env = new Environment({ unlistedVariablesAreDyn: true });
let curBus: (name: string) => unknown = () => null;
env.registerFunction("bus(string): dyn", (name: string) => curBus(name));

// `loop` is a reserved identifier in CEL (cel-spec reserved words), so every conforming lib rejects the
// SPEC's `loop.index`. We rename the bare identifier to `lp` before parsing; string literals and
// `.loop` member accesses are left alone.
const fix = (src: string) =>
  src.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?<![.\w])loop\b/g, (_m, q) => q ?? "lp");

/** Syntax check only. Returns an error message or null. */
export function checkExpr(src: string): string | null {
  try { parse(fix(src)); return null; } catch (e: any) { return String(e.message).split("\n")[0]; }
}

// ponytail: runtime errors (missing field, null.json) evaluate to false, silently; add run diagnostics later.
export function evalBool(src: string, ctx: Record<string, any>): boolean {
  try {
    const { bus, loop, ...rest } = ctx;
    curBus = bus ?? (() => null);
    // CEL ints are BigInt in this lib; plain JS numbers are doubles and break `%`.
    const lp = loop && { ...loop, index: BigInt(loop.index), max: loop.max == null ? 0n : BigInt(loop.max) };
    return env.evaluate(fix(src), { ...rest, lp }) === true;
  } catch { return false; }
}

/** `{{a.b.c}}` replacer. Missing -> "", objects -> JSON, input bundles ({text, frames}) -> their text. */
export function renderTemplate(tpl: string, ctx: Record<string, any>): string {
  return tpl.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_m, path: string) => {
    let v: any = ctx;
    for (const k of path.split(".")) v = v?.[k];
    if (v == null) return "";
    if (typeof v === "object") return Array.isArray(v.frames) && typeof v.text === "string" ? v.text : JSON.stringify(v);
    return String(v);
  });
}
