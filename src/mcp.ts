// `agentloops mcp`: the MCP protocol layer. Tools live in host.ts; each call is relayed to an open studio that hosts the same project file,
// or run on this process's own (headless) host.
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createHost, RANK, type Ctx } from "./host.ts";
import { MANUAL } from "./project.ts";
import { findStudio, studioFile } from "./sync.ts";

const INSTRUCTIONS = `Read the agentloops://manual resource first. If run_start or voice_reply returns status:waiting you are the agent for those voices: see "You are the agent" in the manual. Edits are applied and saved even when the project is invalid: read the returned errors (path, message, fix) and keep going.

Rules:
1. Inspect first: project_get (summary:true) and score_view before editing a song you did not just create.
2. Respect existing ids and naming; upsert by id rather than adding near-duplicates.
3. Confirm with the user before destructive edits: removing channels, patterns, buses or arrangements, or rewriting a song you did not create. undo reverts the latest edit from anyone.

Gotchas:
- A channel only sees what a bus emitted at an earlier barrier (the writer's start+len must be at or before the reader's start).
- loop.max is required and counts passes.
- A gate needs hold:"pass" to wait for a later verdict.
- sends omitted means Master; sends:[] means nowhere.
- Only final frames are read by default.
- script code is not sandboxed: run scope can execute code.

If a studio is open, studio_status says so and your calls are shared with it. After an edit the user should see, call studio_focus to show them.`;

export async function serve(o: { project?: string; scope: keyof typeof RANK; budget?: number }) {
  const host = createHost({ scope: o.scope, budget: o.budget });
  if (o.project) try { host.open(o.project); } catch (e: any) { console.error(`agentloops mcp: cannot open ${o.project}: ${e.message}`); }
  const allowed = host.tools.filter((t) => RANK[t.scope as keyof typeof RANK] <= RANK[o.scope]);
  const LOCAL = new Set(["project_create", "project_open"]); // these pick which file THIS process works on; a studio's file is fixed

  /** Relay to the studio hosting our project file, else run here. A stale studio.json (dead pid, refused connection) is ignored and deleted. */
  async function dispatch(name: string, args: any, ctx: Ctx, client: string) {
    const file = host.st?.file ?? (o.project ? resolve(o.project) : null), info = file && !LOCAL.has(name) ? findStudio(file) : null;
    if (info) {
      const res = await fetch(`http://127.0.0.1:${info.port}/api/tool`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${info.token}` }, signal: ctx.signal,
        body: JSON.stringify({ name, args, client, scope: o.scope, budget: host.cap }), // the studio enforces our scope and budget too
      }).catch((e) => { if (ctx.signal.aborted) throw e; });
      if (res) {
        if (!res.ok || !res.body) throw new Error(`the studio refused the call (HTTP ${res.status}): restart this MCP server or the studio`);
        let buf = "", last: any;
        const take = (line: string) => { if (!line) return; const m = JSON.parse(line); if (m.progress !== undefined) ctx.progress(m.progress); else last = m; };
        for await (const chunk of res.body as any) { buf += Buffer.from(chunk).toString(); const lines = buf.split("\n"); buf = lines.pop()!; lines.forEach(take); }
        take(buf);
        if (!last) throw new Error("the studio closed the connection before answering");
        if ("error" in last) throw new Error(last.error);
        return last.result;
      }
      rmSync(studioFile(dirname(file!)), { force: true }); // ponytail: could delete a studio that started a moment ago; it rewrites the file on its next start
    }
    return host.call(name, args, ctx);
  }

  const server = new Server({ name: "agentloops", version: "0.0.1" }, { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allowed.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    try {
      const name = req.params.name;
      if (!allowed.some((x) => x.name === name)) throw new Error(`unknown tool '${name}' (scope ${o.scope})`);
      const client = server.getClientVersion()?.name ?? "unknown", token = extra._meta?.progressToken;
      let n = 0;
      const progress = token == null ? () => {} : (message: string) => { extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++n, message } }).catch(() => {}); };
      const out = await dispatch(name, req.params.arguments ?? {}, { source: `mcp:${client}`, signal: extra.signal, progress, scope: o.scope, budget: host.cap ?? undefined }, client);
      return { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] };
    } catch (e: any) { return { isError: true, content: [{ type: "text", text: e.message }] }; }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: "agentloops://manual", name: "AgentLoops manual", mimeType: "text/markdown", description: "Concepts, project format and the authoring loop" }] }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri !== "agentloops://manual") throw new Error(`unknown resource ${req.params.uri}`);
    return { contents: [{ uri: req.params.uri, mimeType: "text/markdown", text: MANUAL }] };
  });
  await server.connect(new StdioServerTransport());
}
