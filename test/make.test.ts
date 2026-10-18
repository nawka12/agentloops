// Studio v2b "Make music": song switching, demo copies, presets, the loop spend cap, stop after N repeats, starter on a missing file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../src/project.ts";
import { studio } from "../src/studio.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "alp-make-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const song = (code: string, extra: any = {}) => ({
  format: "agentloops/1", name: "t", ...extra,
  channels: [{ id: "a", name: "A", generator: { plugin: "script", params: { code } }, keymap: [{ key: 60, name: "go" }] }],
  patterns: [{ id: "p", lengthSteps: 16, steps: { a: [1] } }],
  arrangements: [{ id: "m", clips: [{ ref: "p", start: "1:01" }] }],
});

async function setup(p?: any, name = "song.alp.json") {
  const dir = tmp(), file = join(dir, name);
  if (p) writeFileSync(file, JSON.stringify(p));
  const s = await studio({ file, port: 0 });
  const get = async (path: string) => (await fetch(s.url + path.slice(1))).json() as any;
  const post = async (path: string, body: any = {}) => { const r = await fetch(s.url + path.slice(1), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; };
  const until = async (pred: (st: any) => any, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) { const st = await get("/api/state"), x = pred(st); if (x) return x; }
    throw new Error("timed out");
  };
  return { dir, file, s, get, post, until };
}
const studioJson = (dir: string) => JSON.parse(readFileSync(join(dir, ".agentloops/studio.json"), "utf8"));

test("studio on a missing file creates a valid starter song", async () => {
  const { file, s, get } = await setup(undefined, "fresh.alp.json");
  try {
    assert.ok(existsSync(file));
    const st = await get("/api/state");
    assert.equal(st.project.name, "fresh");
    assert.deepEqual(st.errors, []);
  } finally { await s.close(); }
});

test("Browser: opening a local song rewrites studio.json and resets undo; a demo is copied, never clobbering", async () => {
  const { dir, s, get, post } = await setup(song("return 'x';"));
  try {
    writeFileSync(join(dir, "other.alp.json"), JSON.stringify({ ...song("return 'y';"), name: "Other" }));
    assert.equal((await post("/api/tempo", { bpm: 90 })).status, 200); // one undo step on song.alp.json
    const list = await get("/api/songs");
    assert.deepEqual(list.local.map((x: any) => x.name), ["Other", "t"]);
    assert.ok(list.demos.some((x: any) => x.file === "p1.alp.json"));

    assert.equal((await post("/api/open", { file: "other.alp.json" })).status, 200);
    assert.equal(studioJson(dir).file, join(dir, "other.alp.json"));
    assert.equal((await get("/api/state")).project.name, "Other");
    assert.equal((await post("/api/undo")).status, 400, "the undo stack was reset");
    assert.equal((await post("/api/open", { file: "../etc.alp.json" })).status, 400);

    const demo = readFileSync(join(root, "examples/p1.alp.json"), "utf8");
    writeFileSync(join(dir, "p1.alp.json"), "{\"name\": \"mine\"}"); // a user file with the demo's name
    assert.equal((await post("/api/open", { demo: "p1.alp.json" })).body.file, "p1-2.alp.json");
    assert.equal(readFileSync(join(dir, "p1.alp.json"), "utf8"), "{\"name\": \"mine\"}", "not clobbered");
    assert.equal(readFileSync(join(dir, "p1-2.alp.json"), "utf8"), demo);
    assert.equal((await post("/api/open", { demo: "p1.alp.json" })).body.file, "p1-3.alp.json");
    assert.equal(studioJson(dir).file, join(dir, "p1-3.alp.json"));
    await post("/api/tempo", { bpm: 100 });
    assert.equal(readFileSync(join(root, "examples/p1.alp.json"), "utf8"), demo, "the bundled demo is never edited");
    assert.ok((await get("/api/state")).events.some((e: any) => e.type === "song.open" && e.file === "p1-3.alp.json"));
  } finally { await s.close(); }
});

test("presets are valid channels", async () => {
  const dir = join(root, "presets"), files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 6);
  for (const f of files) {
    const pr = JSON.parse(readFileSync(join(dir, f), "utf8"));
    assert.ok(pr.name && pr.description && typeof pr.needsKey === "boolean", f);
    const p = { format: "agentloops/1", channels: [{ id: "x", name: pr.name, ...pr.channel, output: "x" }], mixer: { buses: [{ id: "x", name: pr.name }] },
      patterns: [{ id: "p", steps: { x: [1] } }], arrangements: [{ id: "a", clips: [{ ref: "p" }] }] };
    assert.deepEqual(validate(p), [], f);
  }
});

test("the loop spend cap stops a PAT loop", async () => {
  const { s, post, until } = await setup(song("return { text: 'paid', meta: { costUsd: 0.3 } };"));
  try {
    assert.equal((await post("/api/run", { pattern: "p", capUsd: 1, cache: "fresh" })).status, 202);
    const lp = await until((st) => st.loop && !st.loop.running && st.loop);
    assert.match(lp.reason, /spend cap reached/);
    assert.ok(lp.spentUsd >= 1 && lp.spentUsd < 1.3, `${lp.spentUsd}`);
    assert.equal(lp.repeat, 4, "0.3 x 3 = 0.9 < 1, the 4th repeat crosses the cap");
  } finally { await s.close(); }
});

test("the default loop cap is 3 x budgets.runUsd", async () => {
  const { s, post, until } = await setup(song("return { text: 'paid', meta: { costUsd: 0.25 } };", { budgets: { runUsd: 0.2 } }));
  try {
    await post("/api/run", { pattern: "p", cache: "fresh" });
    const lp = await until((st) => st.loop && !st.loop.running && st.loop);
    assert.ok(Math.abs(lp.capUsd - 0.6) < 1e-9);
    assert.match(lp.reason, /spend cap reached/);
  } finally { await s.close(); }
});

test("stop after N repeats", async () => {
  const { s, get, post, until } = await setup(song("return 'free';"));
  try {
    assert.equal((await post("/api/run", { pattern: "p", repeats: 3 })).status, 202);
    const lp = await until((st) => st.loop && !st.loop.running && st.loop);
    assert.equal(lp.reason, "played 3 repeats");
    const st = await get("/api/state");
    assert.equal(st.events.filter((e: any) => e.type === "run.end").length, 3);
    assert.equal(st.running, false);
  } finally { await s.close(); }
});

test("routing that would create a cycle is refused with the validate message", async () => {
  const p = { ...song("return 'x';"), mixer: { buses: [{ id: "b1", sends: [{ to: "b2", mode: "all" }] }, { id: "b2" }] } };
  const { s, post } = await setup(p);
  try {
    const r = await post("/api/patch", { ops: [{ op: "add", path: "/mixer/buses/1/sends", value: [{ to: "b1", mode: "all" }] }], summary: "send", refuse: "cycle" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Bus send cycle: b1 -> b2 -> b1|Bus send cycle/);
    assert.equal((await post("/api/patch", { ops: [{ op: "add", path: "/mixer/buses/1/sends", value: [{ to: "master", mode: "final" }] }], summary: "send", refuse: "cycle" })).status, 200);
  } finally { await s.close(); }
});
