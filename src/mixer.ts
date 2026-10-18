import { evalBool, renderTemplate } from "./expr.ts";

export class RunStop extends Error {}

/** The CEL-visible shape of a frame. */
export const celFrame = (f: any) => ({ text: f.text ?? "", json: f.json ?? null, final: !!f.final, kind: f.kind, source: f.source ?? {}, meta: f.meta ?? {} });
const celSide = (b: any) => ({ last: b.side.last ? celFrame(b.side.last) : null, frames: b.side.frames.map(celFrame) });

// Handwritten JSON Schema subset: type, required, properties. Returns an error message or null.
export function checkSchema(schema: any, v: any, path = "$"): string | null {
  const t = schema.type;
  if (t) {
    const ok: Record<string, boolean> = {
      object: !!v && typeof v === "object" && !Array.isArray(v), array: Array.isArray(v), string: typeof v === "string",
      number: typeof v === "number", integer: Number.isInteger(v), boolean: typeof v === "boolean", null: v === null,
    };
    if (!ok[t]) return `${path}: expected ${t}`;
  }
  for (const k of schema.required ?? []) if (v?.[k] === undefined) return `${path}.${k}: required`;
  for (const [k, s] of Object.entries<any>(schema.properties ?? {}))
    if (v?.[k] !== undefined) { const e = checkSchema(s, v[k], `${path}.${k}`); if (e) return e; }
  return null;
}

/** Bus graph + processor chains. `run` supplies ctx(extra) for expressions. */
export function createMixer(p: any, run: any) {
  const defs = [...(p.mixer?.buses ?? []), { ...(p.mixer?.master ?? {}), id: "master", sends: [] }];
  const buses: Record<string, any> = {};
  for (const d of defs)
    buses[d.id] = {
      id: d.id, join: d.join ?? "aligned",
      sends: d.sends ?? [{ to: "master", mode: "all" }], // no `sends` field -> all to Master; [] -> nowhere
      slots: (d.slots ?? []).map((s: any) => ({ plugin: s.plugin, params: s.params ?? {}, held: [] as any[], used: 0 })),
      pending: [] as any[], sideIn: [] as any[], side: { last: null as any, frames: [] as any[] }, emitted: [] as any[],
    };
  // topological order (sources first); the graph is validated acyclic
  const order: string[] = [], seen = new Set<string>();
  const visit = (id: string) => { if (seen.has(id)) return; seen.add(id); buses[id].sends.forEach((s: any) => visit(s.to)); order.unshift(id); };
  Object.keys(buses).forEach(visit);

  const cond = (s: any, f: any, b: any) => evalBool(s.params.condition ?? "true", run.ctx({ frame: celFrame(f), side: celSide(b) }));

  const procs: Record<string, (f: any, b: any, s: any) => Promise<any[]>> = {
    "fx.gate": async (f, b, s) => {
      if (cond(s, f, b)) return [f];
      if (s.params.hold === "pass") s.held.push(f);
      return [];
    },
    "fx.formatter": async (f, b, s) => [{ ...f, text: renderTemplate(s.params.template, { frame: celFrame(f), side: celSide(b) }) }],
    "fx.limiter": async (f, _b, s) => {
      const cost = s.params.unit === "tokens" ? (f.meta?.tokensIn ?? 0) + (f.meta?.tokensOut ?? 0) : f.meta?.costUsd ?? 0;
      if (s.used + cost > s.params.ceiling) {
        if (s.params.action === "stop") throw new RunStop(`limiter ceiling ${s.params.ceiling} ${s.params.unit ?? "usd"} reached`);
        return [];
      }
      s.used += cost;
      return [f];
    },
    "fx.validator": async (f, _b, s) => {
      if (!f.final || !s.params.schema) return [f];
      const mode = s.params.onFail ?? "drop";
      for (let cur = f; ; ) {
        const bad = checkSchema(s.params.schema, cur.json);
        if (!bad) return [cur];
        if (mode === "drop") return [];
        if (mode === "retry") { const nf = await cur._v?.retry(); if (nf) { cur = nf; continue; } }
        await cur._v?.fail(new Error(`validator: ${bad}`)); // throws RunStop unless the channel has onFail: skip
        return [];
      }
    },
  };

  async function runFrom(b: any, i: number, frames: any[]) {
    for (; i < b.slots.length && frames.length; i++) {
      const next: any[] = [];
      for (const f of frames) next.push(...(await procs[b.slots[i].plugin](f, b, b.slots[i])));
      frames = next;
    }
    await emit(b, frames);
  }

  async function emit(b: any, frames: any[]) {
    b.emitted.push(...frames);
    for (const s of b.sends)
      for (const f of frames)
        if (s.mode !== "final" || f.final) await receive(f, s.to, s.mode === "sidechain");
  }

  async function flushBus(b: any) {
    for (const sf of b.sideIn.splice(0)) { b.side.last = sf; b.side.frames.push(sf); }
    // re-check held frames (new sidechain frame or barrier); released frames continue after their gate
    for (let i = 0; i < b.slots.length; i++) {
      const s = b.slots[i];
      if (s.plugin !== "fx.gate" || !s.held.length) continue;
      const held = s.held.splice(0), rel: any[] = [];
      for (const h of held) (cond(s, h, b) ? rel : s.held).push(h);
      if (rel.length) await runFrom(b, i + 1, rel);
    }
    const frames = b.pending.splice(0).sort((x: any, y: any) => x.ord - y.ord);
    if (frames.length) await runFrom(b, 0, frames);
  }

  async function receive(f: any, id: string, side = false) {
    const b = buses[id];
    if (side) { b.sideIn.push(f); if (b.join === "stream") await flushBus(b); }
    else if (b.join === "aligned") b.pending.push(f);
    else await runFrom(b, 0, [f]);
  }

  return {
    buses, receive,
    /** barrier flush: aligned buses emit in (channel, note) order, upstream buses first */
    async flushAll() { for (const id of order) await flushBus(buses[id]); },
    /** end of a loop pass / run: frames still held by gates are dropped, sidechain state resets */
    endPass() {
      for (const b of Object.values(buses)) {
        b.slots.forEach((s: any) => (s.held = []));
        b.side = { last: null, frames: [] };
      }
    },
    /** bus(name) as CEL sees it */
    view(name: string) {
      const b = buses[name];
      if (!b) return null;
      return { last: b.emitted.length ? celFrame(b.emitted.at(-1)) : null, frames: b.emitted.filter((f: any) => f.pass === run.pass).map(celFrame) };
    },
  };
}
