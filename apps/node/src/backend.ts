import { ImapFlow, type SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import {
  pickFromAddress,
  type EmailAccount,
  type EmailMessage,
  type FindEmailsInput,
  type FolderInfo,
  type MailBackend,
  type ModifyEmailsInput,
  type RespondEmailInput,
  type SendEmailInput,
} from "@mail-mcp/core";

function parseId(id: string): { folder: string; uid: number } {
  const idx = id.lastIndexOf(":");
  if (idx <= 0) throw new Error(`invalid email id: ${id}`);
  const folder = id.slice(0, idx);
  const uid = Number(id.slice(idx + 1));
  if (!Number.isFinite(uid)) throw new Error(`invalid email id: ${id}`);
  return { folder, uid };
}

function makeId(folder: string, uid: number): string {
  return `${folder}:${uid}`;
}

async function withImap<T>(
  account: EmailAccount,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: {
      user: account.imap.user,
      pass: account.imap.password,
    },
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
  if (input.query?.trim()) {
    search.or = [
      { subject: input.query },
      { body: input.query },
      { from: input.query },
      { to: input.query },
    ];
  }
  if (Object.keys(search).length === 0) {
    search.all = true;
  }
  return search;
}

async function sourceToMessage(
  account: EmailAccount,
  folder: string,
  source: Buffer,
  uid: number,
  flags: Set<string> | string[] | undefined,
  opts: { includeContent?: boolean; includeAttachments?: boolean },
): Promise<EmailMessage> {
  const parsed = await simpleParser(source);
  const flagList = flags ? [...flags] : [];
  const msg: EmailMessage = {
    id: makeId(folder, uid),
    uid,
    account: account.name,
    folder,
    subject: parsed.subject ?? "",
    from: parsed.from?.text ?? "",
    to: parsed.to
      ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]).flatMap((a) =>
          "text" in a && a.text ? [a.text] : [],
        )
      : [],
    cc: parsed.cc
      ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]).flatMap((a) =>
          "text" in a && a.text ? [a.text] : [],
        )
      : undefined,
    date: parsed.date?.toISOString(),
    flags: flagList,
    isUnread: !flagList.includes("\\Seen"),
    isFlagged: flagList.includes("\\Flagged"),
    snippet: (parsed.text ?? parsed.html ?? "").toString().slice(0, 240),
  };
  if (opts.includeContent) {
    msg.bodyText = parsed.text ?? undefined;
    msg.bodyHtml = typeof parsed.html === "string" ? parsed.html : undefined;
  }
  if (opts.includeAttachments && parsed.attachments?.length) {
    msg.attachments = parsed.attachments.map((a) => ({
      filename: a.filename ?? "attachment",
      contentType: a.contentType,
      size: a.size,
      contentBase64: a.content.toString("base64"),
    }));
  }
  return msg;
}

export function createNodeBackend(): MailBackend {
  const backend: MailBackend = {
    async listFolders(account) {
      return withImap(account, async (client) => {
        const boxes = await client.list();
        return boxes.map(
          (b): FolderInfo => ({
            name: b.name,
            path: b.path,
            specialUse: b.specialUse || undefined,
          }),
        );
      });
    },

    async findEmails(account, input) {
      const folder = input.folder?.trim() || "INBOX";
      const limit = input.limit ?? 20;
      return withImap(account, async (client) => {
        const lock = await client.getMailboxLock(folder);
        try {
          const uids = await client.search(buildSearch(input), { uid: true });
          if (!uids || uids.length === 0) return [];
          const selected = uids.slice(-limit);
          const out: EmailMessage[] = [];
          for await (const msg of client.fetch(
            selected,
            { uid: true, flags: true, source: true, envelope: true },
            { uid: true },
          )) {
            if (!msg.source || msg.uid === undefined) continue;
            out.push(
              await sourceToMessage(
                account,
                folder,
                Buffer.from(msg.source),
                msg.uid,
                msg.flags,
                {
                  includeContent: input.includeContent,
                  includeAttachments: input.includeAttachments,
                },
              ),
            );
          }
          out.sort((a, b) => b.uid - a.uid);
          return out;
        } finally {
          lock.release();
        }
      });
    },

    async modifyEmails(account, input: ModifyEmailsInput) {
      const byFolder = new Map<string, number[]>();
      for (const id of input.emailIds) {
        const parsed = parseId(id);
        const folder = input.folder?.trim() || parsed.folder;
        const list = byFolder.get(folder) ?? [];
        list.push(parsed.uid);
        byFolder.set(folder, list);
      }

      let updated = 0;
      await withImap(account, async (client) => {
        for (const [folder, uids] of byFolder) {
          const lock = await client.getMailboxLock(folder);
          try {
            if (input.markRead) {
              await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
            }
            if (input.markUnread) {
              await client.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
            }
            if (input.flag) {
              await client.messageFlagsAdd(uids, ["\\Flagged"], { uid: true });
            }
            if (input.unflag) {
              await client.messageFlagsRemove(uids, ["\\Flagged"], { uid: true });
            }
            if (input.moveToFolder) {
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

    async sendEmail(account, input: SendEmailInput) {
      if (!account.smtp) throw new Error(`account "${account.name}" has no SMTP`);
      const fromAddr = pickFromAddress(account, input.fromEmail);
      const from = account.defaultFromName
        ? `"${account.defaultFromName}" <${fromAddr}>`
        : fromAddr;
      const transport = nodemailer.createTransport({
        host: account.smtp.host,
        port: account.smtp.port,
        secure: account.smtp.secure,
        auth: {
          user: account.smtp.user,
          pass: account.smtp.password,
        },
      });
      const info = await transport.sendMail({
        from,
        to: input.to.join(", "),
        cc: input.cc?.join(", "),
        bcc: input.bcc?.join(", "),
        subject: input.subject,
        text: input.bodyType === "html" ? undefined : input.body,
        html: input.bodyType === "html" ? input.body : undefined,
        attachments: input.attachments?.map((a) => ({
          filename: a.filename,
          content: Buffer.from(a.content, "base64"),
          contentType: a.contentType,
        })),
      });
      return { messageId: String(info.messageId ?? "sent") };
    },

    async respondEmail(account, input: RespondEmailInput) {
      const folder = input.folder?.trim() || parseId(input.emailId).folder;
      const { uid } = parseId(input.emailId);
      const original = await withImap(account, async (client) => {
        const lock = await client.getMailboxLock(folder);
        try {
          for await (const msg of client.fetch(
            String(uid),
            { uid: true, source: true },
            { uid: true },
          )) {
            if (!msg.source) continue;
            return simpleParser(Buffer.from(msg.source));
          }
          throw new Error(`email not found: ${input.emailId}`);
        } finally {
          lock.release();
        }
      });

      const isForward = Boolean(input.forward);
      let to = input.to;
      if (!to || to.length === 0) {
        if (isForward) throw new Error("forward requires to[]");
        const replyTo =
          original.replyTo?.text ||
          original.from?.text ||
          "";
        to = [replyTo].filter(Boolean);
        if (input.replyAll) {
          const extras = [
            ...(original.to
              ? (Array.isArray(original.to) ? original.to : [original.to]).map(
                  (a) => ("text" in a ? a.text : ""),
                )
              : []),
            ...(original.cc
              ? (Array.isArray(original.cc) ? original.cc : [original.cc]).map(
                  (a) => ("text" in a ? a.text : ""),
                )
              : []),
          ].filter(Boolean) as string[];
          to = [...new Set([...to, ...extras])];
        }
      }
      if (to.length === 0) throw new Error("no recipients for reply");

      const subject =
        input.subject ??
        (isForward
          ? `Fwd: ${original.subject ?? ""}`
          : original.subject?.toLowerCase().startsWith("re:")
            ? original.subject
            : `Re: ${original.subject ?? ""}`);

      const quoted =
        input.bodyType === "html"
          ? `${input.body}<br/><hr/><blockquote>${original.html || original.text || ""}</blockquote>`
          : `${input.body}\n\n----\n${original.text ?? ""}`;

      return backend.sendEmail(account, {
        to,
        subject,
        body: quoted,
        bodyType: input.bodyType ?? "plain",
      });
    },

    async listNewSince(account, folder, afterUid, limit) {
      return withImap(account, async (client) => {
        const lock = await client.getMailboxLock(folder);
        try {
          const uids = await client.search({ uid: `${afterUid + 1}:*` }, { uid: true });
          if (!uids || uids.length === 0) return [];
          const selected = uids.filter((u) => u > afterUid).slice(-limit);
          if (selected.length === 0) return [];
          const out: EmailMessage[] = [];
          for await (const msg of client.fetch(
            selected,
            { uid: true, flags: true, source: true },
            { uid: true },
          )) {
            if (!msg.source || msg.uid === undefined) continue;
            out.push(
              await sourceToMessage(account, folder, Buffer.from(msg.source), msg.uid, msg.flags, {}),
            );
          }
          out.sort((a, b) => a.uid - b.uid);
          return out;
        } finally {
          lock.release();
        }
      });
    },

    async getHighestUid(account, folder) {
      return withImap(account, async (client) => {
        const lock = await client.getMailboxLock(folder);
        try {
          const status = await client.status(folder, { uidNext: true });
          const next = status.uidNext ?? 1;
          return Math.max(0, next - 1);
        } finally {
          lock.release();
        }
      });
    },
  };
  return backend;
}
