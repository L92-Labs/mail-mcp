import {
  ImapFlow,
  type FetchMessageObject,
  type MessageAddressObject,
  type MessageStructureObject,
  type SearchObject,
} from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";
import {
  KNOWN_SPECIAL_USE,
  formatAddress,
  htmlToText,
  makeEmailId,
  pageUids,
  parseEmailId,
  type EmailAccount,
  type EmailAttachment,
  type EmailDetail,
  type EmailMessage,
  type FindEmailsInput,
  type FolderInfo,
  type MailBackend,
  type ModifyEmailsInput,
  type OutgoingMessage,
} from "@mail-mcp/core";

/** Bytes of raw source fetched per list item to build a snippet (headers + start of body). */
const SNIPPET_SOURCE_BYTES = 24_576;

async function withImap<T>(
  account: EmailAccount,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: { user: account.imap.user, pass: account.imap.password },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

async function inFolder<T>(
  account: EmailAccount,
  folder: string,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  });
}

function buildSearch(input: FindEmailsInput): SearchObject {
  const search: SearchObject = {};
  const f = input.filters;
  if (f?.from) search.from = f.from;
  if (f?.to) search.to = f.to;
  if (f?.subject) search.subject = f.subject;
  if (f?.isUnread === true) search.seen = false;
  if (f?.isUnread === false) search.seen = true;
  if (f?.isFlagged === true) search.flagged = true;
  if (f?.isFlagged === false) search.flagged = false;
  if (f?.afterDate) search.since = new Date(f.afterDate);
  if (f?.beforeDate) search.before = new Date(f.beforeDate);
  // Server-side approximation: messages with attachments are multipart/mixed.
  if (f?.hasAttachments === true) search.header = { "content-type": "multipart/mixed" };
  if (f?.hasAttachments === false) search.not = { header: { "content-type": "multipart/mixed" } };
  if (input.query?.trim()) {
    search.or = [
      { subject: input.query },
      { body: input.query },
      { from: input.query },
      { to: input.query },
    ];
  }
  if (Object.keys(search).length === 0) search.all = true;
  return search;
}

function envAddresses(list?: MessageAddressObject[]): string[] {
  return (list ?? []).flatMap((a) => (a.address ? [formatAddress(a.name, a.address)] : []));
}

function parsedAddresses(value?: AddressObject | AddressObject[]): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((obj) =>
    obj.value.flatMap((a) => (a.address ? [formatAddress(a.name, a.address)] : [])),
  );
}

function hasAttachment(node?: MessageStructureObject): boolean {
  if (!node) return false;
  if (node.disposition?.toLowerCase() === "attachment") return true;
  if (!node.childNodes && !node.type.startsWith("text/") && !node.type.startsWith("multipart/")) {
    return Boolean(node.dispositionParameters?.filename || node.parameters?.name);
  }
  return (node.childNodes ?? []).some(hasAttachment);
}

function flagState(flags: Set<string> | undefined) {
  const list = flags ? [...flags] : [];
  return {
    flags: list,
    isUnread: !list.includes("\\Seen"),
    isFlagged: list.includes("\\Flagged"),
  };
}

function isoDate(value?: Date | string): string | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function textOf(parsed: ParsedMail): string {
  if (parsed.text?.trim()) return parsed.text;
  return typeof parsed.html === "string" ? htmlToText(parsed.html) : "";
}

function snippetOf(parsed: ParsedMail): string {
  return textOf(parsed).replace(/\s+/g, " ").trim().slice(0, 240);
}

async function summarize(
  account: EmailAccount,
  folder: string,
  msg: FetchMessageObject,
  includeContent: boolean,
): Promise<EmailMessage> {
  const env = msg.envelope;
  let parsed: ParsedMail | undefined;
  if (msg.source) {
    try {
      parsed = await simpleParser(Buffer.from(msg.source));
    } catch {
      parsed = undefined;
    }
  }
  const out: EmailMessage = {
    id: makeEmailId(folder, msg.uid),
    uid: msg.uid,
    account: account.name,
    folder,
    subject: env?.subject ?? parsed?.subject ?? "",
    from: envAddresses(env?.from)[0] ?? parsed?.from?.text ?? "",
    to: envAddresses(env?.to),
    cc: env?.cc?.length ? envAddresses(env.cc) : undefined,
    date: isoDate(env?.date ?? msg.internalDate),
    messageId: env?.messageId,
    ...flagState(msg.flags),
    hasAttachments: hasAttachment(msg.bodyStructure),
    snippet: parsed ? snippetOf(parsed) : undefined,
  };
  if (includeContent && parsed) {
    out.bodyText = textOf(parsed);
    out.bodyHtml = typeof parsed.html === "string" ? parsed.html : undefined;
  }
  return out;
}

/** Normalize to RFC 6154 "\\Sent"-style attributes only. */
function normalizeSpecialUse(value?: string): string | undefined {
  if (!value) return undefined;
  const v = value.startsWith("\\") ? value : `\\${value}`;
  return KNOWN_SPECIAL_USE.has(v) ? v : undefined;
}

function toMailOptions(msg: OutgoingMessage): Mail.Options {
  return {
    from: msg.from.name ? { name: msg.from.name, address: msg.from.address } : msg.from.address,
    to: msg.to,
    cc: msg.cc.length ? msg.cc : undefined,
    bcc: msg.bcc.length ? msg.bcc : undefined,
    replyTo: msg.replyTo,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    messageId: msg.messageId,
    date: msg.date,
    inReplyTo: msg.inReplyTo,
    references: msg.references,
    attachments: msg.attachments.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.contentBase64, "base64"),
      contentType: a.contentType,
    })),
  };
}

/** RFC 5322 bytes for IMAP APPEND. Keeps Bcc (only the sender's own copy sees it). */
async function buildRaw(msg: OutgoingMessage): Promise<Buffer> {
  const node = new MailComposer(toMailOptions(msg)).compile();
  (node as unknown as { keepBcc: boolean }).keepBcc = true;
  return new Promise((resolve, reject) => {
    node.build((err, buf) => (err ? reject(err) : resolve(buf)));
  });
}

export function createNodeBackend(): MailBackend {
  return {
    async listFolders(account) {
      return withImap(account, async (client) => {
        const boxes = await client.list();
        return boxes.map(
          (b): FolderInfo => ({
            name: b.name,
            path: b.path,
            specialUse: normalizeSpecialUse(b.specialUse),
          }),
        );
      });
    },

    async findEmails(account, input) {
      const folder = input.folder?.trim() || "INBOX";
      const limit = input.limit ?? 20;
      return inFolder(account, folder, async (client) => {
        const uids = (await client.search(buildSearch(input), { uid: true })) || [];
        const page = pageUids(uids, limit, input.cursor);
        if (page.selected.length === 0) {
          return { emails: [], total: page.total, nextCursor: page.nextCursor };
        }
        const emails: EmailMessage[] = [];
        for await (const msg of client.fetch(
          page.selected,
          {
            uid: true,
            flags: true,
            envelope: true,
            bodyStructure: true,
            internalDate: true,
            source: input.includeContent ? true : { maxLength: SNIPPET_SOURCE_BYTES },
          },
          { uid: true },
        )) {
          emails.push(await summarize(account, folder, msg, Boolean(input.includeContent)));
        }
        emails.sort((a, b) => b.uid - a.uid);
        return { emails, total: page.total, nextCursor: page.nextCursor };
      });
    },

    async getEmail(account, input) {
      const { folder: idFolder, uid } = parseEmailId(input.emailId);
      const folder = input.folder?.trim() || idFolder;
      return inFolder(account, folder, async (client) => {
        const msg = await client.fetchOne(
          String(uid),
          { uid: true, flags: true, source: true, internalDate: true },
          { uid: true },
        );
        if (!msg || !msg.source) throw new Error(`email not found: ${input.emailId}`);
        if (input.markRead) await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
        const parsed = await simpleParser(Buffer.from(msg.source));
        const max = input.attachmentMaxBytes ?? Infinity;
        const attachments: EmailAttachment[] = parsed.attachments.map((a, index) => ({
          index,
          filename: a.filename ?? `attachment-${index + 1}`,
          contentType: a.contentType,
          size: a.size,
          contentId: a.cid,
          inline: a.contentDisposition === "inline",
          contentBase64:
            input.includeAttachmentContent && a.size <= max
              ? a.content.toString("base64")
              : undefined,
        }));
        const refs = parsed.references;
        const detail: EmailDetail = {
          id: makeEmailId(folder, uid),
          uid,
          account: account.name,
          folder,
          subject: parsed.subject ?? "",
          from: parsedAddresses(parsed.from)[0] ?? "",
          to: parsedAddresses(parsed.to),
          cc: parsed.cc ? parsedAddresses(parsed.cc) : undefined,
          replyTo: parsed.replyTo ? parsedAddresses(parsed.replyTo) : undefined,
          date: isoDate(parsed.date ?? msg.internalDate),
          messageId: parsed.messageId,
          inReplyTo: parsed.inReplyTo,
          references: refs ? (Array.isArray(refs) ? refs : refs.split(/\s+/)).filter(Boolean) : undefined,
          ...flagState(msg.flags),
          hasAttachments: attachments.length > 0,
          bodyText: textOf(parsed),
          bodyHtml: typeof parsed.html === "string" ? parsed.html : undefined,
          attachments,
        };
        if (input.markRead) {
          detail.isUnread = false;
          if (!detail.flags?.includes("\\Seen")) detail.flags = [...(detail.flags ?? []), "\\Seen"];
        }
        return detail;
      });
    },

    async modifyEmails(account, input: ModifyEmailsInput) {
      const byFolder = new Map<string, number[]>();
      for (const id of input.emailIds) {
        const parsed = parseEmailId(id);
        const folder = input.folder?.trim() || parsed.folder;
        byFolder.set(folder, [...(byFolder.get(folder) ?? []), parsed.uid]);
      }
      let updated = 0;
      await withImap(account, async (client) => {
        for (const [folder, uids] of byFolder) {
          const lock = await client.getMailboxLock(folder);
          try {
            const add = [
              ...(input.markRead ? ["\\Seen"] : []),
              ...(input.flag ? ["\\Flagged"] : []),
              ...(input.addFlags ?? []),
            ];
            const remove = [
              ...(input.markUnread ? ["\\Seen"] : []),
              ...(input.unflag ? ["\\Flagged"] : []),
            ];
            if (add.length) await client.messageFlagsAdd(uids, add, { uid: true });
            if (remove.length) await client.messageFlagsRemove(uids, remove, { uid: true });
            if (input.moveToFolder && input.moveToFolder !== folder) {
              await client.messageMove(uids, input.moveToFolder, { uid: true });
            }
            updated += uids.length;
          } finally {
            lock.release();
          }
        }
      });
      return { updated };
    },

    async sendMessage(account, msg) {
      if (!account.smtp) throw new Error(`account "${account.name}" has no SMTP`);
      const transport = nodemailer.createTransport({
        host: account.smtp.host,
        port: account.smtp.port,
        secure: account.smtp.secure,
        auth: { user: account.smtp.user, pass: account.smtp.password },
      });
      try {
        await transport.sendMail(toMailOptions(msg));
      } finally {
        transport.close();
      }
    },

    async appendMessage(account, folder, msg, flags) {
      const raw = await buildRaw(msg);
      return withImap(account, async (client) => {
        const res = await client.append(folder, raw, flags, msg.date);
        return { uid: res ? res.uid : undefined };
      });
    },

    async listNewSince(account, folder, afterUid, limit) {
      return inFolder(account, folder, async (client) => {
        const uids = (await client.search({ uid: `${afterUid + 1}:*` }, { uid: true })) || [];
        // "N:*" returns the last message even when N > max UID; filter it out.
        const fresh = uids.filter((u) => u > afterUid).sort((a, b) => a - b);
        const selected = fresh.slice(0, limit);
        if (selected.length === 0) return { messages: [], hasMore: false };
        const messages: EmailMessage[] = [];
        for await (const msg of client.fetch(
          selected,
          {
            uid: true,
            flags: true,
            envelope: true,
            bodyStructure: true,
            internalDate: true,
            source: { maxLength: SNIPPET_SOURCE_BYTES },
          },
          { uid: true },
        )) {
          messages.push(await summarize(account, folder, msg, false));
        }
        messages.sort((a, b) => a.uid - b.uid);
        return { messages, hasMore: fresh.length > selected.length };
      });
    },

    async getHighestUid(account, folder) {
      return withImap(account, async (client) => {
        const status = await client.status(folder, { uidNext: true });
        return Math.max(0, (status.uidNext ?? 1) - 1);
      });
    },
  };
}
