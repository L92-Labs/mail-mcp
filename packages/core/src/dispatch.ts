import { assertCanSend, assertPushAllowed, resolveAccount } from "./config.js";
import { cacheKey, cachedJson } from "./cache.js";
import { pollNewMessages } from "./events.js";
import {
  accountsListSchema,
  eventsSchema,
  findEmailsSchema,
  foldersListSchema,
  modifyEmailsSchema,
  respondEmailSchema,
  sendEmailSchema,
  toolsForMode,
  type ToolName,
} from "./schemas.js";
import type {
  CacheStore,
  CursorStore,
  MailBackend,
  RuntimeConfig,
} from "./types.js";

export type DispatchContext = {
  config: RuntimeConfig;
  backend: MailBackend;
  cache?: CacheStore;
  cursors: CursorStore;
};

export type ToolMeta = {
  name: ToolName;
  description: string;
  /** JSON Schema-ish object for docs / MCP registration helpers */
  inputSchema: Record<string, unknown>;
};

export const TOOL_META: ToolMeta[] = [
  {
    name: "accounts_list",
    description:
      "List configured email accounts, default account, and MAIL_MODE (pull vs pull_push).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "folders_list",
    description: "List IMAP folders for an account.",
    inputSchema: {
      type: "object",
      properties: {
        account_name: { type: "string" },
      },
    },
  },
  {
    name: "emails_find",
    description:
      "Search/list emails with optional filters. Set include_content to fetch bodies.",
    inputSchema: {
      type: "object",
      properties: {
        account_name: { type: "string" },
        folder: { type: "string" },
        query: { type: "string" },
        filters: { type: "object" },
        limit: { type: "number" },
        include_content: { type: "boolean" },
        include_attachments: { type: "boolean" },
      },
    },
  },
  {
    name: "emails_modify",
    description: "Mark read/unread, flag/unflag, or move emails between folders.",
    inputSchema: {
      type: "object",
      properties: {
        account_name: { type: "string" },
        folder: { type: "string" },
        email_ids: { type: "array", items: { type: "string" } },
        mark_read: { type: "boolean" },
        mark_unread: { type: "boolean" },
        flag: { type: "boolean" },
        unflag: { type: "boolean" },
        move_to_folder: { type: "string" },
      },
      required: ["email_ids"],
    },
  },
  {
    name: "emails_events",
    description:
      "Poll for new messages since the per-account watermark (MCP inbox events). First call seeds the cursor.",
    inputSchema: {
      type: "object",
      properties: {
        account_name: { type: "string" },
        folder: { type: "string" },
        limit: { type: "number" },
        advance: { type: "boolean", description: "Advance cursor after read (default true)" },
      },
    },
  },
  {
    name: "email_send",
    description: "Send a new email via SMTP. Requires MAIL_MODE=pull_push.",
    inputSchema: {
      type: "object",
      properties: {
        account_name: { type: "string" },
        to: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string" },
        body_type: { type: "string", enum: ["plain", "html"] },
        from_email: { type: "string" },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        attachments: { type: "array" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "email_respond",
    description: "Reply or forward an existing email. Requires MAIL_MODE=pull_push.",
    inputSchema: {
      type: "object",
      properties: {
        account_name: { type: "string" },
        email_id: { type: "string" },
        folder: { type: "string" },
        body: { type: "string" },
        body_type: { type: "string", enum: ["plain", "html"] },
        reply_all: { type: "boolean" },
        forward: { type: "boolean" },
        to: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
      },
      required: ["email_id", "body"],
    },
  },
];

export function enabledToolMeta(config: RuntimeConfig): ToolMeta[] {
  const allowed = new Set(toolsForMode(config.mode));
  return TOOL_META.filter((t) => allowed.has(t.name));
}

export async function dispatchTool(
  name: string,
  args: unknown,
  ctx: DispatchContext,
): Promise<unknown> {
  const allowed = toolsForMode(ctx.config.mode);
  if (!allowed.includes(name as ToolName)) {
    throw new Error(`unknown or disabled tool: ${name}`);
  }

  switch (name as ToolName) {
    case "accounts_list": {
      accountsListSchema.parse(args ?? {});
      return {
        default_account: ctx.config.defaultAccount,
        mode: ctx.config.mode,
        cache_ttl_seconds: ctx.config.cacheTtlSeconds,
        events_poll_seconds: ctx.config.eventsPollSeconds,
        accounts: Object.values(ctx.config.accounts).map((a) => ({
          name: a.name,
          imap_host: a.imap.host,
          smtp_host: a.smtp?.host ?? null,
          can_send: Boolean(a.smtp) && ctx.config.mode === "pull_push",
        })),
      };
    }
    case "folders_list": {
      const parsed = foldersListSchema.parse(args ?? {});
      const account = resolveAccount(ctx.config, parsed.account_name);
      return cachedJson(
        ctx.cache,
        ctx.config.cacheTtlSeconds,
        cacheKey(["folders", account.name]),
        () => ctx.backend.listFolders(account),
      );
    }
    case "emails_find": {
      const parsed = findEmailsSchema.parse(args ?? {});
      const account = resolveAccount(ctx.config, parsed.account_name);
      const input = {
        accountName: parsed.account_name,
        folder: parsed.folder,
        query: parsed.query,
        filters: parsed.filters
          ? {
              from: parsed.filters.from,
              to: parsed.filters.to,
              subject: parsed.filters.subject,
              hasAttachments: parsed.filters.has_attachments,
              isUnread: parsed.filters.is_unread,
              isFlagged: parsed.filters.is_flagged,
              afterDate: parsed.filters.after_date,
              beforeDate: parsed.filters.before_date,
            }
          : undefined,
        limit: parsed.limit,
        includeContent: parsed.include_content,
        includeAttachments: parsed.include_attachments,
      };
      const useCache =
        !parsed.include_content &&
        !parsed.include_attachments &&
        ctx.config.cacheTtlSeconds > 0;
      if (!useCache) {
        return { emails: await ctx.backend.findEmails(account, input) };
      }
      const emails = await cachedJson(
        ctx.cache,
        ctx.config.cacheTtlSeconds,
        cacheKey([
          "find",
          account.name,
          parsed.folder,
          parsed.query,
          JSON.stringify(parsed.filters ?? {}),
          parsed.limit ?? 20,
        ]),
        () => ctx.backend.findEmails(account, input),
      );
      return { emails };
    }
    case "emails_modify": {
      const parsed = modifyEmailsSchema.parse(args ?? {});
      const account = resolveAccount(ctx.config, parsed.account_name);
      return ctx.backend.modifyEmails(account, {
        accountName: parsed.account_name,
        folder: parsed.folder,
        emailIds: parsed.email_ids,
        markRead: parsed.mark_read,
        markUnread: parsed.mark_unread,
        flag: parsed.flag,
        unflag: parsed.unflag,
        moveToFolder: parsed.move_to_folder,
      });
    }
    case "emails_events": {
      const parsed = eventsSchema.parse(args ?? {});
      const account = resolveAccount(ctx.config, parsed.account_name);
      const folder = parsed.folder?.trim() || "INBOX";
      const result = await pollNewMessages({
        backend: ctx.backend,
        account,
        folder,
        cursors: ctx.cursors,
        limit: parsed.limit ?? 20,
        advance: parsed.advance !== false,
      });
      return {
        folder,
        cursor: result.cursor,
        advanced: result.advanced,
        count: result.messages.length,
        messages: result.messages,
      };
    }
    case "email_send": {
      assertPushAllowed(ctx.config, "email_send");
      const parsed = sendEmailSchema.parse(args ?? {});
      const account = resolveAccount(ctx.config, parsed.account_name);
      assertCanSend(account);
      return ctx.backend.sendEmail(account, {
        accountName: parsed.account_name,
        to: parsed.to,
        subject: parsed.subject,
        body: parsed.body,
        bodyType: parsed.body_type,
        fromEmail: parsed.from_email,
        cc: parsed.cc,
        bcc: parsed.bcc,
        attachments: parsed.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.content_type,
        })),
      });
    }
    case "email_respond": {
      assertPushAllowed(ctx.config, "email_respond");
      const parsed = respondEmailSchema.parse(args ?? {});
      const account = resolveAccount(ctx.config, parsed.account_name);
      assertCanSend(account);
      return ctx.backend.respondEmail(account, {
        accountName: parsed.account_name,
        emailId: parsed.email_id,
        folder: parsed.folder,
        body: parsed.body,
        bodyType: parsed.body_type,
        replyAll: parsed.reply_all,
        forward: parsed.forward,
        to: parsed.to,
        subject: parsed.subject,
      });
    }
    default:
      throw new Error(`unhandled tool: ${name}`);
  }
}

export function authorizeBearer(
  expected: string | undefined,
  authorizationHeader: string | null | undefined,
): boolean {
  if (!expected) return false;
  if (!authorizationHeader) return false;
  const m = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!m) return false;
  return timingSafeEqual(m[1]!, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function jsonToolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function errorToolResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}
