import { CFImap, type Email as CfEmail, type SearchEmailsProps } from "cf-imap";
import { WorkerMailer } from "worker-mailer";
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

function createClient(account: EmailAccount): CFImap {
  return new CFImap({
    host: account.imap.host,
    port: account.imap.port,
    tls: account.imap.secure,
    auth: {
      username: account.imap.user,
      password: account.imap.password,
    },
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

function mapEmail(
  account: EmailAccount,
  folder: string,
  email: CfEmail,
  opts: { includeContent?: boolean; includeAttachments?: boolean },
): EmailMessage {
  const flags = email.flags ?? [];
  const msg: EmailMessage = {
    id: makeId(folder, email.uid),
    uid: email.uid,
    account: account.name,
    folder,
    subject: email.subject ?? "",
    from: (email.from ?? []).join(", "),
    to: email.to ?? [],
    cc: email.cc?.length ? email.cc : undefined,
    date: email.internalDate?.toISOString?.() ?? undefined,
    flags,
    isUnread: !flags.includes("Seen"),
    isFlagged: flags.includes("Flagged"),
    snippet: (email.body?.text ?? email.body?.html ?? "").toString().slice(0, 240),
  };
  if (opts.includeContent) {
    msg.bodyText = email.body?.text;
    msg.bodyHtml = email.body?.html;
  }
  if (opts.includeAttachments && email.attachments?.length) {
    msg.attachments = email.attachments.map((a) => ({
      filename: a.filename || "attachment",
      contentType: a.mimeType,
      size: a.size,
      contentBase64: a.contentBase64,
    }));
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
  if (input.query?.trim()) {
    search.text = input.query;
  }
  if (
    !search.from &&
    !search.to &&
    !search.subject &&
    search.seen === undefined &&
    search.flagged === undefined &&
    !search.since &&
    !search.before &&
    !search.text
  ) {
    search.all = true;
  }
  return search;
}

export function createWorkerBackend(): MailBackend {
  const backend: MailBackend = {
    async listFolders(account) {
      return withImap(account, async (client) => {
        const folders = await client.getFolders("", "*");
        return folders.map(
          (f): FolderInfo => ({
            name: f.name,
            path: f.name,
            specialUse: f.attributes?.find((a) => a.startsWith("\\"))?.replace(/^\\/, ""),
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
        if (!uids.length) return [];
        const selected = uids.slice(-limit);
        const min = Math.min(...selected);
        const max = Math.max(...selected);
        const emails = await client.fetchEmails({
          folder,
          limit: [min, max],
          useUid: true,
          fetchBody: Boolean(input.includeContent || input.includeAttachments),
          peek: true,
        });
        const wanted = new Set(selected);
        return emails
          .filter((e) => wanted.has(e.uid))
          .map((e) =>
            mapEmail(account, folder, e, {
              includeContent: input.includeContent,
              includeAttachments: input.includeAttachments,
            }),
          )
          .sort((a, b) => b.uid - a.uid)
          .slice(0, limit);
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
          await client.selectFolder(folder);
          const range = uids.join(",");
          if (input.markRead) await client.storeFlags(range, ["Seen"], "add", true);
          if (input.markUnread) await client.storeFlags(range, ["Seen"], "remove", true);
          if (input.flag) await client.storeFlags(range, ["Flagged"], "add", true);
          if (input.unflag) await client.storeFlags(range, ["Flagged"], "remove", true);
          if (input.moveToFolder) await client.move(input.moveToFolder, range, true);
          updated += uids.length;
        }
      });
      return { updated };
    },

    async sendEmail(account, input: SendEmailInput) {
      if (!account.smtp) throw new Error(`account "${account.name}" has no SMTP`);
      const fromAddr = pickFromAddress(account, input.fromEmail);
      const from = account.defaultFromName
        ? { name: account.defaultFromName, email: fromAddr }
        : fromAddr;

      await WorkerMailer.send(
        {
          host: account.smtp.host,
          port: account.smtp.port,
          secure: account.smtp.secure || account.smtp.port === 465,
          startTls: !account.smtp.secure && account.smtp.port !== 465,
          credentials: {
            username: account.smtp.user,
            password: account.smtp.password,
          },
          authType: "plain",
        },
        {
          from,
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          text: input.bodyType === "html" ? undefined : input.body,
          html: input.bodyType === "html" ? input.body : undefined,
          attachments: input.attachments?.map((a) => ({
            filename: a.filename,
            content: a.content,
            mimeType: a.contentType,
          })),
        },
      );
      return { messageId: `sent-${Date.now()}` };
    },

    async respondEmail(account, input: RespondEmailInput) {
      const folder = input.folder?.trim() || parseId(input.emailId).folder;
      const { uid } = parseId(input.emailId);
      const original = await withImap(account, async (client) => {
        const emails = await client.fetchEmails({
          folder,
          limit: uid,
          useUid: true,
          fetchBody: true,
          peek: true,
        });
        const hit = emails.find((e) => e.uid === uid);
        if (!hit) throw new Error(`email not found: ${input.emailId}`);
        return hit;
      });

      const isForward = Boolean(input.forward);
      let to = input.to;
      if (!to || to.length === 0) {
        if (isForward) throw new Error("forward requires to[]");
        to = [...(original.from ?? [])];
        if (input.replyAll) {
          to = [...new Set([...to, ...(original.to ?? []), ...(original.cc ?? [])])];
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
          ? `${input.body}<br/><hr/><blockquote>${original.body?.html || original.body?.text || ""}</blockquote>`
          : `${input.body}\n\n----\n${original.body?.text ?? ""}`;

      return backend.sendEmail(account, {
        to,
        subject,
        body: quoted,
        bodyType: input.bodyType ?? "plain",
      });
    },

    async listNewSince(account, folder, afterUid, limit) {
      return withImap(account, async (client) => {
        await client.selectFolder(folder);
        const uids = await client.searchEmails({
          useUid: true,
          uid: `${afterUid + 1}:*`,
        });
        const selected = uids.filter((u) => u > afterUid).slice(-limit);
        if (!selected.length) return [];
        const min = Math.min(...selected);
        const max = Math.max(...selected);
        const emails = await client.fetchEmails({
          folder,
          limit: [min, max],
          useUid: true,
          fetchBody: false,
          peek: true,
        });
        const wanted = new Set(selected);
        return emails
          .filter((e) => wanted.has(e.uid))
          .map((e) => mapEmail(account, folder, e, {}))
          .sort((a, b) => a.uid - b.uid);
      });
    },

    async getHighestUid(account, folder) {
      return withImap(account, async (client) => {
        const status = await client.status(folder, ["UIDNEXT"]);
        const next = status.UIDNEXT ?? 1;
        return Math.max(0, next - 1);
      });
    },
  };
  return backend;
}
