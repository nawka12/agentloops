import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { execArg, findBrowser } from "../src/cli.ts";
import { studio } from "../src/studio.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the manifest and icon are served with their types, behind the Origin guard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alp-app-")), file = join(dir, "p1.alp.json");
  copyFileSync(join(root, "examples/p1.alp.json"), file);
  const s = await studio({ file, port: 0 });
  try {
    const m = await fetch(s.url + "manifest.webmanifest");
    assert.equal(m.headers.get("content-type"), "application/manifest+json");
    const j: any = await m.json();
    assert.equal(j.display, "standalone"); assert.equal(j.icons[0].src, "icon.svg");
    const i = await fetch(s.url + "icon.svg");
    assert.equal(i.headers.get("content-type"), "image/svg+xml");
    assert.match(await i.text(), /^<svg /);
    assert.equal((await fetch(s.url + "icon.svg", { headers: { origin: "http://evil.example" } })).status, 403);
    assert.match(await (await fetch(s.url)).text(), /rel="manifest"/);
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("findBrowser: env override, default browser, PATH order, macOS apps, none", () => {
  const has = (...names: string[]) => (c: string) => (names.includes(c) ? `/bin/${c}` : undefined);
  const none = () => undefined, vivaldi = () => "com.vivaldi.Vivaldi.desktop";
  assert.equal(findBrowser(has("chromium"), { AGENTLOOPS_BROWSER: "/opt/mine" }, "linux", undefined, none), "/opt/mine");
  assert.equal(findBrowser(has("google-chrome", "brave-browser", "chromium-browser"), {}, "linux", undefined, none), "/bin/chromium-browser");
  assert.equal(findBrowser(has("microsoft-edge", "google-chrome-stable"), {}, "linux", undefined, none), "/bin/google-chrome-stable");
  assert.equal(findBrowser(has(), {}, "linux", undefined, none), undefined);
  assert.equal(findBrowser(has("com.vivaldi.Vivaldi", "chromium"), {}, "linux", undefined, vivaldi), "/bin/com.vivaldi.Vivaldi");
  assert.equal(findBrowser(has("chromium"), {}, "linux", undefined, () => "firefox.desktop"), "/bin/chromium");
  assert.equal(findBrowser(has("chromium"), { AGENTLOOPS_BROWSER: "/opt/mine" }, "linux", undefined, vivaldi), "/opt/mine");
  assert.equal(findBrowser(has("chromium"), {}, "darwin", (f) => f === "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", vivaldi), "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
});

test("studio: onClosed fires after the last tab leaves, and a reconnect inside graceMs cancels it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alp-grace-")), file = join(dir, "p1.alp.json");
  copyFileSync(join(root, "examples/p1.alp.json"), file);
  let closed = 0;
  const s = await studio({ file, port: 0, graceMs: 200, onClosed: () => closed++ });
  const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  // open a tab's event stream; reading the first chunk means the server has added this client
  const tab = async () => { const ac = new AbortController(); const r = await fetch(s.url + "api/events", { signal: ac.signal }); await r.body!.getReader().read(); return ac; };
  try {
    (await tab()).abort(); await sleep(100); assert.equal(closed, 0);
    await sleep(400); assert.equal(closed, 1);
    (await tab()).abort(); await sleep(100);
    const t3 = await tab(); await sleep(400); assert.equal(closed, 1);
    t3.abort(); await sleep(400); assert.equal(closed, 2);
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("agentloops install writes the entry, icon and MIME type under XDG_DATA_HOME only", { skip: process.platform !== "linux" }, () => {
  const data = mkdtempSync(join(tmpdir(), "alp-xdg-"));
  try {
    // HOME is redirected too, so nothing can fall back to the real ~/.local/share
    const r = spawnSync(process.execPath, [join(root, "src/cli.ts"), "install"], { env: { ...process.env, XDG_DATA_HOME: data, HOME: data }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const d = readFileSync(join(data, "applications/agentloops.desktop"), "utf8");
    assert.ok(d.includes(`Exec=${execArg(process.execPath)} ${execArg(join(root, "src/cli.ts"))} studio %f\n`), d);
    assert.match(d, /^MimeType=application\/x-agentloops-song;$/m);
    assert.match(d, /^StartupWMClass=AgentLoops$/m); assert.match(d, /^Icon=agentloops$/m);
    const x = readFileSync(join(data, "mime/packages/agentloops.xml"), "utf8");
    assert.match(x, /<glob pattern="\*\.alp\.json"\/>/); assert.match(x, /<sub-class-of type="application\/json"\/>/);
    assert.equal(readFileSync(join(data, "icons/hicolor/scalable/apps/agentloops.svg"), "utf8"), readFileSync(join(root, "ui/icon.svg"), "utf8"));
    assert.match(r.stdout, /to remove: rm /);
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test("execArg quotes paths with spaces and escapes per the desktop entry spec", () => {
  assert.equal(execArg("/usr/bin/node"), "/usr/bin/node");
  assert.equal(execArg("/opt/my apps/node"), '"/opt/my apps/node"');
  assert.equal(execArg('/a b/"c"$d'), '"/a b/\\\\"c\\\\"\\\\$d"');
});
