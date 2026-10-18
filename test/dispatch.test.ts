import { describe, expect, it, vi } from "vitest";
import {
  authorizeBearer,
  dispatchTool,
  memoryCursorStore,
  toolsForMode,
  type DispatchContext,
  type EmailAccount,
  type EmailDetail,
  type MailBackend,
  type OutgoingMessage,
  type RuntimeConfig,
} from "@mail-mcp/core";

const account: EmailAccount = {
  name: "default",
  imap: { host: "imap.example.com", port: 993, secure: true, user: "me@example.com", password: "x" },
  smtp: { host: "smtp.example.com", port: 587, secure: false, user: "me@example.com", password: "x" },
  defaultFromName: "Me",
};

const FOLDERS = [
  { name: "INBOX", path: "INBOX" },
  { name: "Sent", path: "Sent", specialUse: "\\Sent" },
  { name: "Drafts", path: "Drafts", specialUse: "\\Drafts" },
  { name: "Trash", path: "Trash", specialUse: "\\Trash" },
];

const original: EmailDetail = {
  id: "INBOX:7",
  uid: 7,
  account: "default",
  folder: "INBOX",
  subject: "Quarterly plan",
  from: '"Alice" <alice@corp.com>',
  to: ["me@example.com", "bob@corp.com"],
  cc: ["carol@corp.com", "Me <ME@example.com>"],
  date: "2026-10-01T10:00:00.000Z",
  messageId: "<orig@corp.com>",
  references: ["<root@corp.com>"],
  bodyText: "Line one\nLine two",
  attachments: [{ index: 0, filename: "plan.pdf", contentType: "application/pdf", size: 3, contentBase64: "YWJj" }],
};

function fakeBackend(overrides: Partial<MailBackend> = {}) {
  const backend = {
    listFolders: vi.fn(async () => FOLDERS),
    findEmails: vi.fn(async () => ({ emails: [], total: 0, nextCursor: null })),
    getEmail: vi.fn(async () => original),
    modifyEmails: vi.fn(async (_a: EmailAccount, input: { emailIds: string[] }) => ({
      updated: input.emailIds.length,
    })),
    sendMessage: vi.fn(async () => {}),
    appendMessage: vi.fn(async () => ({ uid: 99 })),
    listNewSince: vi.fn(async () => ({ messages: [], hasMore: false })),
    getHighestUid: vi.fn(async () => 42),
    ...overrides,
  };
  return backend satisfies MailBackend;
}

function makeCtx(
  backend: MailBackend,
  over: Partial<RuntimeConfig> = {},
  acct: EmailAccount = account,
): DispatchContext {
  const config: RuntimeConfig = {
    accounts: { default: acct },
    defaultAccount: "default",
    mode: "pull_push",
    cacheTtlSeconds: 0,
    eventsPollSeconds: 0,
    mcpBearerToken: "tok",
    saveSent: "auto",
    sendAllowlist: [],
    maxBodyChars: 20_000,
    attachmentMaxBytes: 2_000_000,
    ...over,
  };
  return { config, backend, cursors: memoryCursorStore() };
}

const sentMsg = (b: ReturnType<typeof fakeBackend>) =>
  b.sendMessage.mock.calls[0]![1] as OutgoingMessage;

describe("toolsForMode", () => {
  it("gates draft and send tools by mode", () => {
    expect(toolsForMode("pull")).not.toContain("email_draft");
    expect(toolsForMode("pull")).not.toContain("email_send");
    expect(toolsForMode("draft")).toContain("email_draft");
    expect(toolsForMode("draft")).not.toContain("email_send");
    expect(toolsForMode("pull_push")).toEqual(expect.arrayContaining(["email_draft", "email_send", "email_respond"]));
  });
});

describe("accounts_list", () => {
  it("reports capabilities", async () => {
    const result = (await dispatchTool("accounts_list", {}, makeCtx(fakeBackend(), { mode: "draft" }))) as {
      accounts: Array<{ can_send: boolean; can_draft: boolean; saves_sent_copy: boolean }>;
    };
    expect(result.accounts[0]).toMatchObject({ can_send: false, can_draft: true, saves_sent_copy: true });
  });
});

describe("email_send", () => {
  it("is disabled outside pull_push", async () => {
    for (const mode of ["pull", "draft"] as const) {
      await expect(
        dispatchTool("email_send", { to: ["b@x.com"], subject: "Hi", body: "x" }, makeCtx(fakeBackend(), { mode })),
      ).rejects.toThrow(/disabled/);
    }
  });

  it("sends with a Message-ID and stores a Sent copy", async () => {
    const b = fakeBackend();
    const result = (await dispatchTool(
      "email_send",
      { to: ["b@x.com", "B@x.com"], bcc: ["hidden@x.com"], subject: "Hi", body: "<p>Hello</p>", body_type: "html" },
      makeCtx(b),
    )) as { saved_to_sent: string; message_id: string; warnings: string[] };
    const msg = sentMsg(b);
    expect(msg.to).toEqual(["b@x.com"]);
    expect(msg.bcc).toEqual(["hidden@x.com"]);
    expect(msg.html).toBe("<p>Hello</p>");
    expect(msg.text).toBe("Hello");
    expect(msg.messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/);
    expect(msg.from).toEqual({ name: "Me", address: "me@example.com" });
    expect(b.appendMessage).toHaveBeenCalledWith(account, "Sent", msg, ["\\Seen"]);
    expect(result).toMatchObject({ saved_to_sent: "Sent", message_id: msg.messageId, warnings: [] });
  });

  it("skips the Sent copy for Gmail (auto)", async () => {
    const b = fakeBackend();
    const gmail = { ...account, smtp: { ...account.smtp!, host: "smtp.gmail.com" } };
    await dispatchTool("email_send", { to: ["b@x.com"], subject: "s", body: "x" }, makeCtx(b, {}, gmail));
    expect(b.appendMessage).not.toHaveBeenCalled();
  });

  it("reports, not fails, when the Sent copy fails", async () => {
    const b = fakeBackend({ appendMessage: vi.fn(async () => { throw new Error("quota"); }) });
    const result = (await dispatchTool("email_send", { to: ["b@x.com"], subject: "s", body: "x" }, makeCtx(b))) as {
      sent: boolean;
      warnings: string[];
    };
    expect(result.sent).toBe(true);
    expect(result.warnings[0]).toMatch(/quota/);
  });

  it("blocks recipients outside SEND_ALLOWLIST before sending", async () => {
    const b = fakeBackend();
    const ctx = makeCtx(b, { sendAllowlist: ["corp.com", "friend@gmail.com"] });
    await expect(
      dispatchTool("email_send", { to: ["x@sub.corp.com"], cc: ["evil@attacker.io"], subject: "s", body: "x" }, ctx),
    ).rejects.toThrow(/evil@attacker\.io/);
    expect(b.sendMessage).not.toHaveBeenCalled();
    await dispatchTool("email_send", { to: ["x@sub.corp.com", "Friend <friend@gmail.com>"], subject: "s", body: "x" }, ctx);
    expect(b.sendMessage).toHaveBeenCalledOnce();
  });
});

describe("email_respond", () => {
  it("threads the reply and quotes the original", async () => {
    const b = fakeBackend();
    const result = (await dispatchTool("email_respond", { email_id: "INBOX:7", body: "Sounds good" }, makeCtx(b))) as {
      kind: string;
      in_reply_to: string;
    };
    const msg = sentMsg(b);
    expect(msg.to).toEqual(['"Alice" <alice@corp.com>']);
    expect(msg.cc).toEqual([]);
    expect(msg.subject).toBe("Re: Quarterly plan");
    expect(msg.inReplyTo).toBe("<orig@corp.com>");
    expect(msg.references).toEqual(["<root@corp.com>", "<orig@corp.com>"]);
    expect(msg.text).toContain("Sounds good\n\nOn ");
    expect(msg.text).toContain("> Line two");
    expect(result).toMatchObject({ kind: "reply", in_reply_to: "<orig@corp.com>" });
    expect(b.modifyEmails).toHaveBeenCalledWith(account, { emailIds: ["INBOX:7"], addFlags: ["\\Answered"] });
  });

  it("reply_all keeps others and drops my own addresses", async () => {
    const b = fakeBackend();
    await dispatchTool("email_respond", { email_id: "INBOX:7", body: "ok", reply_all: true }, makeCtx(b));
    const msg = sentMsg(b);
    expect(msg.to).toEqual(['"Alice" <alice@corp.com>']);
    expect(msg.cc).toEqual(["bob@corp.com", "carol@corp.com"]);
  });

  it("does not double the Re: prefix and honors Reply-To", async () => {
    const b = fakeBackend({
      getEmail: vi.fn(async () => ({ ...original, subject: "RE: Quarterly plan", replyTo: ["list@corp.com"] })),
    });
    await dispatchTool("email_respond", { email_id: "INBOX:7", body: "ok", quote: false }, makeCtx(b));
    const msg = sentMsg(b);
    expect(msg.subject).toBe("RE: Quarterly plan");
    expect(msg.to).toEqual(["list@corp.com"]);
    expect(msg.text).toBe("ok");
  });

  it("forward carries attachments, needs to[], and does not mark answered", async () => {
    const b = fakeBackend();
    await expect(
      dispatchTool("email_respond", { email_id: "INBOX:7", body: "fyi", forward: true }, makeCtx(b)),
    ).rejects.toThrow(/to\[\]/);
    await dispatchTool("email_respond", { email_id: "INBOX:7", body: "fyi", forward: true, to: ["dan@x.com"] }, makeCtx(b));
    const msg = sentMsg(b);
    expect(msg.subject).toBe("Fwd: Quarterly plan");
    expect(msg.attachments).toEqual([{ filename: "plan.pdf", contentBase64: "YWJj", contentType: "application/pdf" }]);
    expect(msg.inReplyTo).toBeUndefined();
    expect(msg.text).toContain("---------- Forwarded message ---------");
    expect(b.getEmail).toHaveBeenLastCalledWith(account, expect.objectContaining({ includeAttachmentContent: true }));
    expect(b.modifyEmails).not.toHaveBeenCalled();
  });

  it("replying to my own sent mail goes to its recipients", async () => {
    const b = fakeBackend({
      getEmail: vi.fn(async () => ({ ...original, from: "Me <me@example.com>", to: ["zoe@x.com"], cc: [] })),
    });
    await dispatchTool("email_respond", { email_id: "Sent:3", body: "ping" }, makeCtx(b));
    expect(sentMsg(b).to).toEqual(["zoe@x.com"]);
  });
});

describe("email_draft", () => {
  it("saves to Drafts in draft mode without sending", async () => {
    const b = fakeBackend();
    const result = (await dispatchTool(
      "email_draft",
      { to: ["b@x.com"], subject: "Idea", body: "draft body" },
      makeCtx(b, { mode: "draft" }),
    )) as { folder: string; email_id: string };
    expect(b.sendMessage).not.toHaveBeenCalled();
    expect(b.appendMessage).toHaveBeenCalledWith(account, "Drafts", expect.any(Object), ["\\Draft", "\\Seen"]);
    expect(result).toMatchObject({ folder: "Drafts", email_id: "Drafts:99" });
  });

  it("drafts a threaded reply and ignores the allowlist (nothing is sent)", async () => {
    const b = fakeBackend();
    await dispatchTool(
      "email_draft",
      { email_id: "INBOX:7", body: "draft reply" },
      makeCtx(b, { mode: "draft", sendAllowlist: ["nowhere.test"] }),
    );
    const msg = b.appendMessage.mock.calls[0]![2] as OutgoingMessage;
    expect(msg.inReplyTo).toBe("<orig@corp.com>");
    expect(msg.subject).toBe("Re: Quarterly plan");
  });

  it("uses drafts_folder override", async () => {
    const b = fakeBackend();
    await dispatchTool("email_draft", { body: "x" }, makeCtx(b, {}, { ...account, draftsFolder: "INBOX.Drafts" }));
    expect(b.appendMessage.mock.calls[0]![1]).toBe("INBOX.Drafts");
    expect(b.listFolders).not.toHaveBeenCalled();
  });
});

describe("read tools", () => {
  it("emails_find forwards cursor and returns next_cursor", async () => {
    const b = fakeBackend({ findEmails: vi.fn(async () => ({ emails: [], total: 120, nextCursor: "501" })) });
    const result = (await dispatchTool("emails_find", { limit: 50, cursor: "900" }, makeCtx(b, { mode: "pull" }))) as {
      total: number;
      next_cursor: string;
    };
    expect(b.findEmails).toHaveBeenCalledWith(account, expect.objectContaining({ cursor: "900", limit: 50, folder: "INBOX" }));
    expect(result).toMatchObject({ total: 120, next_cursor: "501" });
  });

  it("email_get truncates text and hides html by default", async () => {
    const b = fakeBackend({
      getEmail: vi.fn(async () => ({ ...original, bodyText: "a".repeat(500), bodyHtml: "<b>x</b>" })),
    });
    const r = (await dispatchTool("email_get", { email_id: "INBOX:7", max_chars: 100 }, makeCtx(b, { mode: "pull" }))) as {
      bodyText: string;
      truncated: boolean;
      bodyHtml?: string;
    };
    expect(r.truncated).toBe(true);
    expect(r.bodyText.startsWith("a".repeat(100))).toBe(true);
    expect(r.bodyHtml).toBeUndefined();
    const withHtml = (await dispatchTool("email_get", { email_id: "INBOX:7", include_html: true }, makeCtx(b))) as {
      bodyHtml?: string;
    };
    expect(withHtml.bodyHtml).toBe("<b>x</b>");
  });

  it("rejects malformed email ids", async () => {
    await expect(dispatchTool("email_get", { email_id: "nope" }, makeCtx(fakeBackend()))).rejects.toThrow(/folder>:<uid/);
  });

  it("emails_modify resolves the trash alias", async () => {
    const b = fakeBackend();
    const r = (await dispatchTool("emails_modify", { email_ids: ["INBOX:7"], move_to_folder: "trash" }, makeCtx(b))) as {
      moved_to: string;
    };
    expect(r.moved_to).toBe("Trash");
    expect(b.modifyEmails).toHaveBeenCalledWith(account, expect.objectContaining({ moveToFolder: "Trash" }));
  });
});

describe("emails_events", () => {
  const newMsg = { id: "INBOX:43", uid: 43, account: "default", folder: "INBOX", subject: "New", from: "x@y.z", to: [] };

  it("seeds, then returns new mail via the server cursor", async () => {
    const b = fakeBackend();
    const ctx = makeCtx(b, { mode: "pull" });
    const first = (await dispatchTool("emails_events", {}, ctx)) as { seeded: boolean; next_after_uid: number };
    expect(first).toMatchObject({ seeded: true, next_after_uid: 42 });

    b.listNewSince.mockResolvedValueOnce({ messages: [newMsg], hasMore: true });
    const second = (await dispatchTool("emails_events", {}, ctx)) as { count: number; next_after_uid: number; has_more: boolean };
    expect(b.listNewSince).toHaveBeenLastCalledWith(account, "INBOX", 42, 20);
    expect(second).toMatchObject({ count: 1, next_after_uid: 43, has_more: true });
  });

  it("is stateless with after_uid", async () => {
    const b = fakeBackend();
    b.listNewSince.mockResolvedValueOnce({ messages: [newMsg], hasMore: false });
    const r = (await dispatchTool("emails_events", { after_uid: 10, limit: 5 }, makeCtx(b, { mode: "pull" }))) as {
      next_after_uid: number;
    };
    expect(b.listNewSince).toHaveBeenCalledWith(account, "INBOX", 10, 5);
    expect(b.getHighestUid).not.toHaveBeenCalled();
    expect(r.next_after_uid).toBe(43);
  });
});

describe("authorizeBearer", () => {
  it("accepts matching bearer", () => {
    expect(authorizeBearer("secret", "Bearer secret")).toBe(true);
    expect(authorizeBearer("secret", "Bearer nope")).toBe(false);
    expect(authorizeBearer("secret", null)).toBe(false);
  });
});
