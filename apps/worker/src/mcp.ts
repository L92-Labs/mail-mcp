import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import {
  authorizeBearer,
  dispatchTool,
  enabledToolMeta,
  errorToolResult,
  jsonToolResult,
  loadRuntimeConfig,
  type DispatchContext,
} from "@mail-mcp/core";
import { createWorkerBackend } from "./backend.js";
import { envToMap, type WorkerEnv } from "./env.js";
import { kvCache, kvCursors } from "./kv.js";

function createContext(env: WorkerEnv): DispatchContext {
  const config = loadRuntimeConfig(envToMap(env));
  return {
    config,
    backend: createWorkerBackend(),
    cache: config.cacheTtlSeconds > 0 ? kvCache(env.MAIL_KV) : undefined,
    cursors: kvCursors(env.MAIL_KV),
  };
}

export function buildMcpServer(env: WorkerEnv, request: Request): McpServer {
  const ctx = createContext(env);
  const server = new McpServer({ name: "mail-mcp", version: "0.2.0" });

  for (const tool of enabledToolMeta(ctx.config)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: false,
          openWorldHint: tool.name === "email_send" || tool.name === "email_respond",
        },
      },
      async (args) => {
        if (!authorizeBearer(ctx.config.mcpBearerToken, request.headers.get("authorization"))) {
          return errorToolResult(new Error("unauthorized"));
        }
        try {
          const result = await dispatchTool(tool.name, args ?? {}, ctx);
          return jsonToolResult(result);
        } catch (error) {
          return errorToolResult(error);
        }
      },
    );
  }

  return server;
}

export function mcpFetch(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!authorizeBearer(env.MCP_BEARER_TOKEN, request.headers.get("authorization"))) {
    return Promise.resolve(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  return createMcpHandler(() => buildMcpServer(env, request), {
    route: "/mcp",
    corsOptions: {
      origin: "*",
      methods: "GET,POST,DELETE,OPTIONS",
      headers: "Authorization,Content-Type,Accept",
    },
  })(request, env, ctx);
}

export { createContext };
