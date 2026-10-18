import type {
  EmailAccount,
  EmailDetail,
  FolderInfo,
  OutgoingMessage,
  RuntimeConfig,
} from "./types.js";

// ---------- addresses ----------

/** Bare lowercase address from "Name <a@b>" or "a@b". */
export function extractAddress(value: string): string {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(value);
  return (m ? m[1]! : value).trim().replace(/^mailto:/i, "").toLowerCase();
}

export function formatAddress(name: string | undefined, address: string): string {
  if (!name?.trim() || name.trim().toLowerCase() === address.toLowerCase()) return address;
  const safe = name.replace(/["\\]/g, "").trim();
  return `"${safe}" <${address}>`;
}

/** Split a header-style list ("A <a@x>, b@y") while respecting quotes. */
export function splitAddressList(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let angle = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angle = true;
    else if (ch === ">" && !quoted) angle = false;
    if ((ch === "," || ch === ";") && !quoted && !angle) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function dedupeAddresses(list: string[], exclude: Set<string>): string[] {
  const seen = new Set(exclude);
  const out: string[] = [];
  for (const entry of list) {
    const addr = extractAddress(entry);
    if (!addr.includes("@") || seen.has(addr)) continue;
    seen.add(addr);
    out.push(entry);
  }
  return out;
}

export function selfAddresses(account: EmailAccount): Set<string> {
  const set = new Set<string>();
  for (const a of [account.smtp?.user, account.imap.user, ...(account.senderEmails ?? [])]) {
    if (a?.includes("@")) set.add(a.toLowerCase());
  }
  return set;
}

export function pickFromAddress(account: EmailAccount, fromEmail?: string): string {
  const smtpUser = account.smtp?.user ?? account.imap.user;
  if (!fromEmail) return smtpUser;
  const allow = account.senderEmails;
  if (allow && allow.length > 0 && !allow.map((a) => a.toLowerCase()).includes(fromEmail.toLowerCase())) {
    throw new Error(
      `from_email "${fromEmail}" not in sender_emails for account "${account.name}"`,
    );
  }
  return fromEmail;
}

// ---------- policy ----------

export function isRecipientAllowed(allowlist: string[], recipient: string): boolean {
  if (allowlist.length === 0 || allowlist.includes("*")) return true;
  const addr = extractAddress(recipient);
  const domain = addr.split("@")[1] ?? "";
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    if (e.includes("@") && !e.startsWith("@")) return e === addr;
    const d = e.replace(/^@/, "").replace(/^\*\./, "").replace(/^\./, "");
    return domain === d || domain.endsWith(`.${d}`);
  });
}

export function assertRecipientsAllowed(allowlist: string[], recipients: string[]): void {
  const blocked = recipients.filter((r) => !isRecipientAllowed(allowlist, r));
  if (blocked.length > 0) {
    throw new Error(
      `recipient(s) not in SEND_ALLOWLIST: ${blocked.map(extractAddress).join(", ")}. Nothing was sent.`,
    );
  }
}

const AUTO_SAVING_SMTP = /(^|\.)(gmail\.com|googlemail\.com|google\.com|office365\.com|outlook\.com|hotmail\.com|live\.com)$/i;

/** True when we should IMAP-APPEND a copy to Sent after SMTP delivery. */
export function shouldSaveSent(config: RuntimeConfig, account: EmailAccount): boolean {
  const policy = account.saveSent ?? config.saveSent;
  if (policy === "always") return true;
  if (policy === "never") return false;
  return !AUTO_SAVING_SMTP.test(account.smtp?.host ?? "");
}

// ---------- folders ----------

export type SpecialFolder = "sent" | "drafts" | "trash" | "archive" | "junk";

const SPECIAL_USE: Record<SpecialFolder, string> = {
  sent: "\\Sent",
  drafts: "\\Drafts",
  trash: "\\Trash",
  archive: "\\Archive",
  junk: "\\Junk",
};

const SPECIAL_NAMES: Record<SpecialFolder, string[]> = {
  sent: ["sent", "sent items", "sent messages", "sent mail", "envoyés", "éléments envoyés"],
  drafts: ["drafts", "draft", "brouillons"],
  trash: ["trash", "deleted items", "deleted messages", "bin", "corbeille"],
  archive: ["archive", "archives", "all mail"],
  junk: ["junk", "spam", "junk e-mail", "junk email", "bulk mail", "courrier indésirable"],
};

export const KNOWN_SPECIAL_USE = new Set(Object.values(SPECIAL_USE).concat(["\\All", "\\Flagged"]));

/** "trash", "\\Trash", "Trash" (case-insensitive) → special folder kind, else null. */
export function parseFolderAlias(value: string): SpecialFolder | null {
  const v = value.trim().replace(/^\\/, "").toLowerCase();
  if (v === "spam") return "junk";
  return (Object.keys(SPECIAL_USE) as SpecialFolder[]).includes(v as SpecialFolder)
    ? (v as SpecialFolder)
    : null;
}

export function resolveSpecialFolder(
  folders: FolderInfo[],
  kind: SpecialFolder,
): string | null {
  const byUse = folders.find((f) => f.specialUse === SPECIAL_USE[kind]);
  if (byUse) return byUse.path;
  const names = SPECIAL_NAMES[kind];
  const byName = folders.find((f) => {
    const leaf = f.path.split(/[/.]/).pop()?.toLowerCase() ?? "";
    return names.includes(leaf) || names.includes(f.name.toLowerCase());
  });
  return byName?.path ?? null;
}

// ---------- ids / cursors ----------

export function makeEmailId(folder: string, uid: number): string {
  return `${folder}:${uid}`;
}

export function parseEmailId(id: string): { folder: string; uid: number } {
  const idx = id.lastIndexOf(":");
  if (idx <= 0) throw new Error(`invalid email_id "${id}" (expected "<folder>:<uid>")`);
  const folder = id.slice(0, idx);
  const uid = Number(id.slice(idx + 1));
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new Error(`invalid email_id "${id}" (expected "<folder>:<uid>")`);
  }
  return { folder, uid };
}

/**
 * Page newest-first over ascending UIDs from SEARCH.
 * cursor = exclusive upper bound UID of the previous page.
 */
export function pageUids(
  uidsAsc: number[],
  limit: number,
  cursor?: string,
): { selected: number[]; total: number; nextCursor: string | null } {
  const sorted = [...uidsAsc].sort((a, b) => a - b);
  let pool = sorted;
  if (cursor) {
    const before = Number(cursor);
    if (!Number.isInteger(before) || before <= 0) throw new Error(`invalid cursor "${cursor}"`);
    pool = sorted.filter((u) => u < before);
  }
  const selected = pool.slice(-limit);
  const hasMore = pool.length > selected.length;
  return {
    selected,
    total: sorted.length,
    nextCursor: hasMore && selected.length > 0 ? String(selected[0]) : null,
  };
}

// ---------- text ----------

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (max <= 0 || text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n…[truncated]`, truncated: true };
}

// ---------- composition ----------

export function newMessageId(fromAddress: string): string {
  const domain = fromAddress.split("@")[1] || "mail-mcp.local";
  return `<${crypto.randomUUID()}@${domain}>`;
}

export type ComposeInput = {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject?: string;
  body: string;
  bodyType?: "plain" | "html";
  fromEmail?: string;
  attachments?: Array<{ filename: string; content: string; contentType?: string }>;
};

function fromFor(account: EmailAccount, fromEmail?: string): OutgoingMessage["from"] {
  return { name: account.defaultFromName, address: pickFromAddress(account, fromEmail) };
}

function bodies(body: string, bodyType: "plain" | "html" | undefined) {
  return bodyType === "html" ? { text: htmlToText(body), html: body } : { text: body };
}

export function composeNew(account: EmailAccount, input: ComposeInput): OutgoingMessage {
  const from = fromFor(account, input.fromEmail);
  return {
    from,
    to: dedupeAddresses(input.to ?? [], new Set()),
    cc: dedupeAddresses(input.cc ?? [], new Set()),
    bcc: dedupeAddresses(input.bcc ?? [], new Set()),
    replyTo: input.replyTo,
    subject: input.subject ?? "",
    ...bodies(input.body, input.bodyType),
    messageId: newMessageId(from.address),
    date: new Date(),
    attachments: (input.attachments ?? []).map((a) => ({
      filename: a.filename,
      contentBase64: a.content,
      contentType: a.contentType,
    })),
  };
}

export type ReplyInput = ComposeInput & {
  replyAll?: boolean;
  forward?: boolean;
  /** Quote the original below the new body (default true). */
  quote?: boolean;
  /** Forward only: carry the original's attachments (default true). */
  includeAttachments?: boolean;
};

function prefixSubject(prefix: "Re" | "Fwd", subject: string): string {
  const re = prefix === "Re" ? /^\s*(re|aw|sv|antw)\s*:/i : /^\s*(fwd?|tr|wg)\s*:/i;
  return re.test(subject) ? subject : `${prefix}: ${subject}`;
}

function quoteHeader(original: EmailDetail): string {
  const when = original.date ? new Date(original.date).toUTCString() : "an earlier date";
  return `On ${when}, ${original.from} wrote:`;
}

/** Build a reply or forward of `original`, with RFC 5322 threading headers. */
export function composeReply(
  account: EmailAccount,
  original: EmailDetail,
  input: ReplyInput,
): OutgoingMessage {
  const from = fromFor(account, input.fromEmail);
  const self = selfAddresses(account);
  self.add(from.address.toLowerCase());
  const isForward = Boolean(input.forward);
  const quote = input.quote !== false;

  let to: string[];
  let cc: string[] = input.cc ?? [];
  if (isForward) {
    if (!input.to?.length) throw new Error("forward requires to[]");
    to = input.to;
  } else if (input.to?.length) {
    to = input.to;
  } else {
    const sentBySelf = self.has(extractAddress(original.from));
    // Replying to our own message continues the conversation with its recipients.
    to = sentBySelf ? original.to : original.replyTo?.length ? original.replyTo : [original.from];
    if (input.replyAll) {
      cc = [...cc, ...(sentBySelf ? [] : original.to), ...(original.cc ?? [])];
    }
  }

  const explicitTo = isForward || Boolean(input.to?.length);
  let toList = dedupeAddresses(to, explicitTo ? new Set() : self);
  // A note-to-self thread (from me, to me) keeps replying to me.
  if (toList.length === 0 && !explicitTo) toList = dedupeAddresses(to, new Set());
  const toSet = new Set(toList.map(extractAddress));
  const ccList = dedupeAddresses(cc, new Set([...self, ...toSet]));
  if (toList.length === 0) {
    throw new Error("no recipients left for reply (all were your own addresses); pass to[]");
  }

  const subject =
    input.subject ?? prefixSubject(isForward ? "Fwd" : "Re", original.subject || "");

  const own = bodies(input.body, input.bodyType);
  let text = own.text;
  let html = own.html;
  if (quote || isForward) {
    const origText = original.bodyText ?? "";
    if (isForward) {
      const header = [
        "---------- Forwarded message ---------",
        `From: ${original.from}`,
        original.date ? `Date: ${new Date(original.date).toUTCString()}` : null,
        `Subject: ${original.subject}`,
        `To: ${original.to.join(", ")}`,
        original.cc?.length ? `Cc: ${original.cc.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      text = `${text}\n\n${header}\n\n${origText}`;
      if (html !== undefined) {
        const origHtml = original.bodyHtml ?? `<pre>${escapeHtml(origText)}</pre>`;
        html = `${html}<br><br><div>${escapeHtml(header).replace(/\n/g, "<br>")}</div><br>${origHtml}`;
      }
    } else {
      const quoted = origText
        .split(/\r?\n/)
        .map((l) => `> ${l}`)
        .join("\n");
      text = `${text}\n\n${quoteHeader(original)}\n${quoted}`;
      if (html !== undefined) {
        const origHtml =
          original.bodyHtml ?? escapeHtml(origText).replace(/\r?\n/g, "<br>");
        html = `${html}<br><div>${escapeHtml(quoteHeader(original))}</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${origHtml}</blockquote>`;
      }
    }
  }

  const attachments = (input.attachments ?? []).map((a) => ({
    filename: a.filename,
    contentBase64: a.content,
    contentType: a.contentType,
  }));
  if (isForward && input.includeAttachments !== false) {
    for (const a of original.attachments) {
      if (!a.contentBase64) {
        throw new Error(
          `cannot forward attachment "${a.filename}" (${a.size ?? "?"} bytes): exceeds ATTACHMENT_MAX_BYTES; pass include_attachments=false`,
        );
      }
      attachments.push({
        filename: a.filename,
        contentBase64: a.contentBase64,
        contentType: a.contentType,
      });
    }
  }

  const msg: OutgoingMessage = {
    from,
    to: toList,
    cc: ccList,
    bcc: dedupeAddresses(input.bcc ?? [], new Set()),
    replyTo: input.replyTo,
    subject,
    text,
    html,
    messageId: newMessageId(from.address),
    date: new Date(),
    attachments,
  };
  if (!isForward && original.messageId) {
    msg.inReplyTo = original.messageId;
    // RFC 5322 §3.6.4: parent's References + parent's Message-ID. Keep the root + recent tail.
    const refs = [...(original.references ?? []), original.messageId].filter(
      (v, i, arr) => arr.indexOf(v) === i,
    );
    msg.references = refs.length > 20 ? [refs[0]!, ...refs.slice(-19)] : refs;
  }
  return msg;
}

export function allRecipients(msg: OutgoingMessage): string[] {
  return [...msg.to, ...msg.cc, ...msg.bcc];
}
