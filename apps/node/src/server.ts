import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import {
  authorizeBearer,
  dispatchTool,
  enabledToolMeta,
  errorToolResult,
  jsonToolResult,
  memoryCache,
  memoryCursorStore,
  type DispatchContext,
  type RuntimeConfig,
} from "@mail-mcp/core";
import { createNodeBackend } from "./backend.js";

function zodObjectFromJsonSchema(schema: Record<string, unknown>) {
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>;
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const key of Object.keys(props)) {
    // Keep validation loose at the MCP boundary; core dispatch uses Zod schemas.
    shape[key] = z.any().optional();
  }
  return z.object(shape).passthrough();
}

export function buildMcpServer(ctx: DispatchContext): McpServer {
  const server = new McpServer({ name: "mail-mcp", version: "0.1.0" });
  for (const tool of enabledToolMeta(ctx.config)) {
    const inputSchema = zodObjectFromJsonSchema(tool.inputSchema);
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema,
      },
      async (args) => {
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

export function createDispatchContext(config: RuntimeConfig): DispatchContext {
  return {
    config,
    backend: createNodeBackend(),
    cache: config.cacheTtlSeconds > 0 ? memoryCache() : undefined,
    cursors: memoryCursorStore(),
  };
}

export async function startStdio(config: RuntimeConfig): Promise<void> {
  const ctx = createDispatchContext(config);
  const server = buildMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startHttp(config: RuntimeConfig, port: number): Promise<void> {
  const ctx = createDispatchContext(config);

  const server = createServer(async (req, res) => {
    try {
      await handleHttp(req, res, ctx);
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "error" }));
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, () => resolve());
  });
  console.error(`mail-mcp HTTP listening on :${port} (/mcp)`);

  if (config.eventsPollSeconds > 0) {
    setInterval(() => {
      void (async () => {
        for (const account of Object.values(config.accounts)) {
          try {
            await dispatchTool(
              "emails_events",
              { account_name: account.name, advance: true, limit: 50 },
              ctx,
            );
          } catch {
            // best-effort warm
          }
        }
      })();
    }, config.eventsPollSeconds * 1000).unref();
  }
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DispatchContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mode: ctx.config.mode }));
    return;
  }

  if (url.pathname !== "/mcp" && !url.pathname.startsWith("/mcp/")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  if (!authorizeBearer(ctx.config.mcpBearerToken, req.headers.authorization)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  // Stateless streamable HTTP: one transport + server per request.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const mcp = buildMcpServer(ctx);
  await mcp.connect(transport);

  const bodyRaw = req.method === "POST" || req.method === "PUT" ? await readBody(req) : undefined;
  const parsedBody = bodyRaw ? JSON.parse(bodyRaw) : undefined;

  await transport.handleRequest(req, res, parsedBody);
}
