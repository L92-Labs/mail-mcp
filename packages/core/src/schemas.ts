import { z } from "zod";

export const findEmailsSchema = z.object({
  account_name: z.string().optional(),
  folder: z.string().optional(),
  query: z.string().optional(),
  filters: z
    .object({
      from: z.string().optional(),
      to: z.string().optional(),
      subject: z.string().optional(),
      has_attachments: z.boolean().optional(),
      is_unread: z.boolean().optional(),
      is_flagged: z.boolean().optional(),
      after_date: z.string().optional(),
      before_date: z.string().optional(),
    })
    .optional(),
  limit: z.number().int().min(1).max(100).optional(),
  include_content: z.boolean().optional(),
  include_attachments: z.boolean().optional(),
});

export const modifyEmailsSchema = z.object({
  account_name: z.string().optional(),
  folder: z.string().optional(),
  email_ids: z.array(z.string()).min(1),
  mark_read: z.boolean().optional(),
  mark_unread: z.boolean().optional(),
  flag: z.boolean().optional(),
  unflag: z.boolean().optional(),
  move_to_folder: z.string().optional(),
});

export const sendEmailSchema = z.object({
  account_name: z.string().optional(),
  to: z.array(z.string()).min(1),
  subject: z.string().min(1),
  body: z.string(),
  body_type: z.enum(["plain", "html"]).optional(),
  from_email: z.string().optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        content: z.string(),
        content_type: z.string().optional(),
      }),
    )
    .optional(),
});

export const respondEmailSchema = z.object({
  account_name: z.string().optional(),
  email_id: z.string().min(1),
  folder: z.string().optional(),
  body: z.string(),
  body_type: z.enum(["plain", "html"]).optional(),
  reply_all: z.boolean().optional(),
  forward: z.boolean().optional(),
  to: z.array(z.string()).optional(),
  subject: z.string().optional(),
});

export const eventsSchema = z.object({
  account_name: z.string().optional(),
  folder: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  advance: z.boolean().optional(),
});

export const foldersListSchema = z.object({
  account_name: z.string().optional(),
});

export const accountsListSchema = z.object({});

export const TOOL_NAMES = [
  "accounts_list",
  "folders_list",
  "emails_find",
  "emails_modify",
  "emails_events",
  "email_send",
  "email_respond",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const PUSH_TOOLS = new Set<ToolName>(["email_send", "email_respond"]);

export function toolsForMode(mode: "pull" | "pull_push"): ToolName[] {
  if (mode === "pull_push") return [...TOOL_NAMES];
  return TOOL_NAMES.filter((t) => !PUSH_TOOLS.has(t));
}
