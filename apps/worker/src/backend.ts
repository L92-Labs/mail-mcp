import { CFImap, type Email as CfEmail, type SearchEmailsProps } from "cf-imap";
import { Email as MimeEmail, WorkerMailer } from "worker-mailer";
import {
  KNOWN_SPECIAL_USE,
  extractAddress,
  htmlToText,
  makeEmailId,
  pageUids,
  parseEmailId,
  splitAddressList,
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

// worker-mailer 1.3.0 writes a "BCC:" header into the delivered DATA, exposing Bcc
// recipients to everyone. Bcc still reaches RCPT TO via `this.bcc`; drop the header.
(MimeEmail.prototype as unknown as { resolveBCC: () => void }).resolveBCC = function () {};

function createClient(account: EmailAccount): CFImap {
  return new CFImap({
    host: account.imap.host,
    port: account.imap.port,
    tls: account.imap.secure,
    auth: { username: account.imap.user, password: account.imap.password },
  });
}

async function withImap<T>(
  account: EmailAccount,
  fn: (client: CFImap) => Promise<T>,
): Promise<T> {
  const client = createClient(account);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** cf-imap flags come without the backslash ("Seen"); core uses "\\Seen". */
const toImapFlag = (f: string) => f.replace(/^\\/, "");
const fromImapFlag = (f: string) =>
  /^(Seen|Answered|Flagged|Deleted|Draft|Recent)$/.test(f) ? `\\${f}` : f;

function addresses(list: string[] | undefined): string[] {
  return (list ?? []).flatMap(splitAddressList);
}

function textOf(email: CfEmail): string {
  if (email.body?.text?.trim()) return email.body.text;
  return email.body?.html ? htmlToText(email.body.html) : "";
}

function headerDate(email: CfEmail): string | undefined {
  const raw = email.headers?.date;
  const d = raw ? new Date(raw) : email.internalDate;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined;
}

function summarize(
  account: EmailAccount,
  folder: string,
  email: CfEmail,
  includeContent: boolean,
  bodyFetched: boolean,
): EmailMessage {
  const flags = (email.flags ?? []).map(fromImapFlag);
  const ct = (email.contentType || email.headers?.["content-type"] || "").toLowerCase();
  const msg: EmailMessage = {
    id: makeEmailId(folder, email.uid),
    uid: email.uid,
    account: account.name,
    folder,
    subject: email.subject ?? "",
    from: addresses(email.from)[0] ?? "",
    to: addresses(email.to),
    cc: email.cc?.length ? addresses(email.cc) : undefined,
    date: headerDate(email),
    messageId: email.messageID || undefined,
    flags,
    isUnread: !flags.includes("\\Seen"),
    isFlagged: flags.includes("\\Flagged"),
    // Exact when the body was parsed; header heuristic otherwise.
    hasAttachments: bodyFetched
      ? (email.attachments ?? []).some((a) => !a.isInline)
      : ct.startsWith("multipart/mixed"),
    snippet: email.body?.text || email.body?.html
      ? textOf(email).replace(/\s+/g, " ").trim().slice(0, 240)
      : undefined,
  };
  if (includeContent) {
    msg.bodyText = textOf(email);
    msg.bodyHtml = email.body?.html;
  }
  return msg;
}

function buildSearch(input: FindEmailsInput): SearchEmailsProps {
  const search: SearchEmailsProps = { useUid: true };
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
  if (f?.hasAttachments === true) search.header = { key: "Content-Type", value: "multipart/mixed" };
  if (f?.hasAttachments === false) {
    throw new Error("has_attachments=false is not supported on the Workers runtime");
  }
  if (input.query?.trim()) search.text = input.query;
  if (Object.keys(search).length === 1) search.all = true;
  return search;
}

/** Fetch exactly these UIDs: one ranged FETCH when dense, per-UID when sparse. */
async function fetchUids(
  client: CFImap,
  folder: string,
  uids: number[],
  fetchBody: boolean,
): Promise<CfEmail[]> {
  if (uids.length === 0) return [];
  const min = Math.min(...uids);
  const max = Math.max(...uids);
  const wanted = new Set(uids);
  if (max - min + 1 <= uids.length * 2) {
    const emails = await client.fetchEmails({
      folder,
      limit: [min, max],
      useUid: true,
      fetchBody,
      peek: true,
    });
    return emails.filter((e) => wanted.has(e.uid));
  }
  const out: CfEmail[] = [];
  for (const uid of uids) {
    const hit = await client.fetchEmails({ folder, limit: uid, useUid: true, fetchBody, peek: true });
    out.push(...hit.filter((e) => e.uid === uid));
  }
  return out;
}

function normalizeSpecialUse(attributes: string[] | undefined): string | undefined {
  for (const a of attributes ?? []) {
    const v = a.startsWith("\\") ? a : `\\${a}`;
    if (KNOWN_SPECIAL_USE.has(v)) return v;
  }
  return undefined;
}

/** worker-mailer treats strings as bare addresses; "Name <a@b>" must become { name, email }. */
function toUser(value: string): { name?: string; email: string } {
  const email = extractAddress(value);
  const name = value.includes("<") ? value.slice(0, value.indexOf("<")).trim().replace(/^"|"$/g, "") : "";
  return name ? { name, email } : { email };
}

function mailerOptions(msg: OutgoingMessage, headers: Record<string, string> = {}) {
  const extra: Record<string, string> = {
    Date: msg.date.toUTCString(),
    "Message-ID": msg.messageId,
    ...headers,
  };
  if (msg.inReplyTo) extra["In-Reply-To"] = msg.inReplyTo;
  if (msg.references?.length) extra.References = msg.references.join(" ");
  return {
    from: msg.from.name ? { name: msg.from.name, email: msg.from.address } : msg.from.address,
    to: msg.to.map(toUser),
    cc: msg.cc.length ? msg.cc.map(toUser) : undefined,
    bcc: msg.bcc.length ? msg.bcc.map(toUser) : undefined,
    reply: msg.replyTo ? toUser(msg.replyTo) : undefined,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    headers: extra,
    attachments: msg.attachments.map((a) => ({
      filename: a.filename,
      content: a.contentBase64,
      mimeType: a.contentType,
    })),
  };
}

/** RFC 5322 bytes for IMAP APPEND: worker-mailer's SMTP DATA minus dot-stuffing/terminator. */
function buildRaw(msg: OutgoingMessage): string {
  const headers: Record<string, string> = msg.bcc.length ? { Bcc: msg.bcc.join(", ") } : {};
  const data = new MimeEmail(mailerOptions(msg, headers)).getEmailData();
  return data
    .replace(/\r\n\.\r\n$/, "\r\n")
    .replace(/\r\n\.\./g, "\r\n.")
    .replace(/^\.\./, ".");
}

export function createWorkerBackend(): MailBackend {
  return {
    async listFolders(account) {
      return withImap(account, async (client) => {
        const folders = await client.getFolders("", "*");
        return folders.map(
          (f): FolderInfo => ({
            name: f.name.split(f.delimiter || "/").pop() || f.name,
            path: f.name,
            specialUse: normalizeSpecialUse(f.attributes),
          }),
        );
      });
    },

    async findEmails(account, input) {
      const folder = input.folder?.trim() || "INBOX";
      const limit = input.limit ?? 20;
      return withImap(account, async (client) => {
        await client.selectFolder(folder);
        const uids = await client.searchEmails(buildSearch(input));
        const page = pageUids(uids, limit, input.cursor);
        // Bodies are needed for snippets; cf-imap has no partial fetch.
        const emails = (await fetchUids(client, folder, page.selected, true))
          .map((e) => summarize(account, folder, e, Boolean(input.includeContent), true))
          .sort((a, b) => b.uid - a.uid);
        return { emails, total: page.total, nextCursor: page.nextCursor };
      });
    },

    async getEmail(account, input) {
      const { folder: idFolder, uid } = parseEmailId(input.emailId);
      const folder = input.folder?.trim() || idFolder;
      return withImap(account, async (client) => {
        await client.selectFolder(folder);
        const [email] = await fetchUids(client, folder, [uid], true);
        if (!email) throw new Error(`email not found: ${input.emailId}`);
        if (input.markRead) await client.storeFlags(String(uid), ["Seen"], "add", true);
        const max = input.attachmentMaxBytes ?? Infinity;
        const attachments: EmailAttachment[] = (email.attachments ?? []).map((a, index) => ({
          index,
          filename: a.filename || `attachment-${index + 1}`,
          contentType: a.mimeType,
          size: a.size,
          contentId: a.contentId,
          inline: a.isInline,
          contentBase64:
            input.includeAttachmentContent && a.size <= max ? a.contentBase64 : undefined,
        }));
        const h = email.headers ?? {};
        const base = summarize(account, folder, email, true, true);
        const detail: EmailDetail = {
          ...base,
          replyTo: h["reply-to"] ? splitAddressList(h["reply-to"]) : undefined,
          inReplyTo: h["in-reply-to"]?.trim() || undefined,
          references: h.references ? h.references.split(/\s+/).filter(Boolean) : undefined,
          hasAttachments: attachments.some((a) => !a.inline),
          bodyText: base.bodyText ?? "",
          attachments,
        };
        delete detail.snippet;
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
          await client.selectFolder(folder);
          const range = uids.join(",");
          const add = [
            ...(input.markRead ? ["Seen"] : []),
            ...(input.flag ? ["Flagged"] : []),
            ...(input.addFlags ?? []).map(toImapFlag),
          ];
          const remove = [
            ...(input.markUnread ? ["Seen"] : []),
            ...(input.unflag ? ["Flagged"] : []),
          ];
          if (add.length) await client.storeFlags(range, add, "add", true);
          if (remove.length) await client.storeFlags(range, remove, "remove", true);
          if (input.moveToFolder && input.moveToFolder !== folder) {
            await client.move(input.moveToFolder, range, true);
          }
          updated += uids.length;
        }
      });
      return { updated };
    },

    async sendMessage(account, msg) {
      if (!account.smtp) throw new Error(`account "${account.name}" has no SMTP`);
      await WorkerMailer.send(
        {
          host: account.smtp.host,
          port: account.smtp.port,
          secure: account.smtp.secure || account.smtp.port === 465,
          startTls: !account.smtp.secure && account.smtp.port !== 465,
          credentials: { username: account.smtp.user, password: account.smtp.password },
          authType: "plain",
        },
        mailerOptions(msg),
      );
    },

    async appendMessage(account, folder, msg, flags) {
      const raw = buildRaw(msg);
      return withImap(account, async (client) => {
        const res = await client.append(folder, raw, flags.map(toImapFlag), msg.date);
        return { uid: res?.uid };
      });
    },

    async listNewSince(account, folder, afterUid, limit) {
      return withImap(account, async (client) => {
        await client.selectFolder(folder);
        const uids = await client.searchEmails({ useUid: true, uid: `${afterUid + 1}:*` });
        const fresh = uids.filter((u) => u > afterUid).sort((a, b) => a - b);
        const selected = fresh.slice(0, limit);
        const messages = (await fetchUids(client, folder, selected, false))
          .map((e) => summarize(account, folder, e, false, false))
          .sort((a, b) => a.uid - b.uid);
        return { messages, hasMore: fresh.length > selected.length };
      });
    },

    async getHighestUid(account, folder) {
      return withImap(account, async (client) => {
        const status = await client.status(folder, ["UIDNEXT"]);
        // cf-imap lowercases STATUS keys.
        return Math.max(0, (status.uidnext ?? status.UIDNEXT ?? 1) - 1);
      });
    },
  };
}
