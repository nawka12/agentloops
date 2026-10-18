export const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// $/MTok [input, output], from the claude-api skill model table (cached 2026-10-06).
const PRICE: Record<string, [number, number]> = {
  "claude-fable-5-1": [10, 50], "claude-fable-5": [10, 50], "claude-mythos-5-1": [10, 50],
  "claude-opus-5-5": [4, 20], "claude-opus-5": [5, 25], "claude-opus-4-8": [5, 25], "claude-opus-4-7": [5, 25], "claude-opus-4-6": [5, 25],
  "claude-sonnet-5-5": [2, 10], "claude-sonnet-5": [2, 10], "claude-sonnet-4-6": [3, 15],
  "claude-haiku-5-5": [0.1, 0.5], "claude-haiku-4-5": [1, 5],
};
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export type Raw = { text?: string; json?: unknown; meta?: Record<string, unknown> };

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

let client: any;
// No tools yet (MCP lands in slice 2). Sampling params: Opus 5.5 / Sonnet 5.5 reject non-default temperature, so only set it if the project asks.
async function llm(ctx: any): Promise<Raw[]> {
  const p = ctx.params;
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  client ??= new Anthropic();
  const model = p.model ?? "claude-opus-5-5";
  ctx.checkBudget();
  const body: any = { model, max_tokens: p.maxTokens ?? 16000, messages: [...ctx.history, { role: "user", content: ctx.prompt }] };
  if (p.system) body.system = p.system;
  if (p.temperature != null) body.temperature = p.temperature;
  if (p.effort != null) body.output_config = { effort: typeof p.effort === "number" ? EFFORTS[Math.min(4, Math.floor(p.effort * 5))] : p.effort };
  if (ctx.schema) body.output_config = { ...body.output_config, format: { type: "json_schema", schema: strict(ctx.schema) } };
  const msg = await client.messages.create(body, { signal: ctx.signal });
  const u = msg.usage;
  // unknown model -> assume the most expensive price so budgets stay conservative
  const [pi, po] = PRICE[model] ?? [10, 50];
  const costUsd = (((u.input_tokens + 1.25 * (u.cache_creation_input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0)) * pi) + u.output_tokens * po) / 1e6;
  const tokensIn = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  ctx.charge(costUsd, tokensIn + u.output_tokens);
  if (msg.stop_reason === "refusal") throw new Error("model refused the request");
  if (msg.stop_reason === "max_tokens") throw new Error("output truncated at max_tokens; raise params.maxTokens");
  const text = msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const meta = { model, tokensIn, tokensOut: u.output_tokens, costUsd };
  return [ctx.schema ? { text, json: JSON.parse(text), meta } : { text, meta }];
}

export const generators: Record<string, (ctx: any) => Promise<Raw[]>> = { script, "llm.agent": llm };
