import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const mode = process.env.FAKE_CODEX_MCP_MODE ?? "normal";
const delayMs = Number(process.env.FAKE_CODEX_MCP_DELAY_MS ?? "250");
const validResult = JSON.stringify({
  status: "COMPLETE",
  summary: "fake Codex completed",
  changed_scope: [],
  artifacts: [],
  commit_or_diff: null,
  verification_results: [],
  remaining_risks: [],
  recommended_next_action: "review",
});

const server = new Server(
  { name: "fake-codex-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "codex",
      description: "fake initial Codex call",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        properties: { prompt: { type: "string" } },
      },
    },
    ...(mode === "missing-reply"
      ? []
      : [
          {
            name: "codex-reply",
            description: "fake Codex continuation",
            inputSchema: {
              type: "object",
              required: ["prompt", "threadId"],
              properties: {
                prompt: { type: "string" },
                threadId: { type: "string" },
              },
            },
          },
        ]),
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (mode === "slow") {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (mode === "tool-error") {
    return {
      isError: true,
      content: [{ type: "text", text: "simulated tool failure" }],
    };
  }
  if (mode === "malformed") {
    return {
      structuredContent: { content: validResult },
      content: [{ type: "text", text: validResult }],
    };
  }
  if (mode === "stale-reply" && request.params.name === "codex-reply") {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Session not found for thread_id: ${request.params.arguments?.threadId ?? "unknown"}`,
        },
      ],
    };
  }

  const isReply = request.params.name === "codex-reply";
  const args = request.params.arguments ?? {};
  const threadId = isReply && typeof args.threadId === "string" ? args.threadId : "thread_fake_1";
  const content = isReply
    ? process.env.FAKE_CODEX_REPLY_CONTENT ?? validResult
    : process.env.FAKE_CODEX_CONTENT ?? validResult;
  return {
    structuredContent: { threadId, content },
    content: [{ type: "text", text: content }],
  };
});

await server.connect(new StdioServerTransport());
