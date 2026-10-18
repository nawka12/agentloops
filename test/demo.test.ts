// examples/demo.alp.json: an article workshop that means something without an API key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "../src/engine.ts";
import { loadProject, validate } from "../src/project.ts";

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
