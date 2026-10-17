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
};

export function envToMap(env: WorkerEnv): EnvMap {
  return {
    MCP_BEARER_TOKEN: env.MCP_BEARER_TOKEN,
    EMAIL_ACCOUNTS_JSON: env.EMAIL_ACCOUNTS_JSON,
    DEFAULT_EMAIL_ACCOUNT: env.DEFAULT_EMAIL_ACCOUNT,
    MAIL_MODE: env.MAIL_MODE,
    CACHE_TTL_SECONDS: env.CACHE_TTL_SECONDS,
    EVENTS_POLL_SECONDS: env.EVENTS_POLL_SECONDS,
    IMAP_HOST: env.IMAP_HOST,
    IMAP_PORT: env.IMAP_PORT,
    IMAP_SECURE: env.IMAP_SECURE,
    IMAP_USER: env.IMAP_USER,
    IMAP_PASS: env.IMAP_PASS,
    IMAP_USERNAME: env.IMAP_USERNAME,
    IMAP_PASSWORD: env.IMAP_PASSWORD,
    SMTP_HOST: env.SMTP_HOST,
    SMTP_PORT: env.SMTP_PORT,
    SMTP_SECURE: env.SMTP_SECURE,
    SMTP_USER: env.SMTP_USER,
    SMTP_PASS: env.SMTP_PASS,
    SMTP_USERNAME: env.SMTP_USERNAME,
    SMTP_PASSWORD: env.SMTP_PASSWORD,
    DEFAULT_FROM_NAME: env.DEFAULT_FROM_NAME,
    SENDER_EMAILS: env.SENDER_EMAILS,
  };
}
