import { z } from "zod";
import type { MailMode } from "./types.js";

const accountName = z
  .string()
  .optional()
  .describe("Account name from accounts_list. Omit for the default account.");
const folder = z
  .string()
  .optional()
  .describe('IMAP folder path, e.g. "INBOX" (default). Use folders_list for exact paths.');
const emailId = z
  .string()
  .min(1)
  .describe('Email id as returned by emails_find / emails_events, format "<folder>:<uid>".');
const addressList = (what: string) =>
  z.array(z.string()).describe(`${what}: "a@b.com" or "Name <a@b.com>".`);
const body = z.string().describe("Message body. Plain text unless body_type=html.");
const bodyType = z
  .enum(["plain", "html"])
  .optional()
  .describe("plain (default) or html. HTML also gets an auto-generated text part.");
const attachments = z
  .array(
    z.object({
      filename: z.string(),
      content: z.string().describe("File content, base64-encoded."),
      content_type: z.string().optional().describe('MIME type, e.g. "application/pdf".'),
    }),
  )
  .optional()
  .describe("Files to attach.");
const fromEmail = z
  .string()
  .optional()
  .describe("Send-as address; must be listed in the account's sender_emails.");
const replyTo = z.string().optional().describe("Reply-To header address.");

export const accountsListSchema = z.object({});

export const foldersListSchema = z.object({ account_name: accountName });

export const findEmailsSchema = z.object({
  account_name: accountName,
  folder,
  query: z
    .string()
    .optional()
    .describe("Free text matched (server-side) against subject, body, from and to."),
  filters: z
    .object({
      from: z.string().optional().describe("Sender contains"),
      to: z.string().optional().describe("Recipient contains"),
      subject: z.string().optional().describe("Subject contains"),
      has_attachments: z.boolean().optional(),
      is_unread: z.boolean().optional(),
      is_flagged: z.boolean().optional(),
      after_date: z.string().optional().describe("ISO date, inclusive (IMAP SINCE)"),
      before_date: z.string().optional().describe("ISO date, exclusive (IMAP BEFORE)"),
    })
    .optional(),
  limit: z.number().int().min(1).max(100).optional().describe("Page size, default 20, max 100."),
  cursor: z
    .string()
    .optional()
    .describe("Pass next_cursor from the previous page to get older results."),
  include_content: z
    .boolean()
    .optional()
    .describe("Include full bodies (slower). Prefer email_get for single messages."),
});

export const getEmailSchema = z.object({
  account_name: accountName,
  email_id: emailId,
  include_html: z.boolean().optional().describe("Also return the raw HTML body (default false)."),
  max_chars: z
    .number()
    .int()
    .min(100)
    .optional()
    .describe("Truncate body text to this many characters (default MAX_BODY_CHARS)."),
  include_attachment_content: z
    .boolean()
    .optional()
    .describe("Return base64 content for attachments up to ATTACHMENT_MAX_BYTES."),
  mark_read: z.boolean().optional().describe("Mark the message as read (default false)."),
});

export const modifyEmailsSchema = z.object({
  account_name: accountName,
  folder: z
    .string()
    .optional()
    .describe("Override the folder encoded in email_ids (rarely needed)."),
  email_ids: z.array(z.string()).min(1).describe('Email ids, "<folder>:<uid>".'),
  mark_read: z.boolean().optional(),
  mark_unread: z.boolean().optional(),
  flag: z.boolean().optional().describe("Star / flag"),
  unflag: z.boolean().optional(),
  move_to_folder: z
    .string()
    .optional()
    .describe(
      'Destination folder path, or an alias: "archive", "trash", "junk", "inbox". Moving changes the email id.',
    ),
});

export const eventsSchema = z.object({
  account_name: accountName,
  folder,
  after_uid: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Return messages with UID greater than this. Pass next_after_uid from the previous call (stateless). Omit to use the server-side cursor; the first call returns the current watermark and no messages.",
    ),
  limit: z.number().int().min(1).max(100).optional().describe("Max messages, default 20."),
  advance: z
    .boolean()
    .optional()
    .describe("Server-side cursor only: advance after reading (default true)."),
});

export const sendEmailSchema = z.object({
  account_name: accountName,
  to: addressList("Recipients").min(1),
  cc: addressList("Cc").optional(),
  bcc: addressList("Bcc (hidden from other recipients)").optional(),
  subject: z.string().min(1),
  body,
  body_type: bodyType,
  from_email: fromEmail,
  reply_to: replyTo,
  attachments,
});

export const respondEmailSchema = z.object({
  account_name: accountName,
  email_id: emailId.describe('Email to reply to or forward, "<folder>:<uid>".'),
  body: body.describe("Your new text; the original is quoted below it."),
  body_type: bodyType,
  reply_all: z.boolean().optional().describe("Also reply to the original To/Cc (minus you)."),
  forward: z.boolean().optional().describe("Forward instead of reply; requires to[]."),
  to: addressList("Override recipients (required for forward)").optional(),
  cc: addressList("Extra Cc").optional(),
  bcc: addressList("Bcc").optional(),
  subject: z.string().optional().describe('Override subject (default "Re: …" / "Fwd: …").'),
  quote: z.boolean().optional().describe("Quote the original message (default true)."),
  include_attachments: z
    .boolean()
    .optional()
    .describe("Forward only: carry the original attachments (default true)."),
  attachments,
  from_email: fromEmail,
  reply_to: replyTo,
});

export const draftEmailSchema = z.object({
  account_name: accountName,
  email_id: z
    .string()
    .optional()
    .describe("Set to draft a reply/forward of this email (threaded). Omit for a new message."),
  reply_all: z.boolean().optional(),
  forward: z.boolean().optional(),
  quote: z.boolean().optional().describe("Reply drafts: quote the original (default true)."),
  include_attachments: z.boolean().optional(),
  to: addressList("Recipients").optional(),
  cc: addressList("Cc").optional(),
  bcc: addressList("Bcc").optional(),
  subject: z.string().optional(),
  body,
  body_type: bodyType,
  from_email: fromEmail,
  reply_to: replyTo,
  attachments,
});

export const TOOL_NAMES = [
  "accounts_list",
  "folders_list",
  "emails_find",
  "email_get",
  "emails_modify",
  "emails_events",
  "email_draft",
  "email_send",
  "email_respond",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const PUSH_TOOLS = new Set<ToolName>(["email_send", "email_respond"]);
export const DRAFT_TOOLS = new Set<ToolName>(["email_draft"]);

export function toolsForMode(mode: MailMode): ToolName[] {
  return TOOL_NAMES.filter((t) => {
    if (PUSH_TOOLS.has(t)) return mode === "pull_push";
    if (DRAFT_TOOLS.has(t)) return mode !== "pull";
    return true;
  });
}
