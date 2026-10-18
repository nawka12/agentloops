import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "../src/engine.ts";
import { validate } from "../src/project.ts";

const p1 = () => JSON.parse(readFileSync(new URL("../examples/p1.alp.json", import.meta.url), "utf8"));
const tmp = () => mkdtempSync(join(tmpdir(), "alp-"));

test("P1 renders in 3 passes; Master gets exactly the approved pass-3 draft", async () => {
  const proj = { p: p1(), dir: tmp() };
  assert.deepEqual(validate(proj.p), []);
  const r = await render(proj, { input: { topic: "CRDTs" } });
  assert.equal(r.passes, 3);
  assert.equal(r.master.length, 1);
  assert.match(r.master[0].text, /^Revision \(pass 3\)/);
  assert.equal(r.voicesRun, 6); // writer + critic x 3 passes
  assert.equal(r.stopped, null);
});

test("a second render with cache prefer runs 0 fresh voices at cost 0", async () => {
  const proj = { p: p1(), dir: tmp() };
  const r1 = await render(proj, { input: { topic: "CRDTs" } });
  const r2 = await render(proj, { input: { topic: "CRDTs" }, cache: "prefer" });
  assert.equal(r2.voicesRun, 0);
  assert.equal(r2.cacheHits, 6);
  assert.equal(r2.costUsd, 0);
  assert.equal(r2.master.length, 1);
  assert.equal(r2.master[0].text, r1.master[0].text);
  // a different trigger payload must not hit the cache
  assert.equal((await render(proj, { input: { topic: "other" }, cache: "prefer" })).cacheHits, 0);
});

test("validate reports a bus send cycle with a JSON Pointer path", () => {
  const p = p1();
  p.mixer.buses[2].sends.push({ to: "draft", mode: "all" }); // final -> draft -> final
  const errs = validate(p);
  const cyc = errs.find((e) => /cycle/i.test(e.message));
  assert.ok(cyc, JSON.stringify(errs));
  assert.match(cyc.path, /^\/mixer\/buses\/\d+\/sends\/\d+$/);
  assert.ok(cyc.fix);

  const q = p1();
  q.patterns[0].notes.critic[0].start = "0:00";
  q.patterns[0].notes.critic[0].key = 99;
  const paths = validate(q).map((e) => e.path);
  assert.ok(paths.includes("/patterns/0/notes/critic/0/start"));
  assert.ok(paths.includes("/patterns/0/notes/critic/0/key"));
});

test("a 3-note chord runs 3 voices concurrently; the next note waits for all of them", async () => {
  // scripts are sandboxed (no shared globals), so concurrency is read off the wall-clock intervals they report
  const ch = (id: string, code: string, keys: number[]) => ({
    id, name: id, generator: { plugin: "script", params: { code } },
    keymap: keys.map((key) => ({ key, name: `k${key}`, template: "x" })), inputs: [], polyphony: 4,
  });
  const chord = "const s = Date.now(); await new Promise(r => setTimeout(r, 30 + ctx.note.key)); return { json: { chord: [s, Date.now()] } };";
  const second = "return { json: { next: Date.now() } };";
  const p = {
    format: "agentloops/1", name: "chord",
    channels: [ch("a", chord, [60, 62, 64]), ch("b", second, [60])],
    patterns: [{ id: "p", notes: {
      a: [60, 62, 64].map((key) => ({ start: 0, len: 96, key })),
      b: [{ start: 96, len: 96, key: 60 }] } }],
    arrangements: [{ id: "m", clips: [{ ref: "p", start: 0, len: 384 }] }],
  };
  assert.deepEqual(validate(p), []);
  const r = await render({ p, dir: tmp() });
  const chords = r.master.map((f: any) => f.json?.chord).filter(Boolean) as number[][], next = r.master.map((f: any) => f.json?.next).find(Boolean) as number;
  assert.equal(chords.length, 3);
  assert.ok(Math.max(...chords.map((c) => c[0])) < Math.min(...chords.map((c) => c[1]))); // all three were running at once
  assert.ok(next >= Math.max(...chords.map((c) => c[1]))); // the next note started after all of them finished
  assert.equal(r.voicesRun, 4);
  assert.equal(r.master.length, 4); // unrouted channels go to Master
});

test("a validator retry's valid output is what the take records and the cache replays", async () => {
  const p = {
    format: "agentloops/1", name: "retry",
    channels: [{ id: "c", name: "c", output: "review", retries: 1, inputs: [],
      generator: { plugin: "script", params: { code: "return ctx.attempt === 1 ? { json: {} } : { json: { approved: true } };" } },
      keymap: [{ key: 60, name: "k", template: "x" }] }],
    patterns: [{ id: "p", notes: { c: [{ start: 0, len: 96, key: 60 }] } }],
    arrangements: [{ id: "m", clips: [{ ref: "p", start: 0, len: 384 }] }],
    mixer: { buses: [{ id: "review", name: "review", slots: [{ plugin: "fx.validator", params: { onFail: "retry", schema: { type: "object", required: ["approved"] } } }] }] },
  };
  assert.deepEqual(validate(p), []);
  const proj = { p, dir: tmp() };
  const r1 = await render(proj);
  assert.deepEqual(r1.master[0].json, { approved: true });
  const r2 = await render(proj, { cache: "prefer" });
  assert.equal(r2.voicesRun, 0); // replayed the valid retry output, no fresh generation
  assert.equal(r2.cacheHits, 1);
  assert.deepEqual(r2.master[0].json, { approved: true });
});
