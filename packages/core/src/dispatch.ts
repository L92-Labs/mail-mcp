import type { z } from "zod";
import {
  assertCanSend,
  assertDraftAllowed,
  assertPushAllowed,
  resolveAccount,
} from "./config.js";
import { cacheKey, cachedJson } from "./cache.js";
import {
  allRecipients,
  assertRecipientsAllowed,
  composeNew,
  composeReply,
  parseEmailId,
  parseFolderAlias,
  resolveSpecialFolder,
  shouldSaveSent,
  SPECIAL_USE,
  truncate,
  type ReplyInput,
  type SpecialFolder,
} from "./compose.js";
import { pollNewMessages, eventCursorKey } from "./events.js";
import {
  assertFolderManageable,
  assertNotInbox,
  findProtectedFolder,
  isDescendantFolder,
  isInboxPath,
  normalizeFolderPath,
  rejectSeparatorTricks,
  resolveProtectedCandidates,
  resolveStoredName,
  type ProtectedFolder,
} from "./folders.js";
import {
  accountsListSchema,
  draftEmailSchema,
  eventsSchema,
  findEmailsSchema,
  folderCreateSchema,
  folderDeleteSchema,
  folderRenameSchema,
  foldersListSchema,
  getEmailSchema,
  modifyEmailsSchema,
  respondEmailSchema,
  sendEmailSchema,
  toolsForMode,
  type ToolName,
} from "./schemas.js";
import type {
  CacheStore,
  CursorStore,
  EmailAccount,
  EmailDetail,
  FolderInfo,
  MailBackend,
  OutgoingMessage,
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
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  readOnly: boolean;
  /** True when the tool removes data irreversibly (destructiveHint for MCP clients). */
  destructive?: boolean;
};

export const TOOL_META: ToolMeta[] = [
  {
    name: "accounts_list",
    title: "List accounts",
    description:
      "List configured mailboxes, the default account, MAIL_MODE and what each account can do (draft/send). Call first when unsure which account_name to use.",
    inputSchema: accountsListSchema,
    readOnly: true,
  },
  {
    name: "folders_list",
    title: "List folders",
    description:
      "List IMAP folders with their special use (\\Sent, \\Drafts, \\Trash, \\Archive, \\Junk) and the hierarchy delimiter for building nested paths.",
    inputSchema: foldersListSchema,
    readOnly: true,
  },
  {
    name: "folder_create",
    title: "Create folder",
    description:
      "Create a folder, e.g. \"Receipts\" or nested \"INBOX/Receipts\" (separator comes from folders_list). Missing parent folders are created by most servers. Returns created:false when the folder already exists. INBOX and special folders cannot be created.",
    inputSchema: folderCreateSchema,
    readOnly: false,
  },
  {
    name: "folder_rename",
    title: "Rename folder",
    description:
      "Rename or move a folder (children follow). Both the folder and its new path are guarded: INBOX and special folders (Sent, Drafts, Trash, Archive, Junk) cannot be renamed or become a rename destination.",
    inputSchema: folderRenameSchema,
    readOnly: false,
  },
  {
    name: "folder_delete",
    title: "Delete folder",
    description:
      "Delete a folder and every message in it; children may become unreachable. Requires confirm:true. INBOX and special folders (Sent, Drafts, Trash, Archive, Junk) cannot be deleted.",
    inputSchema: folderDeleteSchema,
    readOnly: false,
    destructive: true,
  },
  {
    name: "emails_find",
    title: "Find emails",
    description:
      "Search or list emails in a folder, newest first, paginated. Returns light summaries (id, from, subject, date, snippet, flags) plus total and next_cursor. Pass next_cursor back as cursor for the next page. Use email_get to read one message in full.",
    inputSchema: findEmailsSchema,
    readOnly: true,
  },
  {
    name: "email_get",
    title: "Read email",
    description:
      "Read one email in full: headers, body text (HTML converted to text), attachment list, threading ids. Does not mark it read unless mark_read=true.",
    inputSchema: getEmailSchema,
    readOnly: true,
  },
  {
    name: "emails_modify",
    title: "Organize emails",
    description:
      "Mark read/unread, flag/unflag, or move emails (archive, trash, junk, or any folder). Accepts several ids at once.",
    inputSchema: modifyEmailsSchema,
    readOnly: false,
  },
  {
    name: "emails_events",
    title: "New mail since",
    description:
      "Get messages that arrived after a UID watermark, oldest first. Stateless: pass after_uid = next_after_uid from the previous call. Without after_uid a server-side cursor is used (first call only seeds it).",
    inputSchema: eventsSchema,
    readOnly: true,
  },
  {
    name: "email_draft",
    title: "Save draft",
    description:
      "Save a draft to the account's Drafts folder without sending: a new message, or a threaded reply/forward when email_id is set. The human reviews and sends it from their mail client.",
    inputSchema: draftEmailSchema,
    readOnly: false,
  },
  {
    name: "email_send",
    title: "Send email",
    description:
      "Send a new email over SMTP (to/cc/bcc, plain or HTML, attachments). Copies it to Sent when the provider does not. Recipients are checked against SEND_ALLOWLIST.",
    inputSchema: sendEmailSchema,
    readOnly: false,
  },
  {
    name: "email_respond",
    title: "Reply / forward",
    description:
      "Reply, reply-all or forward an existing email with proper threading (In-Reply-To/References) and the original quoted. Your own addresses are removed from reply-all; forwards carry the original attachments. Marks the original as answered.",
    inputSchema: respondEmailSchema,
    readOnly: false,
  },
];

export function enabledToolMeta(config: RuntimeConfig): ToolMeta[] {
  const allowed = new Set(toolsForMode(config.mode));
  return TOOL_META.filter((t) => allowed.has(t.name));
}

// ---------- helpers ----------

async function cacheGeneration(ctx: DispatchContext, account: EmailAccount): Promise<string> {
  if (!ctx.cache || ctx.config.cacheTtlSeconds <= 0) return "0";
  return (await ctx.cache.get(`gen|${account.name}`)) ?? "0";
}

/** Invalidate cached listings for an account after a mutation. */
async function bumpCache(ctx: DispatchContext, account: EmailAccount): Promise<void> {
  if (!ctx.cache || ctx.config.cacheTtlSeconds <= 0) return;
  // Random per bump: Date.now() collides for same-millisecond mutations and can
  // move backwards under Workers clock skew, reviving a stale key.
  const generation =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await ctx.cache.set(`gen|${account.name}`, generation, 86_400);
  } catch {
    // Best-effort: a failed cache write must never mask a successful mutation.
  }
}

async function listFolders(ctx: DispatchContext, account: EmailAccount): Promise<FolderInfo[]> {
  return cachedJson(
    ctx.cache,
    ctx.config.cacheTtlSeconds,
    cacheKey(["folders", account.name, await cacheGeneration(ctx, account)]),
    () => ctx.backend.listFolders(account),
  );
}

/**
 * Folders the guard must keep intact beyond server-advertised special use:
 * configured sent/drafts overrides and the same name-based fallbacks the
 * special-folder resolver uses, so protection matches what the server
 * actually relies on even without RFC 6154 attributes.
 */
function protectedFolders(account: EmailAccount, folders: FolderInfo[]): ProtectedFolder[] {
  const resolved: ProtectedFolder[] = [];
  const seen = new Set(folders.filter((f) => f.specialUse).map((f) => f.path));
  for (const kind of ["sent", "drafts", "trash", "archive", "junk"] as const satisfies SpecialFolder[]) {
    const override = kind === "sent" ? account.sentFolder : kind === "drafts" ? account.draftsFolder : undefined;
    const configured = override ?? resolveSpecialFolder(folders, kind);
    if (!configured) continue;
    // Resolve to every plausible server-stored path (namespace prefix /
    // case / duplicate leaf names may differ from the configured value —
    // delivery/listing use the canonical form). Guard direction:
    // over-protecting only widens the guard; under-protecting is the bug.
    for (const candidate of resolveProtectedCandidates(folders, configured)) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        resolved.push({ path: candidate, use: SPECIAL_USE[kind] });
      }
    }
  }
  return resolved;
}

async function specialFolder(
  ctx: DispatchContext,
  account: EmailAccount,
  kind: SpecialFolder,
): Promise<string | null> {
  if (kind === "sent" && account.sentFolder) return account.sentFolder;
  if (kind === "drafts" && account.draftsFolder) return account.draftsFolder;
  return resolveSpecialFolder(await listFolders(ctx, account), kind);
}

async function resolveMoveTarget(
  ctx: DispatchContext,
  account: EmailAccount,
  value: string,
): Promise<string> {
  if (value.trim().toLowerCase() === "inbox") return "INBOX";
  const alias = parseFolderAlias(value);
  if (!alias) return value;
  const folders = await listFolders(ctx, account);
  // A literal folder with this exact path wins over the alias.
  if (folders.some((f) => f.path === value)) return value;
  const path = resolveSpecialFolder(folders, alias);
  if (!path) {
    throw new Error(
      `no "${alias}" folder found for account "${account.name}"; pass an exact path from folders_list`,
    );
  }
  return path;
}

async function loadOriginal(
  ctx: DispatchContext,
  account: EmailAccount,
  emailId: string,
  withAttachments: boolean,
): Promise<EmailDetail> {
  parseEmailId(emailId);
  return ctx.backend.getEmail(account, {
    emailId,
    includeAttachmentContent: withAttachments,
    attachmentMaxBytes: ctx.config.attachmentMaxBytes,
  });
}

type DeliveryResult = {
  message_id: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  saved_to_sent: string | null;
  warnings: string[];
};

async function deliver(
  ctx: DispatchContext,
  account: EmailAccount,
  msg: OutgoingMessage,
): Promise<DeliveryResult> {
  if (allRecipients(msg).length === 0) throw new Error("no recipients");
  assertRecipientsAllowed(ctx.config.sendAllowlist, allRecipients(msg));
  await ctx.backend.sendMessage(account, msg);

  const warnings: string[] = [];
  let savedTo: string | null = null;
  if (shouldSaveSent(ctx.config, account)) {
    try {
      const sent = await specialFolder(ctx, account, "sent");
      if (sent) {
        await ctx.backend.appendMessage(account, sent, msg, ["\\Seen"]);
        savedTo = sent;
      } else {
        warnings.push("sent, but no Sent folder found to store a copy (set sent_folder)");
      }
    } catch (error) {
      warnings.push(`sent, but saving a copy to Sent failed: ${errMessage(error)}`);
    }
  }
  await bumpCache(ctx, account);
  return {
    message_id: msg.messageId,
    to: msg.to,
    cc: msg.cc,
    bcc: msg.bcc,
    subject: msg.subject,
    saved_to_sent: savedTo,
    warnings,
  };
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function attachmentsArg(list?: Array<{ filename: string; content: string; content_type?: string }>) {
  return list?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.content_type }));
}

// ---------- dispatch ----------

export async function dispatchTool(
  name: string,
  args: unknown,
  ctx: DispatchContext,
): Promise<unknown> {
  const allowed = toolsForMode(ctx.config.mode);
  if (!allowed.includes(name as ToolName)) {
    throw new Error(`unknown or disabled tool: ${name} (MAIL_MODE=${ctx.config.mode})`);
  }

  switch (name as ToolName) {
    case "accounts_list": {
      accountsListSchema.parse(args ?? {});
      const mode = ctx.config.mode;
      return {
        default_account: ctx.config.defaultAccount,
        mode,
        send_allowlist: ctx.config.sendAllowlist.length ? ctx.config.sendAllowlist : null,
        accounts: Object.values(ctx.config.accounts).map((a) => ({
          name: a.name,
          address: a.smtp?.user ?? a.imap.user,
          sender_emails: a.senderEmails ?? [],
          can_draft: mode !== "pull",
          can_send: Boolean(a.smtp) && mode === "pull_push",
          saves_sent_copy: Boolean(a.smtp) && shouldSaveSent(ctx.config, a),
        })),
      };
    }

    case "folders_list": {
      const parsed = foldersListSchema.parse(args ?? {});
      const account = resolveAccount(ctx.config, parsed.account_name);
      return { folders: await listFolders(ctx, account) };
    }

    case "folder_create": {
      const parsed = folderCreateSchema.parse(args ?? {});
      const account = resolveAccount(ctx.config, parsed.account_name);
      const path = normalizeFolderPath(parsed.path);
      if (isInboxPath(path)) {
        throw new Error('INBOX already exists; create a subfolder instead, e.g. "INBOX/…"');
      }
      // Destructive/guard decisions need current server state: bypass the
      // cache (another client may have changed special-use structure).
      const folders = await ctx.backend.listFolders(account);
      // Same aliasing refusal as rename/delete: a server-dependent trailing
      // separator could create a path this tool could never manage again.
      rejectSeparatorTricks(path, folders);
      const special = findProtectedFolder(
        resolveStoredName(folders, path),
        folders,
        protectedFolders(account, folders),
      );
      if (special) {
        throw new Error(`"${special.path}" already exists as the ${special.use} special folder`);
      }
      const result = await ctx.backend.createFolder(account, path);
      await bumpCache(ctx, account);
      if (result.created) {
        // A recreated folder may reuse a path whose old poll cursor exceeds its
        // new UIDs; drop it so the next poll re-seeds at the current watermark.
        try {
          await ctx.cursors.delete?.(eventCursorKey(account.name, result.path));
        } catch {
          // best-effort
        }
      }
      return {
        created: result.created,
        folder: result.path,
      };
    }

    case "folder_rename": {
      const parsed = folderRenameSchema.parse(args ?? {});
      const account = resolveAccount(ctx.config, parsed.account_name);
      assertNotInbox(parsed.path, "rename");
      // Pre-rename snapshot, uncached: guards AND the set of folders the
      // rename moves must reflect current server state. The source path
      // resolves to its server-stored form first (namespace prefixes / case
      // may differ from the raw argument) so guards and cursor keys use
      // canonical paths throughout.
      const folders = await ctx.backend.listFolders(account);
      const sourceRoot = resolveStoredName(folders, parsed.path);
      assertFolderManageable(sourceRoot, folders, "rename", protectedFolders(account, folders));
      const sourceFolders = folders.filter(
        (f) => f.path === sourceRoot || isDescendantFolder(f.path, sourceRoot, folders),
      );
      const newPath = normalizeFolderPath(parsed.new_path);
      if (newPath === sourceRoot) {
        throw new Error("new_path must differ from path");
      }
      // The destination becomes a parent on some servers; guard it like a source.
      assertFolderManageable(newPath, folders, "rename", protectedFolders(account, folders));
      const result = await ctx.backend.renameFolder(account, sourceRoot, newPath);
      await bumpCache(ctx, account);
      // RENAME moves the mailbox — and its captured children — with their
      // UIDs: migrate poll cursors for exactly the folders that moved, so
      // unrelated destinations keep their own cursors.
      try {
        for (const f of sourceFolders) {
          const suffix = f.path.slice(sourceRoot.length);
          // Key bases come from the backend-canonical paths (servers with
          // namespace prefixes normalize RENAME args), not the caller's raw
          // input — the poller keys cursors by those canonical paths.
          const oldKey = eventCursorKey(account.name, result.path + suffix);
          const newKey = eventCursorKey(account.name, result.newPath + suffix);
          const stored = await ctx.cursors.get(oldKey);
          if (stored !== null) {
            await ctx.cursors.set(newKey, stored);
            await ctx.cursors.delete?.(oldKey);
          } else {
            // The moved folder's history is the source's: a residual cursor
            // at its destination path is stale by definition.
            await ctx.cursors.delete?.(newKey);
          }
        }
      } catch {
        // best-effort
      }
      return { renamed: true, folder: result.path, new_folder: result.newPath };
    }

    case "folder_delete": {
      const parsed = folderDeleteSchema.parse(args ?? {});
      const account = resolveAccount(ctx.config, parsed.account_name);
      if (parsed.confirm !== true) {
        throw new Error('folder_delete requires confirm:true — deleting removes the folder and every message in it');
      }
      assertNotInbox(parsed.path, "delete");
      const folders = await ctx.backend.listFolders(account);
      const path = assertFolderManageable(
        resolveStoredName(folders, parsed.path),
        folders,
        "delete",
        protectedFolders(account, folders),
      );
      const result = await ctx.backend.deleteFolder(account, path);
      await bumpCache(ctx, account);
      // Drop the poll cursor so a later recreation of this path re-seeds at
      // the current watermark instead of hiding mail below the old one.
      try {
        await ctx.cursors.delete?.(eventCursorKey(account.name, result.path));
      } catch {
        // best-effort
      }
      return { deleted: true, folder: result.path };
    }

    case "emails_find": {
      const parsed = findEmailsSchema.parse(args ?? {});
      const account = resolveAccount(ctx.config, parsed.account_name);
      const folder = parsed.folder?.trim() || "INBOX";
      const f = parsed.filters;
      const input = {
        folder,
        query: parsed.query,
        filters: f
          ? {
              from: f.from,
              to: f.to,
              subject: f.subject,
              hasAttachments: f.has_attachments,
              isUnread: f.is_unread,
              isFlagged: f.is_flagged,
              afterDate: f.after_date,
              beforeDate: f.before_date,
            }
          : undefined,
        limit: parsed.limit ?? 20,
        cursor: parsed.cursor,
        includeContent: parsed.include_content,
      };
      const load = () => ctx.backend.findEmails(account, input);
      const result =
        parsed.include_content || ctx.config.cacheTtlSeconds <= 0
          ? await load()
          : await cachedJson(
              ctx.cache,
              ctx.config.cacheTtlSeconds,
              cacheKey([
                "find",
                account.name,
                await cacheGeneration(ctx, account),
                folder,
                parsed.query,
                JSON.stringify(f ?? {}),
                input.limit,
                parsed.cursor,
              ]),
              load,
            );
      // Server-side attachment search is a header heuristic; drop false positives exactly.
      const emails =
        f?.has_attachments === undefined
          ? result.emails
          : result.emails.filter((e) => e.hasAttachments === f.has_attachments);
      return {
        account: account.name,
        folder,
        total: result.total,
        count: emails.length,
        next_cursor: result.nextCursor,
        emails,
      };
    }

    case "email_get": {
      const parsed = getEmailSchema.parse(args ?? {});
      const account = resolveAccount(ctx.config, parsed.account_name);
      parseEmailId(parsed.email_id);
      const detail = await ctx.backend.getEmail(account, {
        emailId: parsed.email_id,
        includeAttachmentContent: parsed.include_attachment_content,
        attachmentMaxBytes: ctx.config.attachmentMaxBytes,
        markRead: parsed.mark_read,
      });
      if (parsed.mark_read) await bumpCache(ctx, account);
      const { text, truncated } = truncate(
        detail.bodyText,
        parsed.max_chars ?? ctx.config.maxBodyChars,
      );
      const { bodyHtml, ...rest } = detail;
      return {
        ...rest,
        bodyText: text,
        truncated,
        ...(parsed.include_html && bodyHtml ? { bodyHtml } : {}),
      };
    }

    case "emails_modify": {
      const parsed = modifyEmailsSchema.parse(args ?? {});
      const account = resolveAccount(ctx.config, parsed.account_name);
      for (const id of parsed.email_ids) parseEmailId(id);
      const moveTo = parsed.move_to_folder?.trim()
        ? await resolveMoveTarget(ctx, account, parsed.move_to_folder)
        : undefined;
      const result = await ctx.backend.modifyEmails(account, {
        folder: parsed.folder,
        emailIds: parsed.email_ids,
        markRead: parsed.mark_read,
        markUnread: parsed.mark_unread,
        flag: parsed.flag,
        unflag: parsed.unflag,
        moveToFolder: moveTo,
      });
      await bumpCache(ctx, account);
      return { ...result, moved_to: moveTo ?? null };
    }

    case "emails_events": {
      const parsed = eventsSchema.parse(args ?? {});
      const account = resolveAccount(ctx.config, parsed.account_name);
      const folder = parsed.folder?.trim() || "INBOX";
      const limit = parsed.limit ?? 20;
      if (parsed.after_uid !== undefined) {
        const { messages, hasMore } = await ctx.backend.listNewSince(
          account,
          folder,
          parsed.after_uid,
          limit,
        );
        const next = messages.reduce((m, e) => Math.max(m, e.uid), parsed.after_uid);
        return {
          account: account.name,
          folder,
          count: messages.length,
          next_after_uid: next,
          has_more: hasMore,
          messages,
        };
      }
      const result = await pollNewMessages({
        backend: ctx.backend,
        account,
        folder,
        cursors: ctx.cursors,
        limit,
        advance: parsed.advance !== false,
      });
      return {
        account: account.name,
        folder,
        seeded: result.seeded,
        count: result.messages.length,
        next_after_uid: result.cursor,
        has_more: result.hasMore,
        advanced: result.advanced,
        messages: result.messages,
      };
    }

    case "email_draft": {
      assertDraftAllowed(ctx.config, "email_draft");
      const parsed = draftEmailSchema.parse(args ?? {});
      const account = resolveAccount(ctx.config, parsed.account_name);
      const compose: ReplyInput = {
        to: parsed.to,
        cc: parsed.cc,
        bcc: parsed.bcc,
        replyTo: parsed.reply_to,
        subject: parsed.subject,
        body: parsed.body,
        bodyType: parsed.body_type,
        fromEmail: parsed.from_email,
        attachments: attachmentsArg(parsed.attachments),
        replyAll: parsed.reply_all,
        forward: parsed.forward,
        quote: parsed.quote,
        includeAttachments: parsed.include_attachments,
      };
      let msg: OutgoingMessage;
      if (parsed.email_id) {
        const original = await loadOriginal(
          ctx,
          account,
          parsed.email_id,
          Boolean(parsed.forward) && parsed.include_attachments !== false,
        );
        msg = composeReply(account, original, compose);
      } else {
        msg = composeNew(account, compose);
      }
      const drafts = await specialFolder(ctx, account, "drafts");
      if (!drafts) {
        throw new Error(
          `no Drafts folder found for account "${account.name}"; set drafts_folder / DRAFTS_FOLDER`,
        );
      }
      const { uid } = await ctx.backend.appendMessage(account, drafts, msg, ["\\Draft", "\\Seen"]);
      await bumpCache(ctx, account);
      return {
        saved: true,
        folder: drafts,
        email_id: uid ? `${drafts}:${uid}` : null,
        message_id: msg.messageId,
        to: msg.to,
        cc: msg.cc,
        subject: msg.subject,
      };
    }

    case "email_send": {
      assertPushAllowed(ctx.config, "email_send");
      const parsed = sendEmailSchema.parse(args ?? {});
      const account = resolveAccount(ctx.config, parsed.account_name);
      assertCanSend(account);
      const msg = composeNew(account, {
        to: parsed.to,
        cc: parsed.cc,
        bcc: parsed.bcc,
        replyTo: parsed.reply_to,
        subject: parsed.subject,
        body: parsed.body,
        bodyType: parsed.body_type,
        fromEmail: parsed.from_email,
        attachments: attachmentsArg(parsed.attachments),
      });
      return { sent: true, ...(await deliver(ctx, account, msg)) };
    }

    case "email_respond": {
      assertPushAllowed(ctx.config, "email_respond");
      const parsed = respondEmailSchema.parse(args ?? {});
      const account = resolveAccount(ctx.config, parsed.account_name);
      assertCanSend(account);
      const original = await loadOriginal(
        ctx,
        account,
        parsed.email_id,
        Boolean(parsed.forward) && parsed.include_attachments !== false,
      );
      const msg = composeReply(account, original, {
        to: parsed.to,
        cc: parsed.cc,
        bcc: parsed.bcc,
        replyTo: parsed.reply_to,
        subject: parsed.subject,
        body: parsed.body,
        bodyType: parsed.body_type,
        fromEmail: parsed.from_email,
        attachments: attachmentsArg(parsed.attachments),
        replyAll: parsed.reply_all,
        forward: parsed.forward,
        quote: parsed.quote,
        includeAttachments: parsed.include_attachments,
      });
      const result = await deliver(ctx, account, msg);
      if (!parsed.forward) {
        try {
          await ctx.backend.modifyEmails(account, {
            emailIds: [parsed.email_id],
            addFlags: ["\\Answered"],
          });
        } catch (error) {
          result.warnings.push(`sent, but marking the original answered failed: ${errMessage(error)}`);
        }
      }
      return {
        sent: true,
        kind: parsed.forward ? "forward" : parsed.reply_all ? "reply_all" : "reply",
        in_reply_to: msg.inReplyTo ?? null,
        ...result,
      };
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
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: errMessage(error) }],
  };
}
