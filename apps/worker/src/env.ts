import type { EnvMap } from "@mail-mcp/core";

export type WorkerEnv = {
  MAIL_KV: KVNamespace;
  MCP_BEARER_TOKEN?: string;
  EMAIL_ACCOUNTS_JSON?: string;
  DEFAULT_EMAIL_ACCOUNT?: string;
  MAIL_MODE?: string;
  CACHE_TTL_SECONDS?: string;
  EVENTS_POLL_SECONDS?: string;
  IMAP_HOST?: string;
  IMAP_PORT?: string;
  IMAP_SECURE?: string;
  IMAP_USER?: string;
  IMAP_PASS?: string;
  IMAP_USERNAME?: string;
  IMAP_PASSWORD?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_SECURE?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
  DEFAULT_FROM_NAME?: string;
  SENDER_EMAILS?: string;
  SENT_FOLDER?: string;
  DRAFTS_FOLDER?: string;
  SAVE_SENT?: string;
  SEND_ALLOWLIST?: string;
  MAX_BODY_CHARS?: string;
  ATTACHMENT_MAX_BYTES?: string;
};

export function envToMap(env: WorkerEnv): EnvMap {
  const map: EnvMap = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") map[key] = value;
  }
  return map;
}
