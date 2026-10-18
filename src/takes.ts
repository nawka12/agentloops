import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openTakes(dir: string) {
  mkdirSync(join(dir, ".agentloops"), { recursive: true });
  const db = new DatabaseSync(join(dir, ".agentloops", "takes.sqlite"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, project TEXT, arrangement TEXT, startedAt INTEGER, status TEXT, passes INTEGER, costUsd REAL, cacheMode TEXT);
    CREATE TABLE IF NOT EXISTS voices (id INTEGER PRIMARY KEY, runId TEXT, channel TEXT, note INTEGER, key INTEGER, pass INTEGER, status TEXT, startMs INTEGER, endMs INTEGER, costUsd REAL, cacheKey TEXT, cached INTEGER);
    CREATE TABLE IF NOT EXISTS frames (id INTEGER PRIMARY KEY, runId TEXT, voiceId INTEGER, seq INTEGER, kind TEXT, final INTEGER, role TEXT, text TEXT, json TEXT, meta TEXT);
    CREATE INDEX IF NOT EXISTS voices_key ON voices (cacheKey);
  `);
  const find = db.prepare("SELECT id FROM voices WHERE cacheKey = ? AND status = 'done' ORDER BY id DESC LIMIT 1");
  const framesOf = db.prepare("SELECT kind, final, role, text, json, meta FROM frames WHERE voiceId = ? ORDER BY seq");
  return {
    /** Recorded frames of the latest finished voice with this cache key, or null. */
    findCached(key: string): any[] | null {
      const row = find.get(key) as any;
      if (!row) return null;
      return (framesOf.all(row.id) as any[]).map((r) => ({
        kind: r.kind, final: !!r.final, role: r.role, text: r.text ?? undefined,
        json: r.json == null ? undefined : JSON.parse(r.json), meta: JSON.parse(r.meta),
      }));
    },
    /** Persist the whole run in one transaction. */
    save(run: any) {
      db.exec("BEGIN");
      try {
        db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?)").run(run.id, run.project, run.arrangement ?? null, run.start, run.stopped ? "stopped" : "done", run.pass + 1, run.costUsd, run.cache);
        const iv = db.prepare("INSERT INTO voices (runId, channel, note, key, pass, status, startMs, endMs, costUsd, cacheKey, cached) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
        const ifr = db.prepare("INSERT INTO frames (runId, voiceId, seq, kind, final, role, text, json, meta) VALUES (?,?,?,?,?,?,?,?,?)");
        for (const v of run.voices) {
          const id = iv.run(run.id, v.ch.def.id, v.seq, v.n.key, v.pass, v.status, v.startMs ?? null, v.endMs ?? null, v.costUsd, v.cacheKey ?? null, v.cached ? 1 : 0).lastInsertRowid;
          (v.frames ?? []).forEach((f: any, i: number) =>
            ifr.run(run.id, id, i, f.kind, f.final ? 1 : 0, f.role ?? null, f.text ?? null, f.json === undefined ? null : JSON.stringify(f.json), JSON.stringify(f.meta ?? {})));
        }
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    close: () => db.close(),
  };
}
