// Tiny stdio MCP server for tests: one tool, `echo`.
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "echo", version: "0.0.1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo", description: "Echo the text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "secret", description: "Not allow-listed in tests", inputSchema: { type: "object", properties: {} } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({ content: [{ type: "text", text: `echo: ${(req.params.arguments as any)?.text}` }] }));
if (process.env.ECHO_LOG) appendFileSync(process.env.ECHO_LOG, "start\n"); // lets a test count connections
await server.connect(new StdioServerTransport());
