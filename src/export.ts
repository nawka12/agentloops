// Audio export: audio only exists in a browser (Web Audio), so the studio host has a browser render the WAV (ui/main.ts + ui/sound.ts renderWav).
// A connected studio tab gets an SSE `export` event; with no tab (or no answer in 10 s) the host spawns headless Chromium on `/?export=<id>`.
// Either way the bytes come back through POST /api/export/:id and land here.
import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { randomBytes } from "node:crypto";

export const MAX_WAV = 300e6;
const ACK_MS = 10_000;
const BROWSERS = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];

/** First executable called one of `names` on PATH, else null */
export function which(...names: string[]): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) for (const n of names) {
    try { accessSync(join(dir, n), constants.X_OK); return join(dir, n); } catch {}
  }
  return null;
}

/** seconds of audio in a 16-bit PCM WAV, from its header */
export function wavSeconds(b: Buffer): number {
  return b.length < 44 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WAVE" ? NaN : b.readUInt32LE(40) / b.readUInt32LE(28);
}

type Job = { acked: () => void; ok: (b: Buffer | null) => void; bad: (e: Error) => void; stem?: (ch: string, b: Buffer) => void }; // ok(null): every stem has been uploaded
type Req = { arrangement?: string; pattern?: string; stems?: boolean };

/** The studio's export broker. `send(client, type, data)` writes an SSE event to one tab, `last()` is the tab to ask (null: none connected). */
export function exporter(o: { last: () => any; send: (client: any, type: string, data: any) => void; url: () => string }) {
  const jobs = new Map<string, Job>();

  /** `stems`: the browser uploads one WAV per channel to /api/export/:id/stem?ch=<id>, each handed to `stem` as it lands, then ends with {done: true}: `wav` is null */
  async function render(req: Req, c: { signal: AbortSignal; progress: (m: string) => void }, stem?: (ch: string, b: Buffer) => void): Promise<{ wav: Buffer | null; by: "tab" | "headless" }> {
    if (c.signal.aborted) throw new Error("cancelled");
    const id = randomBytes(8).toString("hex"), t0 = Date.now(), tab = o.last();
    let by: "tab" | "headless" = "tab", kill = () => {}, ack!: () => void;
    const acked = new Promise<boolean>((ok) => (ack = () => ok(true)));
    const done = new Promise<Buffer | null>((ok, bad) => jobs.set(id, { acked: ack, ok, bad, stem }));
    done.catch(() => {}); // the race below reports it; this keeps a late rejection from being unhandled
    const cancel = () => { if (tab) try { o.send(tab, "export-cancel", { id }); } catch {} };
    const abort = () => { cancel(); kill(); jobs.get(id)?.bad(new Error("cancelled")); };
    c.signal.addEventListener("abort", abort, { once: true });
    const tick = setInterval(() => c.progress(`rendering… ${Math.round((Date.now() - t0) / 1000)} s (${by})`), 5000);
    try {
      let useTab = false;
      if (tab) {
        o.send(tab, "export", { id, ...req });
        let t: any;
        useTab = await Promise.race([acked, done.then(() => true), new Promise<boolean>((ok) => (t = setTimeout(() => ok(false), ACK_MS)))]);
        clearTimeout(t);
        if (!useTab) cancel(); // the tab never answered: ignore it from here on
      }
      if (!useTab) { by = "headless"; kill = headless(id, req, o.url(), (e) => jobs.get(id)?.bad(e)); }
      return { wav: await done, by };
    } finally {
      clearInterval(tick); c.signal.removeEventListener("abort", abort); jobs.delete(id); kill();
    }
  }

  /** Throwaway headless Chromium on the studio's export page; returns the function that kills it and deletes its profile. ponytail: no sandbox check beyond root */
  function headless(id: string, req: Req, base: string, fail: (e: Error) => void) {
    const bin = which(...BROWSERS);
    if (!bin) { queueMicrotask(() => fail(new Error("no studio tab is open and no headless browser was found: install Chromium (chromium, chromium-browser, google-chrome on PATH), or open the studio in a browser (agentloops studio <file>) and retry"))); return () => {}; }
    const dir = mkdtempSync(join(tmpdir(), "alp-export-")), q = new URLSearchParams({ export: id, ...(req.arrangement ? { arrangement: req.arrangement } : {}), ...(req.pattern ? { pattern: req.pattern } : {}), ...(req.stems ? { stems: "1" } : {}) });
    const args = ["--headless=new", "--disable-gpu", "--mute-audio", "--no-first-run", "--disable-dev-shm-usage", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", `--user-data-dir=${dir}`,
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), `${base}?${q}`];
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], detached: true });
    let err = "", dead = false;
    p.stderr.on("data", (d) => { err = (err + d).slice(-600); });
    p.on("error", (e) => fail(new Error(`cannot start ${bin}: ${e.message}`)));
    p.on("exit", (code) => { dead = true; fail(new Error(`headless browser exited (${code}) before the audio was rendered: ${err.trim().split("\n").pop() ?? ""}`)); }); // a no-op once the job has settled
    return () => {
      if (!dead) try { process.kill(-p.pid!, "SIGKILL"); } catch {}
      setTimeout(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), 300).unref?.();
    };
  }

  return { render, jobs };
}

/**
 * Write the rendered WAV as `out`. mp3: convert with ffmpeg when it is on PATH (title + artist tags), else keep the WAV beside it (`wavOut`).
 * Returns the file written, its format and a note when we fell back. Refusing to overwrite is checked by the caller before rendering.
 */
export async function saveAudio(wav: Buffer, o: { out: string; wavOut: string; format: "mp3" | "wav"; ffmpeg: string | null; title: string; overwrite: boolean; signal: AbortSignal }) {
  if (o.format === "wav" || !o.ffmpeg) {
    writeFileSync(o.wavOut, wav, { flag: o.overwrite ? "w" : "wx" });
    return { file: o.wavOut, format: "wav" as const, bytes: wav.length, ...(o.format === "mp3" ? { note: "ffmpeg is not on PATH, so the WAV was kept; install ffmpeg to get an MP3" } : {}) };
  }
  const dir = mkdtempSync(join(tmpdir(), "alp-export-")), tmp = join(dir, "in.wav");
  try {
    writeFileSync(tmp, wav);
    const args = ["-hide_banner", "-loglevel", "error", o.overwrite ? "-y" : "-n", "-i", tmp, "-vn", "-codec:a", "libmp3lame", "-b:a", "256k", "-metadata", `title=${o.title}`, "-metadata", "artist=AgentLoops", o.out];
    const err = await new Promise<string | null>((ok) => {
      const p = spawn(o.ffmpeg!, args, { stdio: ["ignore", "ignore", "pipe"], signal: o.signal });
      let e = ""; p.stderr.on("data", (d) => { e = (e + d).slice(-600); });
      p.on("error", (x) => ok(x.message)); p.on("exit", (code) => ok(code ? e.trim() || `ffmpeg exited ${code}` : null));
    });
    if (err) throw new Error(`ffmpeg failed: ${err}`);
    return { file: o.out, format: "mp3" as const, bytes: statSync(o.out).size };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
