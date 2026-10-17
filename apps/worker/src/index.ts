import { Hono } from "hono";
import { loadRuntimeConfig, warmEventCursors } from "@mail-mcp/core";
import { createWorkerBackend } from "./backend.js";
import { envToMap, type WorkerEnv } from "./env.js";
import { kvCursors } from "./kv.js";
import { mcpFetch } from "./mcp.js";

const app = new Hono<{ Bindings: WorkerEnv }>();

app.get("/", (c) =>
  c.json({
    name: "mail-mcp",
    mcp: "/mcp",
    health: "/health",
  }),
);

app.get("/health", (c) => {
  try {
    const config = loadRuntimeConfig(envToMap(c.env));
    return c.json({
      ok: true,
      mode: config.mode,
      accounts: Object.keys(config.accounts).length,
    });
  } catch (error) {
    return c.json(
      { ok: false, error: error instanceof Error ? error.message : "config_error" },
      500,
    );
  }
});

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return mcpFetch(request, env, ctx);
    }
    return app.fetch(request, env, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const config = loadRuntimeConfig(envToMap(env));
        if (config.eventsPollSeconds <= 0) return;
        const backend = createWorkerBackend();
        await warmEventCursors({
          backend,
          accounts: Object.values(config.accounts),
          folder: "INBOX",
          cursors: kvCursors(env.MAIL_KV),
          limit: 50,
        });
      })().catch(() => {
        // keep cron quiet
      }),
    );
  },
};
