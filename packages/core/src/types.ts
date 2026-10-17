export type MailMode = "pull" | "pull_push";

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
};

export type RuntimeConfig = {
  accounts: Record<string, EmailAccount>;
  defaultAccount: string;
  mode: MailMode;
  cacheTtlSeconds: number;
  eventsPollSeconds: number;
  mcpBearerToken?: string;
};

export type FolderInfo = {
  name: string;
  path: string;
  specialUse?: string;
};

export type EmailAttachment = {
  filename: string;
  contentType?: string;
  size?: number;
  contentBase64?: string;
};

export type EmailMessage = {
  id: string;
  uid: number;
  account: string;
  folder: string;
  subject: string;
  from: string;
  to: string[];
  cc?: string[];
  date?: string;
  flags?: string[];
  isUnread?: boolean;
  isFlagged?: boolean;
  snippet?: string;
  bodyText?: string;
  bodyHtml?: string;
  attachments?: EmailAttachment[];
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
  accountName?: string;
  folder?: string;
  query?: string;
  filters?: FindFilters;
  limit?: number;
  includeContent?: boolean;
  includeAttachments?: boolean;
};

export type ModifyEmailsInput = {
  accountName?: string;
  folder?: string;
  emailIds: string[];
  markRead?: boolean;
  markUnread?: boolean;
  flag?: boolean;
  unflag?: boolean;
  moveToFolder?: string;
};

export type SendEmailInput = {
  accountName?: string;
  to: string[];
  subject: string;
  body: string;
  bodyType?: "plain" | "html";
  fromEmail?: string;
  cc?: string[];
  bcc?: string[];
  attachments?: Array<{
    filename: string;
    content: string;
    contentType?: string;
  }>;
};

export type RespondEmailInput = {
  accountName?: string;
  emailId: string;
  folder?: string;
  body: string;
  bodyType?: "plain" | "html";
  replyAll?: boolean;
  forward?: boolean;
  to?: string[];
  subject?: string;
};

export type EventsInput = {
  accountName?: string;
  folder?: string;
  limit?: number;
  advance?: boolean;
};

/** Transport-agnostic mail operations. */
export interface MailBackend {
  listFolders(account: EmailAccount, folderHint?: string): Promise<FolderInfo[]>;
  findEmails(account: EmailAccount, input: FindEmailsInput): Promise<EmailMessage[]>;
  modifyEmails(account: EmailAccount, input: ModifyEmailsInput): Promise<{ updated: number }>;
  sendEmail(account: EmailAccount, input: SendEmailInput): Promise<{ messageId: string }>;
  respondEmail(account: EmailAccount, input: RespondEmailInput): Promise<{ messageId: string }>;
  /** Messages with UID greater than `afterUid` (exclusive), newest last. */
  listNewSince(
    account: EmailAccount,
    folder: string,
    afterUid: number,
    limit: number,
  ): Promise<EmailMessage[]>;
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
