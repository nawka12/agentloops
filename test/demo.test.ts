// examples/demo.alp.json: an article workshop that means something without an API key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "../src/engine.ts";
import { loadProject, MANUAL, validate } from "../src/project.ts";

test("demo: the Critic approves on pass 3 with title, example and conclusion; the Editor polishes it; a cached re-render is free", async () => {
  const proj = { p: loadProject(new URL("../examples/demo.alp.json", import.meta.url).pathname).p, dir: mkdtempSync(join(tmpdir(), "alp-demo-")) };
  assert.deepEqual(validate(proj.p), []);
  const events: any[] = [], r = await render(proj, { onEvent: (e) => events.push(e) });
  assert.equal(r.stopped, null);
  assert.equal(r.passes, 3);
  const verdicts = events.filter((e) => e.type === "frame" && e.bus === "review").map((e) => e.json);
  assert.deepEqual(verdicts.map((v) => v.missing), [["an example", "a conclusion"], ["a conclusion"], []]);
  assert.equal(verdicts.at(-1).approved, true);
  const [article, edited] = r.master.map((f: any) => f.text);
  assert.match(article, /^# Why cats sleep so much\n\nCats sleep[^\n]*\n\nFor example,[^\n]*\n\nIn short,/);
  assert.match(edited, /^WHY CATS SLEEP SO MUCH\n[\s\S]*In brief:\n• Cats sleep/);
  const again = await render(proj, { cache: "prefer" });
  assert.deepEqual([again.costUsd, again.voicesRun, again.cacheHits], [0, 0, r.voicesRun]);
  assert.equal(again.master[1].text, edited);
});

test("music: the manual's one-bar drop and the kawaii bass song validate and play; only the lyric sheet reaches Master", async () => {
  const blocks = [...MANUAL.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
  const bar = blocks.find((b) => b.name === "One bar of kawaii bass");
  assert.ok(bar, "the manual has its music example");
  assert.deepEqual(validate(bar), []);
  const r1 = await render({ p: bar, dir: mkdtempSync(join(tmpdir(), "alp-")) });
  assert.equal(r1.voicesRun, 26);
  assert.equal(r1.master.length, 0); // instruments go to a bus that sends nowhere
  const song = loadProject(new URL("../examples/kawaii-bass.alp.json", import.meta.url).pathname).p;
  assert.deepEqual(validate(song), []);
  const r2 = await render({ p: song, dir: mkdtempSync(join(tmpdir(), "alp-")) });
  assert.equal(r2.stopped, null);
  assert.deepEqual(r2.master.map((f: any) => f.text).slice(0, 4), ["♪ ne-e~♪ ♪", "♪ a-no-ne♪ ki-i-te! ♪", "♪ a-no-ne♪ ki-i-te! ♪", "♪ san! ni! i-chi! ♪"]);
  assert.equal(r2.master.at(-1).text, "♪ ba-i ba-i~♡ ♪");
});
