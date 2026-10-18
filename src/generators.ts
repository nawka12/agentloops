export const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// $/MTok [input, output], from the claude-api skill model table (cached 2026-10-06).
const PRICE: Record<string, [number, number]> = {
  "claude-fable-5-1": [10, 50], "claude-fable-5": [10, 50], "claude-mythos-5-1": [10, 50],
  "claude-opus-5-5": [4, 20], "claude-opus-5": [5, 25], "claude-opus-4-8": [5, 25], "claude-opus-4-7": [5, 25], "claude-opus-4-6": [5, 25],
  "claude-sonnet-5-5": [2, 10], "claude-sonnet-5": [2, 10], "claude-sonnet-4-6": [3, 15],
  "claude-haiku-5-5": [0.1, 0.5], "claude-haiku-4-5": [1, 5],
};
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export type Raw = { text?: string; json?: unknown; meta?: Record<string, unknown>; kind?: string; trust?: string };

// ponytail: not sandboxed; worker + permissions per SPEC §12 later
async function script(ctx: any): Promise<Raw[]> {
  const fn = new AsyncFunction("ctx", ctx.params.code);
  const r = await fn({ prompt: ctx.prompt, inputs: ctx.inputs, note: ctx.note, loop: ctx.loop, trigger: ctx.trigger, params: ctx.params, history: ctx.history });
  const items = Array.isArray(r) ? r : [r];
  if (!items.length) throw new Error("script returned an empty array");
  return items.map((x: any) => {
    if (typeof x === "string") return { text: x };
    if (x && (x.text !== undefined || x.json !== undefined)) return { text: x.text, json: x.json, meta: x.meta }; // meta lets a script simulate tokens/cost
    throw new Error("script must return a string, {text?, json?}, or an array of those");
  });
}

// Structured outputs need additionalProperties:false on every object.
const strict = (s: any): any =>
  Array.isArray(s) ? s.map(strict)
  : s && typeof s === "object" ? Object.fromEntries(Object.entries(s).map(([k, v]) => [k, strict(v)]).concat(s.type === "object" && s.additionalProperties === undefined ? [["additionalProperties", false]] : []))
  : s;

/** MCP tool servers (stdio) for one run: each connects lazily on first use and closes with the run. */
export function createMcpPool(servers: Record<string, any> = {}, cwd?: string) {
  const conns = new Map<string, Promise<{ client: any; tools: any[] }>>();
  const connect = (name: string) => {
    let c = conns.get(name);
    if (!c) {
      c = (async () => {
        const cfg = servers[name]?.mcp;
        if (!cfg) throw new Error(`unknown tool server '${name}'`);
        const [{ Client }, { StdioClientTransport }] = await Promise.all([import("@modelcontextprotocol/sdk/client/index.js"), import("@modelcontextprotocol/sdk/client/stdio.js")]);
        const client = new Client({ name: "agentloops", version: "0.0.1" });
        await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], env: cfg.env, cwd }));
        const tools: any[] = [];
        for (let cursor: string | undefined; ; ) {
          const r: any = await client.listTools({ cursor });
          tools.push(...r.tools);
          if (!(cursor = r.nextCursor)) break;
        }
        return { client, tools };
      })();
      c.catch(() => conns.delete(name)); // a failed connect can be retried by a retrying voice
      conns.set(name, c);
    }
    return c;
  };
  return {
    /** Resolve allow-list entries ("server" or "server.tool") to Anthropic tool definitions. */
    async list(allow: string[]) {
      const out: any[] = [];
      for (const server of new Set(allow.map((a) => a.split(".")[0]))) {
        const { tools } = await connect(server);
        const names = allow.filter((a) => a.split(".")[0] === server && a.includes(".")).map((a) => a.slice(server.length + 1));
        for (const n of names) if (!tools.some((t) => t.name === n)) throw new Error(`tool server '${server}' has no tool '${n}' (it offers: ${tools.map((t) => t.name).join(", ") || "none"})`);
        for (const t of tools)
          if (allow.includes(server) || names.includes(t.name))
            out.push({ server, tool: t.name, name: `${server}__${t.name}`.replace(/[^\w-]/g, "_").slice(0, 64), description: t.description ?? "", input_schema: t.inputSchema });
      }
      return out;
    },
    async call(server: string, tool: string, args: unknown, signal?: AbortSignal) {
      const { client } = await connect(server);
      return client.callTool({ name: tool, arguments: args as any }, undefined, { signal });
    },
    async close() { await Promise.allSettled([...conns.values()].map(async (c) => (await c).client.close())); },
  };
}
const resultText = (r: any) => (r.content ?? []).map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");

// The outside harness (Claude Code over Studio MCP) is the agent: ask it through the run's bridge and wait for voice_reply.
const noRetry = (e: Error) => Object.assign(e, { noRetry: true }); // a decline, timeout or missing bridge is not worth asking again
async function harness(ctx: any): Promise<Raw[]> {
  if (!ctx.harness) throw noRetry(new Error("harness channels need a run started from your harness over Studio MCP (run_start)"));
  const { instructions, timeoutMs = 30 * 60_000 } = ctx.params;
  const bad = Object.values<any>(ctx.inputs).some((i) => i.trust === "untrusted");
  const inputs = Object.fromEntries(Object.entries<any>(ctx.inputs).map(([k, i]) => [k, { text: i.text, json: i.json, ...(bad ? { trust: i.trust } : {}) }]));
  const req = { ...ctx.voice, prompt: ctx.prompt, inputs, schema: ctx.schema, instructions, history: ctx.history };
  const sig = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
  try { return await ctx.harness(req, sig); }
  catch (e: any) { throw noRetry(ctx.signal.aborted ? new Error("aborted") : sig.aborted ? new Error(`harness did not reply within ${timeoutMs} ms`) : e); }
}

let client: any;
// Sampling params: Opus 5.5 / Sonnet 5.5 reject non-default temperature, so only set it if the project asks.
// Tool loop: call the model, run its tool_use blocks through MCP, feed results back, until a final answer or maxTurns.
async function llm(ctx: any): Promise<Raw[]> {
  const p = ctx.params;
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  client ??= new Anthropic();
  const model = p.model ?? "claude-opus-5-5", maxTurns = p.maxTurns ?? 10;
  const tools = p.tools?.length ? await ctx.mcp.list(p.tools) : [];
  const body: any = { model, max_tokens: p.maxTokens ?? 16000, messages: [...ctx.history, { role: "user", content: ctx.prompt }] };
  if (tools.length) body.tools = tools.map((t: any) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  if (p.system) body.system = p.system;
  if (p.temperature != null) body.temperature = p.temperature;
  if (p.effort != null) body.output_config = { effort: typeof p.effort === "number" ? EFFORTS[Math.min(4, Math.floor(p.effort * 5))] : p.effort };
  if (ctx.schema) body.output_config = { ...body.output_config, format: { type: "json_schema", schema: strict(ctx.schema) } };
  // unknown model -> assume the most expensive price so budgets stay conservative
  const [pi, po] = PRICE[model] ?? [10, 50];
  const out: Raw[] = [];
  let costUsd = 0, tokensIn = 0, tokensOut = 0;
  for (let turn = 1; ; turn++) {
    ctx.checkBudget();
    const msg = await client.messages.create(body, { signal: ctx.signal });
    const u = msg.usage, c = (((u.input_tokens + 1.25 * (u.cache_creation_input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0)) * pi) + u.output_tokens * po) / 1e6;
    const tin = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    costUsd += c; tokensIn += tin; tokensOut += u.output_tokens;
    ctx.charge(c, tin + u.output_tokens);
    if (msg.stop_reason === "refusal") throw new Error("model refused the request");
    if (msg.stop_reason === "max_tokens") throw new Error("output truncated at max_tokens; raise params.maxTokens");
    const uses = msg.content.filter((b: any) => b.type === "tool_use");
    if (msg.stop_reason !== "tool_use" || !uses.length) {
      const text = msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      const meta = { model, tokensIn, tokensOut, costUsd, turns: turn };
      return [...out, ctx.schema ? { text, json: JSON.parse(text), meta } : { text, meta }];
    }
    if (turn >= maxTurns) throw new Error(`no final answer after maxTurns=${maxTurns} model calls; raise params.maxTurns`);
    body.messages.push({ role: "assistant", content: msg.content });
    const results = await Promise.all(uses.map(async (u: any) => {
      const t = tools.find((x: any) => x.name === u.name);
      if (!t) return { text: `unknown tool '${u.name}'`, isError: true };
      try { const r = await ctx.mcp.call(t.server, t.tool, u.input, ctx.signal); return { text: resultText(r), isError: !!r.isError }; }
      catch (e: any) { if (ctx.signal?.aborted) throw e; return { text: `tool call failed: ${e.message}`, isError: true }; }
    }));
    uses.forEach((u: any, i: number) => {
      const t = tools.find((x: any) => x.name === u.name), id = u.id, meta = { server: t?.server, tool: t?.tool ?? u.name };
      out.push({ kind: "tool_call", text: `${t ? `${t.server}.${t.tool}` : u.name}(${JSON.stringify(u.input)})`, json: { id, input: u.input }, meta });
      out.push({ kind: "tool_result", text: results[i].text, json: { id, isError: results[i].isError }, trust: "untrusted", meta });
    });
    // ponytail: tool turns are not kept in a persistent channel's history (only the final text is) and results are not size-capped
    body.messages.push({ role: "user", content: uses.map((u: any, i: number) => ({ type: "tool_result", tool_use_id: u.id, content: results[i].text, ...(results[i].isError ? { is_error: true } : {}) })) });
  }
}

export const generators: Record<string, (ctx: any) => Promise<Raw[]>> = { script, "llm.agent": llm, harness };
