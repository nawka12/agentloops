// "Connect a harness": the project-local files that let a coding agent drive this song over the Studio MCP.
// Used by `agentloops init --harness <id>` and the studio's POST /api/connect. Existing files are skipped, except the AgentLoops SKILL.md and an AGENTS.md that is the AgentLoops manual, which are always rewritten.
// Formats checked against each harness's docs: claude-code .mcp.json (code.claude.com/docs/en/mcp), codex .codex/config.toml (trusted projects only;
// developers.openai.com/codex/config-reference), cursor .cursor/mcp.json (cursor.com/docs/mcp), opencode opencode.json (opencode.ai/docs/mcp-servers).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MANUAL } from "./project.ts";

export const HARNESSES = [
  { id: "claude-code", name: "Claude Code", desc: "Anthropic's terminal agent: .mcp.json plus the AgentLoops skill." },
  { id: "codex", name: "Codex CLI", desc: "OpenAI's terminal agent: AGENTS.md plus .codex/config.toml." },
  { id: "cursor", name: "Cursor", desc: "The Cursor editor's agent: AGENTS.md plus .cursor/mcp.json." },
  { id: "opencode", name: "opencode", desc: "The open-source terminal agent: AGENTS.md plus opencode.json." },
  { id: "other", name: "Other", desc: "Any MCP client: AGENTS.md, and the server command to paste into its settings." },
];

const SKILL_DESC = "Use when the user asks to make, build, edit, run or debug an AgentLoops song or project (an .alp.json file): a multi-agent pipeline of channels, patterns, buses and loops. Teaches the project format, the Studio MCP tools and the authoring loop.";
const SKILL = ".claude/skills/agentloops/SKILL.md"; // owned by AgentLoops: rewritten on every connect and on serve
const skill = () => `---\nname: agentloops\ndescription: ${JSON.stringify(SKILL_DESC)}\n---\n\n${MANUAL}`;
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url)); // absolute path: no global install needed (dist/cli.js once built)
const ours = (rel: string, path: string) => rel === SKILL || (rel === "AGENTS.md" && readFileSync(path, "utf8").startsWith("# AgentLoops manual")); // a user's own AGENTS.md is left alone
const NODE = process.execPath; // the node running us: a harness may have an older one on PATH

/** the MCP server command for this song */
export const mcpArgs = (songFile: string) => ["--disable-warning=ExperimentalWarning", CLI, "mcp", "--project", songFile, "--scope", "run", "--budget", "1"];
const json = (v: any) => JSON.stringify(v, null, 2) + "\n";

/** Write a harness's files into `dir` for `songFile`. Returns what was written, what already existed, what to do next, and a config snippet to paste when a config file could not be written. */
export function harnessFiles(dir: string, harness: string, songFile: string) {
  const args = mcpArgs(songFile), cmd = `${NODE} ${args.map((a) => (/^[\w./:=@-]+$/.test(a) ? a : JSON.stringify(a))).join(" ")}`;
  // [path, content, snippet for when the path already exists (or the harness has no project-local config)]
  const AGENTS: [string, string, string?] = ["AGENTS.md", MANUAL];
  const mcpJson: [string, string, string] = [".mcp.json", json({ mcpServers: { agentloops: { command: NODE, args } } }), ""];
  const entries: Record<string, { files: [string, string, string?][]; next: string; snippet?: string }> = {
    "claude-code": {
      files: [mcpJson, [SKILL, skill()]],
      next: `run \`claude\` in ${dir} (approve the agentloops MCP server when asked)`,
    },
    codex: {
      files: [AGENTS, [".codex/config.toml", `[mcp_servers.agentloops]\ncommand = ${JSON.stringify(NODE)}\nargs = ${JSON.stringify(args)}\n`, ""]],
      next: `run \`codex\` in ${dir} and trust the project: Codex only reads a project's .codex/config.toml once it is trusted`,
    },
    cursor: {
      files: [AGENTS, [".cursor/mcp.json", json({ mcpServers: { agentloops: { type: "stdio", command: NODE, args } } }), ""]],
      next: `open ${dir} in Cursor and switch the agentloops server on under Settings > Tools & MCP`,
    },
    opencode: {
      files: [AGENTS, ["opencode.json", json({ $schema: "https://opencode.ai/config.json", mcp: { agentloops: { type: "local", command: [NODE, ...args], enabled: true } } }), ""]],
      next: `run \`opencode\` in ${dir}`,
    },
    other: {
      files: [AGENTS],
      next: `add the AgentLoops server to your harness's MCP settings (snippet below), then start it in ${dir}`,
      snippet: `command: ${NODE}\nargs: ${JSON.stringify(args)}\n\nor as one line:\n${cmd}`,
    },
  };
  const e = entries[harness === "agents-md" ? "other" : harness];
  if (!e) throw new Error(`harness must be one of ${HARNESSES.map((x) => x.id).join(", ")}`);
  const wrote: string[] = [], skipped: string[] = [];
  let snippet = e.snippet;
  for (const [rel, body, snip] of e.files) {
    const path = join(dir, rel);
    if (existsSync(path) && !ours(rel, path)) { skipped.push(rel); if (snip !== undefined) snippet = `${rel} already exists; add this to it yourself:\n\n${body}`; continue; }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    wrote.push(rel);
  }
  return { wrote, skipped, next: e.next, ...(snippet ? { snippet } : {}) };
}

/** Rewrite a song's stale SKILL.md and AGENTS.md (an older AgentLoops wrote them). Returns true if it rewrote either. */
export function refreshSkill(dir: string): boolean {
  let n = 0;
  for (const [rel, body] of [[SKILL, skill()], ["AGENTS.md", MANUAL]]) {
    const path = join(dir, rel);
    if (existsSync(path) && ours(rel, path) && readFileSync(path, "utf8") !== body) { writeFileSync(path, body); n++; }
  }
  return n > 0;
}
