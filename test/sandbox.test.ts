// Sandboxed script generators: JSON in/out, timers work, host objects are unreachable, runaway loops time out without wedging the sandbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../src/sandbox.ts";

test("a script computes a value and awaits setTimeout", async () => {
  const r = await runScript("await new Promise((r) => setTimeout(r, 50)); return { sum: ctx.a + ctx.b, list: [1, 2].map((x) => x * 2) };", { a: 1, b: 2 });
  assert.deepEqual(r, { sum: 3, list: [2, 4] });
  assert.equal(await runScript("return;", {}), undefined);
  await assert.rejects(runScript("throw new Error('boom')", {}), /boom/);
  await assert.rejects(runScript("return (", {}), /Unexpected|expected/i);
});

test("process, require, fetch, import() and constructor escapes are all unavailable", async () => {
  const r: any = await runScript(
    `const out = {};
     for (const [k, f] of Object.entries({
       process: () => typeof process, require: () => typeof require, fetch: () => typeof fetch,
       setInterval: () => typeof setInterval, imp: () => import("node:fs"),
       ctor: () => this.constructor.constructor("return process")(),
       fnctor: () => (async () => {}).constructor("return process")(),
       timer: () => setTimeout.constructor("return process")(),
     })) { try { out[k] = await f(); } catch (e) { out[k] = "threw"; } }
     return out;`, {});
  assert.deepEqual(r, { process: "undefined", require: "undefined", fetch: "undefined", setInterval: "undefined", imp: "threw", ctor: "threw", fnctor: "threw", timer: "threw" });
});

test("a runaway loop times out and the next call still works", async () => {
  await assert.rejects(runScript("while (true) {}", {}, { timeoutMs: 300 }), /timed out/);
  await assert.rejects(runScript("await new Promise(() => {}); ", {}, { timeoutMs: 300 }), /timed out/); // never settles: parent kills and respawns
  assert.equal(await runScript("return 1 + 1", {}), 2);
});
