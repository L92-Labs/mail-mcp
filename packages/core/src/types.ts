/**
 * pull      — read + organize (find/get/modify/events). No SMTP needed.
 * draft     — pull + save drafts to the IMAP Drafts folder. Nothing is ever sent.
 * pull_push — draft + send/reply/forward over SMTP.
 */
export type MailMode = "pull" | "draft" | "pull_push";

/** auto = copy to Sent unless the SMTP provider already does it (Gmail, Microsoft). */
export type SaveSentPolicy = "auto" | "always" | "never";

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
};

export type ImapConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
};

export type EmailAccount = {
  name: string;
  smtp?: SmtpConfig;
  imap: ImapConfig;
  defaultFromName?: string;
  senderEmails?: string[];
  /** Per-account override of SAVE_SENT. */
  saveSent?: SaveSentPolicy;
  /** Explicit folder paths; otherwise resolved via IMAP special-use / common names. */
  sentFolder?: string;
  draftsFolder?: string;
};

export type RuntimeConfig = {
  accounts: Record<string, EmailAccount>;
  defaultAccount: string;
  mode: MailMode;
  cacheTtlSeconds: number;
  eventsPollSeconds: number;
  mcpBearerToken?: string;
  saveSent: SaveSentPolicy;
  /** Empty = any recipient. Entries: "a@b.com", "b.com" / "@b.com" (domain + subdomains). */
  sendAllowlist: string[];
  /** Default cap for email_get body text. */
  maxBodyChars: number;
  /** Attachments larger than this are listed but their content is not returned. */
  attachmentMaxBytes: number;
};

export type FolderInfo = {
  name: string;
  path: string;
  /** Normalized RFC 6154 attribute, e.g. "\\Sent", "\\Drafts", "\\Trash". */
  specialUse?: string;
};

export type EmailAttachment = {
  index: number;
  filename: string;
  contentType?: string;
  size?: number;
  contentId?: string;
  inline?: boolean;
  contentBase64?: string;
};

export type EmailMessage = {
  id: string;
  uid: number;
  account: string;
  folder: string;
  subject: string;
  from: string;
  /** One entry per address, "Name <addr>" or "addr". */
  to: string[];
  cc?: string[];
  date?: string;
  messageId?: string;
  flags?: string[];
  isUnread?: boolean;
  isFlagged?: boolean;
  hasAttachments?: boolean;
  snippet?: string;
  bodyText?: string;
  bodyHtml?: string;
  attachments?: EmailAttachment[];
};

export type EmailDetail = EmailMessage & {
  replyTo?: string[];
  inReplyTo?: string;
  references?: string[];
  bodyText: string;
  attachments: EmailAttachment[];
};

export type FindFilters = {
  from?: string;
  to?: string;
  subject?: string;
  hasAttachments?: boolean;
  isUnread?: boolean;
  isFlagged?: boolean;
  afterDate?: string;
  beforeDate?: string;
};

export type FindEmailsInput = {
  folder?: string;
  query?: string;
  filters?: FindFilters;
  limit?: number;
  /** Opaque page cursor from a previous result (exclusive upper UID bound). */
  cursor?: string;
  includeContent?: boolean;
};

export type FindEmailsResult = {
  emails: EmailMessage[];
  /** Total matches in the folder for this search (all pages). */
  total: number;
  nextCursor: string | null;
};

export type GetEmailInput = {
  emailId: string;
  folder?: string;
  /** Include base64 content for attachments up to attachmentMaxBytes. */
  includeAttachmentContent?: boolean;
  attachmentMaxBytes?: number;
  markRead?: boolean;
};

export type ModifyEmailsInput = {
  folder?: string;
  emailIds: string[];
  markRead?: boolean;
  markUnread?: boolean;
  flag?: boolean;
  unflag?: boolean;
  /** Resolved folder path (aliases like "trash" are resolved by core). */
  moveToFolder?: string;
  /** Raw IMAP flags to add, e.g. ["\\Answered"]. */
  addFlags?: string[];
};

/** Fully composed message, runtime-agnostic. Backends only serialize + transmit. */
export type OutgoingMessage = {
  from: { name?: string; address: string };
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  messageId: string;
  date: Date;
  inReplyTo?: string;
  references?: string[];
  attachments: Array<{ filename: string; contentBase64: string; contentType?: string }>;
};

/** Transport-agnostic mail operations. Composition/policy lives in core. */
export interface MailBackend {
  listFolders(account: EmailAccount): Promise<FolderInfo[]>;
  findEmails(account: EmailAccount, input: FindEmailsInput): Promise<FindEmailsResult>;
  getEmail(account: EmailAccount, input: GetEmailInput): Promise<EmailDetail>;
  modifyEmails(account: EmailAccount, input: ModifyEmailsInput): Promise<{ updated: number }>;
  /** Transmit over SMTP. Bcc must not appear in the delivered headers. */
  sendMessage(account: EmailAccount, message: OutgoingMessage): Promise<void>;
  /** IMAP APPEND (Sent copy, Drafts). Flags use IMAP form, e.g. "\\Seen". */
  appendMessage(
    account: EmailAccount,
    folder: string,
    message: OutgoingMessage,
    flags: string[],
  ): Promise<{ uid?: number }>;
  /** Messages with UID > afterUid, oldest first, at most `limit`. */
  listNewSince(
    account: EmailAccount,
    folder: string,
    afterUid: number,
    limit: number,
  ): Promise<{ messages: EmailMessage[]; hasMore: boolean }>;
  getHighestUid(account: EmailAccount, folder: string): Promise<number>;
}

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete?(key: string): Promise<void>;
}

export interface CursorStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}
