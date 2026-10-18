import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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

/** Max JSON-RPC request body (attachments arrive base64-encoded). */
const MAX_REQUEST_BYTES = Number(process.env.MAX_REQUEST_BYTES ?? "") || 32 * 1024 * 1024;

export function buildMcpServer(ctx: DispatchContext): McpServer {
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

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new HttpError(413, "request_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
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
      if (res.headersSent) return;
      const status = error instanceof HttpError ? error.status : 500;
      res.writeHead(status, { "content-type": "application/json" });
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
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);

  const bodyRaw = req.method === "POST" || req.method === "PUT" ? await readBody(req) : undefined;
  let parsedBody: unknown;
  try {
    parsedBody = bodyRaw ? JSON.parse(bodyRaw) : undefined;
  } catch {
    throw new HttpError(400, "invalid_json");
  }

  await transport.handleRequest(req, res, parsedBody);
}
