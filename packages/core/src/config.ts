import type {
  EmailAccount,
  ImapConfig,
  MailMode,
  RuntimeConfig,
  SaveSentPolicy,
  SmtpConfig,
} from "./types.js";

export type EnvMap = Record<string, string | undefined>;

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid port: ${value}`);
  return n;
}

function parseMode(value: string | undefined): MailMode {
  const mode = (value ?? "pull_push").trim().toLowerCase();
  if (mode === "pull" || mode === "draft" || mode === "pull_push") return mode;
  throw new Error(`MAIL_MODE must be "pull", "draft" or "pull_push", got: ${value}`);
}

function parseSaveSent(value: unknown, name: string): SaveSentPolicy | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const v = String(value).trim().toLowerCase();
  if (v === "auto") return "auto";
  if (["1", "true", "yes", "on", "always"].includes(v)) return "always";
  if (["0", "false", "no", "off", "never"].includes(v)) return "never";
  throw new Error(`${name} must be auto, true or false, got: ${String(value)}`);
}

function parseNonNegative(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function parseAllowlist(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function requireNonEmpty(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function smtpFromParts(
  host: string,
  port: number,
  secure: boolean,
  user: string,
  password: string,
): SmtpConfig {
  return { host, port, secure, user, password };
}

function imapFromParts(
  host: string,
  port: number,
  secure: boolean,
  user: string,
  password: string,
): ImapConfig {
  return { host, port, secure, user, password };
}

type RawAccount = {
  smtp?: Partial<SmtpConfig> & { user?: string; password?: string };
  imap?: Partial<ImapConfig> & { user?: string; password?: string };
  default_from_name?: string;
  defaultFromName?: string;
  sender_emails?: string[];
  senderEmails?: string[];
  save_sent?: string | boolean;
  saveSent?: string | boolean;
  sent_folder?: string;
  sentFolder?: string;
  drafts_folder?: string;
  draftsFolder?: string;
};

function normalizeAccount(name: string, raw: RawAccount): EmailAccount {
  if (!raw.imap?.host || !raw.imap.user || !raw.imap.password) {
    throw new Error(`account "${name}" requires imap.host, imap.user, imap.password`);
  }
  const imapPort = raw.imap.port ?? 993;
  const imapSecure = raw.imap.secure ?? imapPort === 993;
  const account: EmailAccount = {
    name,
    imap: imapFromParts(
      raw.imap.host,
      imapPort,
      imapSecure,
      raw.imap.user,
      raw.imap.password,
    ),
    defaultFromName: raw.defaultFromName ?? raw.default_from_name,
    senderEmails: raw.senderEmails ?? raw.sender_emails,
    saveSent: parseSaveSent(raw.saveSent ?? raw.save_sent, `account "${name}" save_sent`),
    sentFolder: raw.sentFolder ?? raw.sent_folder,
    draftsFolder: raw.draftsFolder ?? raw.drafts_folder,
  };

  if (raw.smtp?.host && raw.smtp.user && raw.smtp.password) {
    const smtpPort = raw.smtp.port ?? 587;
    const smtpSecure = raw.smtp.secure ?? smtpPort === 465;
    account.smtp = smtpFromParts(
      raw.smtp.host,
      smtpPort,
      smtpSecure,
      raw.smtp.user,
      raw.smtp.password,
    );
  }

  return account;
}

function loadFromJson(env: EnvMap): Record<string, EmailAccount> | null {
  const json = env.EMAIL_ACCOUNTS_JSON?.trim();
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`EMAIL_ACCOUNTS_JSON is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("EMAIL_ACCOUNTS_JSON must be an object of named accounts");
  }
  const accounts: Record<string, EmailAccount> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, RawAccount>)) {
    accounts[name] = normalizeAccount(name, value ?? {});
  }
  if (Object.keys(accounts).length === 0) {
    throw new Error("EMAIL_ACCOUNTS_JSON has no accounts");
  }
  return accounts;
}

function loadSingleAccount(env: EnvMap): Record<string, EmailAccount> | null {
  const imapHost = env.IMAP_HOST;
  if (!imapHost) return null;

  const imapUser = requireNonEmpty(env.IMAP_USER ?? env.IMAP_USERNAME, "IMAP_USER");
  const imapPass = requireNonEmpty(env.IMAP_PASS ?? env.IMAP_PASSWORD, "IMAP_PASS");
  const imapPort = parsePort(env.IMAP_PORT, 993);
  const imapSecure = parseBool(env.IMAP_SECURE, imapPort === 993);

  const account: EmailAccount = {
    name: "default",
    imap: imapFromParts(imapHost, imapPort, imapSecure, imapUser, imapPass),
    defaultFromName: env.DEFAULT_FROM_NAME?.trim() || undefined,
    senderEmails: env.SENDER_EMAILS
      ? env.SENDER_EMAILS.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined,
    sentFolder: env.SENT_FOLDER?.trim() || undefined,
    draftsFolder: env.DRAFTS_FOLDER?.trim() || undefined,
  };

  const smtpHost = env.SMTP_HOST;
  if (smtpHost) {
    const smtpUser = requireNonEmpty(env.SMTP_USER ?? env.SMTP_USERNAME, "SMTP_USER");
    const smtpPass = requireNonEmpty(env.SMTP_PASS ?? env.SMTP_PASSWORD, "SMTP_PASS");
    const smtpPort = parsePort(env.SMTP_PORT, 587);
    const smtpSecure = parseBool(env.SMTP_SECURE, smtpPort === 465);
    account.smtp = smtpFromParts(smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass);
  }

  return { default: account };
}

export function loadRuntimeConfig(
  env: EnvMap = (typeof process !== "undefined" ? process.env : {}) as EnvMap,
): RuntimeConfig {
  const fromJson = loadFromJson(env);
  const accounts = fromJson ?? loadSingleAccount(env);
  if (!accounts) {
    throw new Error(
      "Configure EMAIL_ACCOUNTS_JSON or IMAP_HOST (+ IMAP_USER/IMAP_PASS). See .env.example",
    );
  }

  const names = Object.keys(accounts);
  const defaultAccount =
    env.DEFAULT_EMAIL_ACCOUNT?.trim() ||
    (names.includes("default") ? "default" : names[0]!);

  if (!accounts[defaultAccount]) {
    throw new Error(
      `DEFAULT_EMAIL_ACCOUNT "${defaultAccount}" not found. Known: ${names.join(", ")}`,
    );
  }

  const mode = parseMode(env.MAIL_MODE);
  if (mode === "pull_push") {
    for (const [name, account] of Object.entries(accounts)) {
      if (!account.smtp) {
        throw new Error(
          `MAIL_MODE=pull_push requires SMTP for account "${name}" (or use MAIL_MODE=pull)`,
        );
      }
    }
  }

  return {
    accounts,
    defaultAccount,
    mode,
    cacheTtlSeconds: parseNonNegative(env.CACHE_TTL_SECONDS, 0),
    eventsPollSeconds: parseNonNegative(env.EVENTS_POLL_SECONDS, 0),
    mcpBearerToken: env.MCP_BEARER_TOKEN?.trim() || undefined,
    saveSent: parseSaveSent(env.SAVE_SENT, "SAVE_SENT") ?? "auto",
    sendAllowlist: parseAllowlist(env.SEND_ALLOWLIST),
    maxBodyChars: parseNonNegative(env.MAX_BODY_CHARS, 20_000) || 20_000,
    attachmentMaxBytes: parseNonNegative(env.ATTACHMENT_MAX_BYTES, 2_000_000),
  };
}

export function resolveAccount(
  config: RuntimeConfig,
  accountName?: string,
): EmailAccount {
  const name = accountName?.trim() || config.defaultAccount;
  const account = config.accounts[name];
  if (!account) {
    throw new Error(
      `unknown account "${name}". Known: ${Object.keys(config.accounts).join(", ")}`,
    );
  }
  return account;
}

export function assertPushAllowed(config: RuntimeConfig, tool: string): void {
  if (config.mode !== "pull_push") {
    throw new Error(
      `tool "${tool}" requires MAIL_MODE=pull_push (current: ${config.mode})`,
    );
  }
}

export function assertDraftAllowed(config: RuntimeConfig, tool: string): void {
  if (config.mode === "pull") {
    throw new Error(
      `tool "${tool}" requires MAIL_MODE=draft or pull_push (current: ${config.mode})`,
    );
  }
}

export function assertCanSend(account: EmailAccount): void {
  if (!account.smtp) {
    throw new Error(`account "${account.name}" has no SMTP config`);
  }
}
