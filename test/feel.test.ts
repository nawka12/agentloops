// Studio v2a "Feel": pacing, mute/solo, PAT loop until Stop, tempo edits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "../src/engine.ts";
import { validate } from "../src/project.ts";
import { studio } from "../src/studio.ts";
import { wdiff } from "../ui/diff.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "alp-feel-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ch = (id: string, extra: any = {}) => ({ id, name: id, generator: { plugin: "script", params: { code: `return "${id} says hi";` } }, keymap: [{ key: 60, name: "go" }], ...extra });
const song = (chs: any[], pat: any = {}) => ({
  format: "agentloops/1", name: "t", channels: chs,
  patterns: [{ id: "p", lengthSteps: 16, steps: Object.fromEntries(chs.map((c) => [c.id, [1]])), ...pat }],
  arrangements: [{ id: "a", clips: [{ ref: "p", start: "1:01" }] }],
});
const timed = async (p: any, opts: any) => { const t = Date.now(), r = await render({ p, dir: tmp() }, opts); return { ms: Date.now() - t, r }; };

test("pace: a 1-bar pattern at 240 BPM takes >= 900 ms, unpaced < 300 ms, a 2-pass loop >= 1800 ms", async () => {
  const p = song([ch("a")]);
  assert.deepEqual(validate(p), []);
  assert.ok((await timed(p, { pace: 240 })).ms >= 900);
  assert.ok((await timed(p, {})).ms < 300);
  const looped = song([ch("a")], { loop: { max: 2 } }), events: any[] = [];
  const { ms, r } = await timed(looped, { pace: 240, onEvent: (e: any) => events.push(e) });
  assert.equal(r.passes, 2);
  assert.ok(ms >= 1800, `${ms} ms`);
  const b = events.find((e) => e.type === "barrier");
  assert.equal(b.tick, 0); assert.equal(typeof b.at, "number"); // wall clock for the UI's playhead
});

test("mute skips a channel's notes; solo plays only soloed channels", async () => {
  const run = async (chs: any[]) => { const r = await render({ p: song(chs), dir: tmp() }, {}); return { r, said: r.master.map((f: any) => f.text).sort() }; };
  const m = await run([ch("a"), ch("b", { mute: true }), ch("c")]);
  assert.deepEqual(m.said, ["a says hi", "c says hi"]); assert.equal(m.r.skipped, 1);
  const s = await run([ch("a"), ch("b", { solo: true }), ch("c", { mute: false })]);
  assert.deepEqual(s.said, ["b says hi"]); assert.equal(s.r.skipped, 2);
  assert.match(JSON.stringify(validate(song([ch("a", { mute: "yes" })]))), /mute must be true or false/);
});

async function setup(p?: any) {
  const dir = tmp(), file = join(dir, "song.alp.json");
  if (p) writeFileSync(file, JSON.stringify(p)); else copyFileSync(join(root, "examples/p1.alp.json"), file);
  const s = await studio({ file, port: 0 });
  const get = async (path: string) => (await fetch(s.url + path.slice(1))).json() as any;
  const post = async (path: string, body: any = {}) => { const r = await fetch(s.url + path.slice(1), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; };
  /** poll the event log until `pred` holds over it */
  const until = async (pred: (es: any[]) => any, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) { const es = (await get("/api/state")).events, x = pred(es); if (x) return x; }
    throw new Error("timed out waiting on the event log");
  };
  return { s, get, post, until };
}
const runEnd = (es: any[], repeat: number) => es.find((e) => e.type === "run.end" && e.repeat === repeat);

test("PAT play loops until Stop: repeats are separate takes, a studio edit lands on the next repeat, unchanged voices hit the cache", async () => {
  const { s, get, post, until } = await setup(song([ch("a"), ch("b")], { steps: { a: [1] } }));
  try {
    assert.equal((await post("/api/run", { pattern: "p", pace: 1920 })).status, 202); // 1 bar = 125 ms
    assert.equal((await post("/api/run", { pattern: "p" })).status, 409, "a loop is playing");
    await until((es) => es.some((e) => e.type === "run.start" && e.repeat === 2));
    const pi = 0, r = await post("/api/patch", { ops: [{ op: "add", path: `/patterns/${pi}/steps/b`, value: [1] }], summary: "b on" });
    assert.equal(r.status, 200);
    const end3 = await until((es) => runEnd(es, 3));
    const end2 = runEnd((await get("/api/state")).events, 2);
    assert.deepEqual([end2.summary.voicesRun, end2.summary.cacheHits], [0, 1], "repeat 2: a replays from repeat 1");
    assert.deepEqual([end3.summary.voicesRun, end3.summary.cacheHits], [1, 1], "repeat 3: b is new, a still cached");
    const take = await get(`/api/take/${end3.runId}`);
    assert.deepEqual(take.voices.map((v: any) => v.channel).sort(), ["a", "b"]);
    assert.equal((await post("/api/stop")).status, 200);
    await until((es) => { const st = es.filter((e) => e.type === "run.start").length, en = es.filter((e) => e.type === "run.end").length; return st === en; });
    const n = (await get("/api/state")).events.filter((e: any) => e.type === "run.start").length;
    await sleep(400);
    const st = await get("/api/state");
    assert.equal(st.events.filter((e: any) => e.type === "run.start").length, n, "no repeat after Stop");
    assert.equal(st.running, false);
  } finally { await s.close(); }
});

test("tempo: the studio route sets clock.bpm as one studio edit, undo restores it", async () => {
  const { s, get, post } = await setup();
  try {
    assert.equal((await post("/api/tempo", { bpm: 90 })).status, 200);
    const st = await get("/api/state");
    assert.equal(st.project.clock.bpm, 90);
    assert.equal(st.project.clock.ppq, 96, "the rest of clock is kept");
    assert.deepEqual(st.events.findLast((e: any) => e.type === "edit").source, "studio");
    assert.equal((await post("/api/tempo", { bpm: 5 })).status, 400);
    assert.equal((await post("/api/undo")).body.undone.summary, "tempo 90 BPM");
    assert.equal((await get("/api/state")).project.clock.bpm, undefined);
  } finally { await s.close(); }
});

test("Monitor word diff: insertions and deletions on words, the new text's line breaks kept", () => {
  assert.deepEqual(wdiff("a day, and it is not laziness.\n\nFor example", "a day, and most of it is light, watchful dozing.\n\nFor example"), [
    { op: "=", t: "a day, and " }, { op: "+", t: "most of " }, { op: "=", t: "it is " }, { op: "-", t: "not laziness." }, { op: "=", t: " " },
    { op: "+", t: "light, watchful dozing.\n\n" }, { op: "=", t: "For example" }]);
  assert.deepEqual(wdiff("same", "same"), [{ op: "=", t: "same" }]);
  const big = "w ".repeat(600);
  assert.deepEqual(wdiff(big, big + "x"), [{ op: "=", t: big + "x" }], "over the cap: no highlights");
});
