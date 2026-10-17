import { describe, expect, it, vi } from "vitest";
import {
  authorizeBearer,
  dispatchTool,
  toolsForMode,
  type DispatchContext,
  type EmailAccount,
  type MailBackend,
  type RuntimeConfig,
  memoryCursorStore,
} from "@mail-mcp/core";

const account: EmailAccount = {
  name: "default",
  imap: {
    host: "imap.example.com",
    port: 993,
    secure: true,
    user: "a@example.com",
    password: "x",
  },
  smtp: {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    user: "a@example.com",
    password: "x",
  },
};

function makeCtx(mode: RuntimeConfig["mode"], backend: MailBackend): DispatchContext {
  const config: RuntimeConfig = {
    accounts: { default: account },
    defaultAccount: "default",
    mode,
    cacheTtlSeconds: 0,
    eventsPollSeconds: 0,
    mcpBearerToken: "tok",
  };
  return { config, backend, cursors: memoryCursorStore() };
}

describe("toolsForMode", () => {
  it("hides send tools in pull mode", () => {
    expect(toolsForMode("pull")).not.toContain("email_send");
    expect(toolsForMode("pull_push")).toContain("email_send");
  });
});

describe("dispatchTool", () => {
  it("lists accounts", async () => {
    const backend = {
      listFolders: vi.fn(),
      findEmails: vi.fn(),
      modifyEmails: vi.fn(),
      sendEmail: vi.fn(),
      respondEmail: vi.fn(),
      listNewSince: vi.fn(),
      getHighestUid: vi.fn(),
    } satisfies MailBackend;
    const result = (await dispatchTool("accounts_list", {}, makeCtx("pull", backend))) as {
      mode: string;
      accounts: Array<{ can_send: boolean }>;
    };
    expect(result.mode).toBe("pull");
    expect(result.accounts[0]?.can_send).toBe(false);
  });

  it("blocks email_send in pull mode", async () => {
    const backend = {
      listFolders: vi.fn(),
      findEmails: vi.fn(),
      modifyEmails: vi.fn(),
      sendEmail: vi.fn(),
      respondEmail: vi.fn(),
      listNewSince: vi.fn(),
      getHighestUid: vi.fn(),
    } satisfies MailBackend;
    await expect(
      dispatchTool(
        "email_send",
        { to: ["b@example.com"], subject: "Hi", body: "x" },
        makeCtx("pull", backend),
      ),
    ).rejects.toThrow(/disabled|pull_push|unknown/);
  });

  it("sends when pull_push", async () => {
    const backend = {
      listFolders: vi.fn(),
      findEmails: vi.fn(),
      modifyEmails: vi.fn(),
      sendEmail: vi.fn(async () => ({ messageId: "m1" })),
      respondEmail: vi.fn(),
      listNewSince: vi.fn(),
      getHighestUid: vi.fn(),
    } satisfies MailBackend;
    const result = await dispatchTool(
      "email_send",
      { to: ["b@example.com"], subject: "Hi", body: "x" },
      makeCtx("pull_push", backend),
    );
    expect(result).toEqual({ messageId: "m1" });
    expect(backend.sendEmail).toHaveBeenCalledOnce();
  });

  it("seeds emails_events cursor on first poll", async () => {
    const backend = {
      listFolders: vi.fn(),
      findEmails: vi.fn(),
      modifyEmails: vi.fn(),
      sendEmail: vi.fn(),
      respondEmail: vi.fn(),
      listNewSince: vi.fn(),
      getHighestUid: vi.fn(async () => 42),
    } satisfies MailBackend;
    const ctx = makeCtx("pull", backend);
    const first = (await dispatchTool("emails_events", { advance: true }, ctx)) as {
      count: number;
      cursor: number;
    };
    expect(first.count).toBe(0);
    expect(first.cursor).toBe(42);

    backend.listNewSince = vi.fn(async () => [
      {
        id: "INBOX:43",
        uid: 43,
        account: "default",
        folder: "INBOX",
        subject: "New",
        from: "x@y.z",
        to: ["a@example.com"],
      },
    ]);
    const second = (await dispatchTool("emails_events", { advance: true }, ctx)) as {
      count: number;
      cursor: number;
      messages: Array<{ uid: number }>;
    };
    expect(second.count).toBe(1);
    expect(second.messages[0]?.uid).toBe(43);
    expect(second.cursor).toBe(43);
  });
});

describe("authorizeBearer", () => {
  it("accepts matching bearer", () => {
    expect(authorizeBearer("secret", "Bearer secret")).toBe(true);
    expect(authorizeBearer("secret", "Bearer nope")).toBe(false);
    expect(authorizeBearer("secret", null)).toBe(false);
  });
});
