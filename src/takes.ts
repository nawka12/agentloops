import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const parseFrames = (rows: any[]) => rows.map((r) => ({ text: r.text ?? undefined, json: r.json == null ? undefined : JSON.parse(r.json), meta: JSON.parse(r.meta) }));

export function openTakes(dir: string) {
  mkdirSync(join(dir, ".agentloops"), { recursive: true });
  const db = new DatabaseSync(join(dir, ".agentloops", "takes.sqlite"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, project TEXT, arrangement TEXT, startedAt INTEGER, status TEXT, passes INTEGER, costUsd REAL, cacheMode TEXT);
    CREATE TABLE IF NOT EXISTS voices (id INTEGER PRIMARY KEY, runId TEXT, channel TEXT, note INTEGER, key INTEGER, pass INTEGER, status TEXT, startMs INTEGER, endMs INTEGER, costUsd REAL, cacheKey TEXT, cached INTEGER);
    CREATE TABLE IF NOT EXISTS frames (id INTEGER PRIMARY KEY, runId TEXT, voiceId INTEGER, seq INTEGER, kind TEXT, final INTEGER, role TEXT, text TEXT, json TEXT, meta TEXT);
    CREATE INDEX IF NOT EXISTS voices_key ON voices (cacheKey);
    CREATE TABLE IF NOT EXISTS master (runId TEXT, seq INTEGER, text TEXT, json TEXT, meta TEXT);
  `);
  // ponytail: additive migrations by try/ALTER; switch to PRAGMA user_version if the schema keeps growing
  for (const [t, c] of [["runs", "stopped TEXT"], ["voices", "bus TEXT"], ["frames", "trust TEXT"]]) try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c}`); } catch {}
  const find = db.prepare("SELECT id FROM voices WHERE cacheKey = ? AND status = 'done' ORDER BY id DESC LIMIT 1");
  const framesOf = db.prepare("SELECT kind, final, role, text, json, meta, trust FROM frames WHERE voiceId = ? ORDER BY seq");
  return {
    /** Recorded frames of the latest finished voice with this cache key, or null. */
    findCached(key: string): any[] | null {
      const row = find.get(key) as any;
      if (!row) return null;
      return (framesOf.all(row.id) as any[]).map((r) => ({
        kind: r.kind, final: !!r.final, role: r.role, trust: r.trust ?? "trusted", text: r.text ?? undefined,
        json: r.json == null ? undefined : JSON.parse(r.json), meta: JSON.parse(r.meta),
      }));
    },
    /** Persist the whole run (plus the Master final frames) in one transaction. */
    save(run: any, master: any[] = []) {
      db.exec("BEGIN");
      try {
        db.prepare("INSERT INTO runs (id, project, arrangement, startedAt, status, passes, costUsd, cacheMode, stopped) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(run.id, run.project, run.arrangement ?? null, run.start, run.stopped ? "stopped" : "done", run.pass + 1, run.costUsd, run.cache, run.stopped ?? null);
        const iv = db.prepare("INSERT INTO voices (runId, channel, note, key, pass, status, startMs, endMs, costUsd, cacheKey, cached, bus) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
        const ifr = db.prepare("INSERT INTO frames (runId, voiceId, seq, kind, final, role, text, json, meta, trust) VALUES (?,?,?,?,?,?,?,?,?,?)");
        for (const v of run.voices) {
          const id = iv.run(run.id, v.ch.def.id, v.seq, v.n.key, v.pass, v.status, v.startMs ?? null, v.endMs ?? null, v.costUsd, v.cacheKey ?? null, v.cached ? 1 : 0, v.ch.def.output ?? "master").lastInsertRowid;
          (v.frames ?? []).forEach((f: any, i: number) =>
            ifr.run(run.id, id, i, f.kind, f.final ? 1 : 0, f.role ?? null, f.text ?? null, f.json === undefined ? null : JSON.stringify(f.json), JSON.stringify(f.meta ?? {}), f.trust ?? "trusted"));
        }
        master.forEach((f, i) => db.prepare("INSERT INTO master VALUES (?,?,?,?,?)").run(run.id, i, f.text ?? null, f.json === undefined ? null : JSON.stringify(f.json), JSON.stringify(f.meta ?? {})));
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    /** Most recent runs first. */
    list(limit = 20): any[] {
      return db.prepare("SELECT id, project, arrangement, startedAt, status, stopped, passes, costUsd, cacheMode FROM runs ORDER BY startedAt DESC, rowid DESC LIMIT ?").all(limit);
    },
    /** One run: its row, its Master final frames and a compact line per voice. Null if unknown. */
    get(id: string): any | null {
      const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as any;
      if (!run) return null;
      const last = db.prepare("SELECT kind, text, json FROM frames WHERE voiceId = ? ORDER BY seq DESC LIMIT 1");
      const voices = (db.prepare("SELECT id, channel, key, pass, status, costUsd, cached, bus FROM voices WHERE runId = ? AND status != 'skipped' ORDER BY note").all(id) as any[]).map((v) => {
        const f = last.get(v.id) as any;
        return { channel: v.channel, key: v.key, pass: v.pass, status: v.status, costUsd: v.costUsd, cached: !!v.cached, bus: v.bus, kind: f?.kind, text: f?.text ?? f?.json ?? undefined };
      });
      return { run, voices, master: parseFrames(db.prepare("SELECT text, json, meta FROM master WHERE runId = ? ORDER BY seq").all(id)) };
    },
    /** Raw frames of a run, optionally filtered by bus (the voice's output bus), channel, kind or pass. */
    frames(id: string, f: { bus?: string; channel?: string; kind?: string; pass?: number } = {}): any[] {
      const where = ["fr.runId = ?"], args: any[] = [id];
      for (const [col, val] of [["v.bus", f.bus], ["v.channel", f.channel], ["fr.kind", f.kind], ["v.pass", f.pass]] as const)
        if (val != null) { where.push(`${col} = ?`); args.push(val); }
      const rows = db.prepare(`SELECT v.channel, v.bus, v.pass, fr.seq, fr.kind, fr.final, fr.text, fr.json, fr.meta, fr.trust FROM frames fr JOIN voices v ON v.id = fr.voiceId WHERE ${where.join(" AND ")} ORDER BY v.note, fr.seq`).all(...args) as any[];
      return rows.map((r) => ({ channel: r.channel, bus: r.bus, pass: r.pass, kind: r.kind, final: !!r.final, trust: r.trust, ...parseFrames([r])[0] }));
    },
    close: () => db.close(),
  };
}
