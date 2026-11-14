import { describe, expect, it, vi } from "vitest";
import {
  authorizeBearer,
  dispatchTool,
  memoryCache,
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
    createFolder: vi.fn(async (_a: EmailAccount, path: string) => ({ path, created: true })),
    renameFolder: vi.fn(async (_a: EmailAccount, path: string, newPath: string) => ({ path, newPath })),
    deleteFolder: vi.fn(async (_a: EmailAccount, path: string) => ({ path })),
    ...overrides,
  };
  return backend satisfies MailBackend;
}

function makeCtx(
  backend: MailBackend,
  over: Partial<RuntimeConfig> = {},
  acct: EmailAccount = account,
  withCache = false,
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
  return { config, backend, cache: withCache ? memoryCache() : undefined, cursors: memoryCursorStore() };
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

  it("note-to-self threads reply to me; explicit to[] may include me", async () => {
    const b = fakeBackend({
      getEmail: vi.fn(async () => ({ ...original, from: "me@example.com", to: ["Me <me@example.com>"], cc: [] })),
    });
    await dispatchTool("email_respond", { email_id: "INBOX:3", body: "ping" }, makeCtx(b));
    expect(sentMsg(b).to).toEqual(["Me <me@example.com>"]);
    await dispatchTool("email_respond", { email_id: "INBOX:7", body: "ping", to: ["me@example.com"] }, makeCtx(b));
    expect((b.sendMessage.mock.calls[1]![1] as OutgoingMessage).to).toEqual(["me@example.com"]);
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

describe("folder management", () => {
  it("folder_create creates a folder", async () => {
    const b = fakeBackend();
    const r = (await dispatchTool("folder_create", { path: "INBOX/Receipts" }, makeCtx(b))) as {
      created: boolean;
      folder: string;
    };
    expect(b.createFolder).toHaveBeenCalledWith(account, "INBOX/Receipts");
    expect(r).toMatchObject({ created: true, folder: "INBOX/Receipts" });
  });

  it("folder_create is available in pull mode", async () => {
    const b = fakeBackend();
    await expect(
      dispatchTool("folder_create", { path: "Receipts" }, makeCtx(b, { mode: "pull" })),
    ).resolves.toMatchObject({ created: true });
  });

  it("folder_create refuses INBOX and existing special folders", async () => {
    const b = fakeBackend();
    await expect(dispatchTool("folder_create", { path: "inbox" }, makeCtx(b))).rejects.toThrow(/INBOX already exists/);
    await expect(dispatchTool("folder_create", { path: "Sent" }, makeCtx(b))).rejects.toThrow(
      /already exists as the \\Sent special folder/,
    );
    expect(b.createFolder).not.toHaveBeenCalled();
  });

  it("folder_create reports created:false for duplicates", async () => {
    const b = fakeBackend({ createFolder: vi.fn(async () => ({ path: "Receipts", created: false })) });
    await expect(dispatchTool("folder_create", { path: "Receipts" }, makeCtx(b))).resolves.toMatchObject({
      created: false,
    });
  });

  it("folder_create refuses separator aliasing", async () => {
    const b = fakeBackend();
    await expect(dispatchTool("folder_create", { path: "Sent/" }, makeCtx(b))).rejects.toThrow(/must not end with/);
    await expect(dispatchTool("folder_create", { path: "A//B" }, makeCtx(b))).rejects.toThrow(/doubled/);
    expect(b.createFolder).not.toHaveBeenCalled();
  });

  it("folder_create refuses surrounding whitespace (exact mailbox names)", async () => {
    const b = fakeBackend();
    await expect(dispatchTool("folder_create", { path: " Receipts " }, makeCtx(b))).rejects.toThrow(/whitespace/);
    expect(b.createFolder).not.toHaveBeenCalled();
  });

  it("folder_create resets a stale event cursor when the folder is created", async () => {
    const b = fakeBackend();
    const ctx = makeCtx(b);
    const deleted: string[] = [];
    ctx.cursors = {
      get: async () => null,
      set: async () => {},
      delete: async (key: string) => {
        deleted.push(key);
      },
    };
    await dispatchTool("folder_create", { path: "Receipts" }, ctx);
    expect(deleted).toEqual(["events:uid:default:Receipts"]);

    const dup = fakeBackend({ createFolder: vi.fn(async () => ({ path: "Receipts", created: false })) });
    const ctx2 = makeCtx(dup);
    const deleted2: string[] = [];
    ctx2.cursors = {
      get: async () => null,
      set: async () => {},
      delete: async (key: string) => {
        deleted2.push(key);
      },
    };
    await dispatchTool("folder_create", { path: "Receipts" }, ctx2);
    expect(deleted2).toEqual([]);
  });

  it("folder_create resets both spellings on prefixed servers", async () => {
    const b = fakeBackend();
    const ctx = makeCtx(b);
    const deleted: string[] = [];
    ctx.cursors = {
      get: async () => null,
      set: async () => {},
      delete: async (key: string) => {
        deleted.push(key);
      },
    };
    // Prefixed server: backend returns the canonical stored path.
    vi.mocked(b.createFolder).mockResolvedValueOnce({ path: "INBOX.Receipts", created: true });
    await dispatchTool("folder_create", { path: "Receipts" }, ctx);
    expect(deleted).toEqual([
      "events:uid:default:INBOX.Receipts",
      "events:uid:default:Receipts",
    ]);
  });

  it("folder_rename never touches dot-suffixed lookalikes on known-delimiter servers", async () => {
    // Slash-delimiter server (GreenMail, Cyrus, most hosted IMAP): a folder
    // named "Archive/Work.2024" is unrelated to "Work" and must keep its cursor.
    const b = fakeBackend({
      renameFolder: vi.fn(async () => ({ path: "Work", newPath: "Archive/Work" })),
      listFolders: vi.fn(async () => [
        { name: "INBOX", path: "INBOX", delimiter: "/" },
        { name: "Work", path: "Work", delimiter: "/" },
        { name: "Work.2024", path: "Archive/Work.2024", delimiter: "/" },
      ]),
    });
    const ctx = makeCtx(b);
    const sets = new Map<string, string>();
    const deleted: string[] = [];
    const cursors = new Map([
      ["events:uid:default:Work", "50"],
      ["events:uid:default:Work.2024", "7"],
      ["events:uid:default:Archive/Work.2024", "9"],
    ]);
    ctx.cursors = {
      get: async (key: string) => cursors.get(key) ?? null,
      set: async (key: string, value: string) => {
        sets.set(key, value);
        cursors.set(key, value);
      },
      delete: async (key: string) => {
        deleted.push(key);
        cursors.delete(key);
      },
    };
    await dispatchTool("folder_rename", { path: "Work", new_path: "Archive/Work" }, ctx);
    expect(sets.get("events:uid:default:Archive/Work")).toBe("50");
    expect(deleted).toEqual(["events:uid:default:Work"]);
    expect(sets.has("events:uid:default:Archive/Work.2024")).toBe(false);
    expect(deleted).not.toContain("events:uid:default:Archive/Work.2024");
    expect(deleted).not.toContain("events:uid:default:Work.2024");
    expect(cursors.get("events:uid:default:Archive/Work.2024")).toBe("9");

    // Unknown delimiter (server reports none): both separators are candidates,
    // so the dot-suffixed name IS treated as a source descendant — fail-closed.
    const b2 = fakeBackend({
      renameFolder: vi.fn(async () => ({ path: "Work", newPath: "Archive/Work" })),
      listFolders: vi.fn(async () => [
        { name: "INBOX", path: "INBOX" },
        { name: "Work", path: "Work" },
        { name: "Work.2024", path: "Work.2024" },
      ]),
    });
    const ctx2 = makeCtx(b2);
    const sets2 = new Map<string, string>();
    ctx2.cursors = {
      get: async (key: string) => (key === "events:uid:default:Work.2024" ? "7" : null),
      set: async (key: string, value: string) => {
        sets2.set(key, value);
      },
      delete: async () => {},
    };
    await dispatchTool("folder_rename", { path: "Work", new_path: "Archive/Work" }, ctx2);
    expect(sets2.get("events:uid:default:Archive/Work.2024")).toBe("7");
  });

  it("folder_rename derives cursor keys from backend-canonical paths (namespace prefixes)", async () => {
    // Courier-style "INBOX." prefix: the caller's invented destination gets
    // namespace-normalized by the server/backend, so cursor keys must come
    // from the canonical paths the backend returns, not the raw input.
    const b = fakeBackend({
      renameFolder: vi.fn(async () => ({
        path: "INBOX.Work",
        newPath: "INBOX.Archive/Work",
      })),
      listFolders: vi.fn(async () => [
        { name: "INBOX", path: "INBOX", delimiter: "/" },
        { name: "Work", path: "INBOX.Work", delimiter: "/" },
        { name: "Foo", path: "INBOX.Work/Foo", delimiter: "/" },
      ]),
    });
    const ctx = makeCtx(b);
    const sets = new Map<string, string>();
    const deleted: string[] = [];
    const cursors = new Map([
      ["events:uid:default:INBOX.Work", "50"],
      ["events:uid:default:INBOX.Work/Foo", "12"],
    ]);
    ctx.cursors = {
      get: async (key: string) => cursors.get(key) ?? null,
      set: async (key: string, value: string) => {
        sets.set(key, value);
        cursors.set(key, value);
      },
      delete: async (key: string) => {
        deleted.push(key);
        cursors.delete(key);
      },
    };
    await dispatchTool("folder_rename", { path: "INBOX.Work", new_path: "Archive/Work" }, ctx);
    expect(sets.get("events:uid:default:INBOX.Archive/Work")).toBe("50");
    expect(sets.get("events:uid:default:INBOX.Archive/Work/Foo")).toBe("12");
    expect(deleted).toEqual(
      expect.arrayContaining(["events:uid:default:INBOX.Work", "events:uid:default:INBOX.Work/Foo"]),
    );
    expect(cursors.get("events:uid:default:INBOX.Archive/Work/Foo")).toBe("12");
  });

  it("guards refuse unprefixed tails of prefixed special folders", async () => {
    // Courier-style INBOX. prefix: deleting or renaming the unprefixed tail
    // ("Sent") lands on the canonical protected folder after the server
    // normalizes the name — the guard must refuse it.
    const b = fakeBackend({
      listFolders: vi.fn(async () => [
        { name: "INBOX", path: "INBOX", delimiter: "." },
        { name: "Sent", path: "INBOX.Sent", specialUse: "\\Sent", delimiter: "." },
        { name: "Clients", path: "INBOX.Clients", delimiter: "." },
        { name: "Sent", path: "INBOX.Clients/Sent", specialUse: "\\Sent", delimiter: "/" },
      ]),
    });
    await expect(
      dispatchTool("folder_delete", { path: "Sent", confirm: true }, makeCtx(b)),
    ).rejects.toThrow(/\\Sent folder/);
    await expect(
      dispatchTool("folder_rename", { path: "Sent", new_path: "X" }, makeCtx(b)),
    ).rejects.toThrow(/\\Sent folder/);
    // The unprefixed parent whose canonical form contains a special child:
    await expect(
      dispatchTool("folder_rename", { path: "Clients", new_path: "Customers" }, makeCtx(b)),
    ).rejects.toThrow(/special folder "INBOX\.Clients\/Sent"/);
    expect(b.renameFolder).not.toHaveBeenCalled();
    expect(b.deleteFolder).not.toHaveBeenCalled();
  });

  it("guards protect configured overrides on prefixed servers", async () => {
    // Courier-style INBOX. prefix: sent_folder "CustomSent" is stored as
    // "INBOX.CustomSent" (delivery/listing paths) — the canonical listed
    // path must be protected even though the configured value is unprefixed
    // and the listing carries no special-use attribute.
    const b = fakeBackend({
      listFolders: vi.fn(async () => [
        { name: "INBOX", path: "INBOX", delimiter: "." },
        { name: "CustomSent", path: "INBOX.CustomSent", delimiter: "." },
      ]),
    });
    const acct = { ...account, sentFolder: "CustomSent" };
    await expect(
      dispatchTool("folder_delete", { path: "INBOX.CustomSent", confirm: true }, makeCtx(b, {}, acct)),
    ).rejects.toThrow(/\\Sent folder/);
    await expect(
      dispatchTool("folder_rename", { path: "INBOX.CustomSent", new_path: "X" }, makeCtx(b, {}, acct)),
    ).rejects.toThrow(/\\Sent folder/);
    // The unprefixed raw value resolves onto the same protected folder.
    await expect(
      dispatchTool("folder_delete", { path: "CustomSent", confirm: true }, makeCtx(b, {}, acct)),
    ).rejects.toThrow(/\\Sent folder/);
    expect(b.deleteFolder).not.toHaveBeenCalled();
    expect(b.renameFolder).not.toHaveBeenCalled();
  });

  it("folder_rename never corrupts case-variant lookalike cursors", async () => {
    // Renaming Old -> New where an unrelated lowercase "new/Notes" exists
    // (case-sensitive server): the case-variant folder keeps its live cursor
    // and the true child "Old/2024" migrates. A case-insensitive descendant
    // match would delete or overwrite the "new/Notes" cursor here.
    const b2 = fakeBackend({
      renameFolder: vi.fn(async () => ({ path: "Old", newPath: "New" })),
      listFolders: vi.fn(async () => [
        { name: "INBOX", path: "INBOX", delimiter: "/" },
        { name: "Old", path: "Old", delimiter: "/" },
        { name: "Notes", path: "new/Notes", delimiter: "/" },
        { name: "2024", path: "Old/2024", delimiter: "/" },
      ]),
    });
    const ctx2 = makeCtx(b2);
    const sets2 = new Map<string, string>();
    const deleted2: string[] = [];
    const cursors2 = new Map([
      ["events:uid:default:Old/2024", "12"],
      ["events:uid:default:new/Notes", "7"],
    ]);
    ctx2.cursors = {
      get: async (key: string) => cursors2.get(key) ?? null,
      set: async (key: string, value: string) => {
        sets2.set(key, value);
        cursors2.set(key, value);
      },
      delete: async (key: string) => {
        deleted2.push(key);
        cursors2.delete(key);
      },
    };
    await dispatchTool("folder_rename", { path: "Old", new_path: "New" }, ctx2);
    // Positive control + exactness: the only cursor write is the true child's
    // migration; deletions cover the old child key and destination hygiene
    // (the renamed folder itself), never the lookalike.
    expect([...sets2.keys()]).toEqual(["events:uid:default:New/2024"]);
    expect(deleted2).toEqual(
      expect.arrayContaining(["events:uid:default:Old/2024", "events:uid:default:New"]),
    );
    expect(deleted2).not.toContain("events:uid:default:new/Notes");
    expect(cursors2.get("events:uid:default:new/Notes")).toBe("7");
  });

  it("folder_delete drops the event cursor of the deleted path", async () => {
    const b = fakeBackend();
    const ctx = makeCtx(b);
    const deleted: string[] = [];
    ctx.cursors = {
      get: async () => null,
      set: async () => {},
      delete: async (key: string) => {
        deleted.push(key);
      },
    };
    await dispatchTool("folder_delete", { path: "Receipts", confirm: true }, ctx);
    expect(deleted).toEqual(["events:uid:default:Receipts"]);
  });

  it("folder_delete drops both spellings of the deleted folder's cursor", async () => {
    const b = fakeBackend();
    const ctx = makeCtx(b);
    const deleted: string[] = [];
    ctx.cursors = {
      get: async () => null,
      set: async () => {},
      delete: async (key: string) => {
        deleted.push(key);
      },
    };
    // Prefixed backend reports the canonical stored path; raw arg differs.
    vi.mocked(b.deleteFolder).mockResolvedValueOnce({ path: "INBOX.Old" });
    await dispatchTool("folder_delete", { path: "Old", confirm: true }, ctx);
    expect(deleted).toEqual(
      expect.arrayContaining(["events:uid:default:INBOX.Old", "events:uid:default:Old"]),
    );
  });

  it("folder_rename migrates the event cursor to the new path", async () => {
    const b = fakeBackend({
      renameFolder: vi.fn(async () => ({ path: "Receipts", newPath: "Finance/Receipts" })),
      listFolders: vi.fn(async () => [
        { name: "INBOX", path: "INBOX", delimiter: "/" },
        { name: "Receipts", path: "Receipts", delimiter: "/" },
      ]),
    });
    const ctx = makeCtx(b);
    const sets = new Map<string, string>();
    const deleted: string[] = [];
    ctx.cursors = {
      get: async (key: string) => (key === "events:uid:default:Receipts" ? "100" : null),
      set: async (key: string, value: string) => {
        sets.set(key, value);
      },
      delete: async (key: string) => {
        deleted.push(key);
      },
    };
    await dispatchTool("folder_rename", { path: "Receipts", new_path: "Finance/Receipts" }, ctx);
    expect(sets.get("events:uid:default:Finance/Receipts")).toBe("100");
    expect(deleted).toEqual(["events:uid:default:Receipts"]);
  });

  it("folder_rename migrates cursors across a namespace alias", async () => {
    // Courier-style INBOX. prefix: the caller passes the unprefixed alias
    // (Work); the listing and backend speak canonical paths (INBOX.Work).
    const b = fakeBackend({
      renameFolder: vi.fn(async () => ({ path: "INBOX.Work", newPath: "INBOX.Archive/Work" })),
      listFolders: vi.fn(async () => [
        { name: "Work", path: "INBOX.Work", delimiter: "." },
        { name: "Foo", path: "INBOX.Work/Foo", delimiter: "." },
      ]),
    });
    const ctx = makeCtx(b);
    const sets = new Map<string, string>();
    const deleted: string[] = [];
    ctx.cursors = {
      get: async (key: string) => (key === "events:uid:default:INBOX.Work" ? "100" : null),
      set: async (key: string, value: string) => {
        sets.set(key, value);
      },
      delete: async (key: string) => {
        deleted.push(key);
      },
    };
    await dispatchTool("folder_rename", { path: "Work", new_path: "Archive/Work" }, ctx);
    // Both destination spellings seeded (canonical INBOX.Archive/Work and
    // raw Archive/Work) so alias-polling callers keep their watermark.
    expect(sets.get("events:uid:default:INBOX.Archive/Work")).toBe("100");
    expect(sets.get("events:uid:default:Archive/Work")).toBe("100");
    // Both source spellings cleaned: canonical INBOX.Work, and the raw
    // unprefixed argument Work (inert here — no cursor was seeded for it).
    expect(deleted).toEqual([
      "events:uid:default:INBOX.Work",
      "events:uid:default:Work",
    ]);

    // No source cursor: both destination spellings hygiene-deleted anyway.
    const b2 = fakeBackend({
      renameFolder: vi.fn(async () => ({ path: "INBOX.Work", newPath: "INBOX.Archive/Work2" })),
      listFolders: vi.fn(async () => [
        { name: "Work", path: "INBOX.Work", delimiter: "." },
      ]),
    });
    const ctx2 = makeCtx(b2);
    const deleted2: string[] = [];
    ctx2.cursors = {
      get: async () => null,
      set: async () => {},
      delete: async (key: string) => {
        deleted2.push(key);
      },
    };
    await dispatchTool("folder_rename", { path: "Work", new_path: "Archive/Work2" }, ctx2);
    // No source cursor: both destination spellings hygiene-deleted anyway.
    expect(deleted2).toEqual([
      "events:uid:default:INBOX.Archive/Work2",
      "events:uid:default:Archive/Work2",
    ]);
  });

  it("folder_rename migrates descendant cursors and drops stale destination cursors", async () => {
    // Pre-rename listing: the source tree; the destination path carries a
    // residual cursor from outside the tool's lifecycle.
    const b = fakeBackend({
      renameFolder: vi.fn(async () => ({ path: "Work", newPath: "Archive/Work" })),
      listFolders: vi.fn(async () => [
        { name: "INBOX", path: "INBOX", delimiter: "/" },
        { name: "Work", path: "Work", delimiter: "/" },
        { name: "Foo", path: "Work/Foo", delimiter: "/" },
        { name: "Workbench", path: "Workbench", delimiter: "/" },
      ]),
    });
    const ctx = makeCtx(b);
    const sets = new Map<string, string>();
    const deleted: string[] = [];
    const cursors = new Map([
      ["events:uid:default:Work", "50"],
      ["events:uid:default:Work/Foo", "12"],
      // Stale residue at the destination from outside the tool's lifecycle:
      ["events:uid:default:Archive/Work/Foo", "999"],
    ]);
    ctx.cursors = {
      get: async (key: string) => cursors.get(key) ?? null,
      set: async (key: string, value: string) => {
        sets.set(key, value);
        cursors.set(key, value);
      },
      delete: async (key: string) => {
        deleted.push(key);
        cursors.delete(key);
      },
    };
    await dispatchTool("folder_rename", { path: "Work", new_path: "Archive/Work" }, ctx);
    // Parent + descendant migrated; the lookalike "Workbench" is untouched.
    expect(sets.get("events:uid:default:Archive/Work")).toBe("50");
    expect(sets.get("events:uid:default:Archive/Work/Foo")).toBe("12");
    expect(deleted).toEqual(
      expect.arrayContaining(["events:uid:default:Work", "events:uid:default:Work/Foo"]),
    );
    expect(deleted).not.toContain("events:uid:default:Workbench");
    // Source had a cursor, so the destination key was overwritten, not deleted.
    expect(deleted).not.toContain("events:uid:default:Archive/Work");
    expect(cursors.get("events:uid:default:Archive/Work/Foo")).toBe("12");

    // No cursor at the source: the mapped destination's stale cursor is stale
    // by definition.
    const b2 = fakeBackend({
      renameFolder: vi.fn(async () => ({ path: "Work", newPath: "Archive/Work" })),
      listFolders: vi.fn(async () => [
        { name: "INBOX", path: "INBOX", delimiter: "/" },
        { name: "Work", path: "Work", delimiter: "/" },
      ]),
    });
    const ctx2 = makeCtx(b2);
    const deleted2: string[] = [];
    ctx2.cursors = {
      get: async () => null,
      set: async () => {},
      delete: async (key: string) => {
        deleted2.push(key);
      },
    };
    await dispatchTool("folder_rename", { path: "Work", new_path: "Archive/Work" }, ctx2);
    expect(deleted2).toContain("events:uid:default:Archive/Work");
  });

  it("folder mutations invalidate the folders_list cache", async () => {
    const b = fakeBackend();
    const ctx = makeCtx(b, { cacheTtlSeconds: 120 }, account, true);
    await dispatchTool("folders_list", {}, ctx);
    await dispatchTool("folders_list", {}, ctx);
    expect(b.listFolders).toHaveBeenCalledTimes(1);
    await dispatchTool("folder_create", { path: "Receipts" }, ctx); // uncached guard listing → 2
    await dispatchTool("folders_list", {}, ctx); // generation bumped → fresh fetch → 3
    expect(b.listFolders).toHaveBeenCalledTimes(3);
  });

  it("folder_rename renames a regular folder", async () => {
    const b = fakeBackend();
    const r = (await dispatchTool(
      "folder_rename",
      { path: "Receipts", new_path: "Archive/Receipts" },
      makeCtx(b),
    )) as { renamed: boolean; folder: string; new_folder: string };
    expect(b.renameFolder).toHaveBeenCalledWith(account, "Receipts", "Archive/Receipts");
    expect(r).toMatchObject({ renamed: true, folder: "Receipts", new_folder: "Archive/Receipts" });
  });

  it("folder_rename allows case-only renames but refuses no-op renames", async () => {
    const b = fakeBackend();
    await dispatchTool("folder_rename", { path: "Receipts", new_path: "receipts" }, makeCtx(b));
    expect(b.renameFolder).toHaveBeenCalledWith(account, "Receipts", "receipts");
    await expect(
      dispatchTool("folder_rename", { path: "Receipts", new_path: "Receipts" }, makeCtx(b)),
    ).rejects.toThrow(/must differ/);
    expect(b.renameFolder).toHaveBeenCalledTimes(1);
  });

  it("folder_rename guards the destination too", async () => {
    const b = fakeBackend();
    await expect(
      dispatchTool("folder_rename", { path: "Receipts", new_path: "INBOX" }, makeCtx(b)),
    ).rejects.toThrow(/INBOX cannot be renamed/);
    await expect(
      dispatchTool("folder_rename", { path: "Receipts", new_path: "Trash" }, makeCtx(b)),
    ).rejects.toThrow(/\\Trash folder/);
    expect(b.renameFolder).not.toHaveBeenCalled();
  });

  it("folder_rename refuses INBOX before contacting the server", async () => {
    const b = fakeBackend({ listFolders: vi.fn(async () => { throw new Error("imap down"); }) });
    await expect(
      dispatchTool("folder_rename", { path: "INBOX", new_path: "X" }, makeCtx(b)),
    ).rejects.toThrow(/INBOX cannot be renamed/);
    await expect(
      dispatchTool("folder_delete", { path: "INBOX", confirm: true }, makeCtx(b)),
    ).rejects.toThrow(/INBOX cannot be deleted/);
  });

  it("folder_rename refuses INBOX and special folders", async () => {
    const b = fakeBackend();
    for (const path of ["INBOX", "inbox", "Sent", "Trash"]) {
      await expect(
        dispatchTool("folder_rename", { path, new_path: "X" }, makeCtx(b)),
      ).rejects.toThrow(/cannot|INBOX/);
    }
    expect(b.renameFolder).not.toHaveBeenCalled();
  });

  it("folder_rename refuses a parent of a special folder", async () => {
    const b = fakeBackend({
      listFolders: vi.fn(async () => [
        { name: "INBOX", path: "INBOX", delimiter: "/" },
        { name: "Clients", path: "Clients", delimiter: "/" },
        { name: "Sent", path: "Clients/Sent", specialUse: "\\Sent", delimiter: "/" },
      ]),
    });
    await expect(
      dispatchTool("folder_rename", { path: "Clients", new_path: "Customers" }, makeCtx(b)),
    ).rejects.toThrow(/contains the special folder/);
  });

  it("protects configured sent/drafts folders and name-resolved specials", async () => {
    const b = fakeBackend();
    const acct = { ...account, draftsFolder: "X/Drafts" };
    await expect(
      dispatchTool("folder_delete", { path: "X/Drafts", confirm: true }, makeCtx(b, {}, acct)),
    ).rejects.toThrow(/\\Drafts folder/);
    // "Sent" has no specialUse attribute in FOLDERS; the name-based resolver protects it.
    await expect(
      dispatchTool("folder_delete", { path: "Sent", confirm: true }, makeCtx(b)),
    ).rejects.toThrow(/special folder/);
    expect(b.deleteFolder).not.toHaveBeenCalled();
  });

  it("folder_rename refuses separator tricks", async () => {
    const b = fakeBackend();
    await expect(
      dispatchTool("folder_rename", { path: "Clients/Sent/", new_path: "X" }, makeCtx(b)),
    ).rejects.toThrow(/must not end with/);
    await expect(
      dispatchTool("folder_rename", { path: "Clients//Sent", new_path: "X" }, makeCtx(b)),
    ).rejects.toThrow(/doubled/);
    expect(b.renameFolder).not.toHaveBeenCalled();
  });

  it("folder_create rejects control characters before any IMAP call", async () => {
    const b = fakeBackend();
    await expect(
      dispatchTool("folder_create", { path: "Receipts\r\nB1 DELETE Sent" }, makeCtx(b)),
    ).rejects.toThrow(/control characters/);
    expect(b.listFolders).not.toHaveBeenCalled();
    expect(b.createFolder).not.toHaveBeenCalled();
  });

  it("folder_delete requires confirm", async () => {
    const b = fakeBackend();
    // Schema: confirm is a required boolean.
    await expect(
      dispatchTool("folder_delete", { path: "Receipts" }, makeCtx(b)),
    ).rejects.toThrow(/confirm/);
    // Dispatch: explicit false is refused too.
    await expect(
      dispatchTool("folder_delete", { path: "Receipts", confirm: false }, makeCtx(b)),
    ).rejects.toThrow(/confirm:true/);
    expect(b.deleteFolder).not.toHaveBeenCalled();
    await dispatchTool("folder_delete", { path: "Receipts", confirm: true }, makeCtx(b));
    expect(b.deleteFolder).toHaveBeenCalledWith(account, "Receipts");
  });

  it("folder_delete refuses INBOX and special folders", async () => {
    const b = fakeBackend();
    for (const path of ["INBOX", "inbox", "Sent", "Trash"]) {
      await expect(
        dispatchTool("folder_delete", { path, confirm: true }, makeCtx(b)),
      ).rejects.toThrow(/cannot|INBOX/);
    }
    expect(b.deleteFolder).not.toHaveBeenCalled();
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
