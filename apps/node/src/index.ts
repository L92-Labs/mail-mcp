#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { loadRuntimeConfig } from "@mail-mcp/core";
import { startHttp, startStdio } from "./server.js";

const envFile = process.env.EMAIL_ENV_FILE?.trim();
if (envFile) {
  loadDotenv({ path: resolve(envFile) });
} else {
  loadDotenv();
}

const config = loadRuntimeConfig(process.env);
const transport = (process.env.MCP_TRANSPORT ?? "stdio").trim().toLowerCase();

if (transport === "http" || transport === "streamable-http") {
  if (!config.mcpBearerToken) {
    console.error("MCP_BEARER_TOKEN is required for HTTP transport");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? "8787") || 8787;
  await startHttp(config, port);
} else {
  await startStdio(config);
}
