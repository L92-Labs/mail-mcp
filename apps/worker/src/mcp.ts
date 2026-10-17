import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
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
  const server = new McpServer({ name: "mail-mcp", version: "0.1.0" });

  for (const tool of enabledToolMeta(ctx.config)) {
    const props = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const key of Object.keys(props)) {
      shape[key] = z.any().optional();
    }

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: shape,
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
