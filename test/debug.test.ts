import { describe, expect, it, vi } from "vitest";
import { dispatchTool, memoryCursorStore, type DispatchContext, type EmailAccount, type MailBackend, type RuntimeConfig } from "@mail-mcp/core";

const account: EmailAccount = {
  name: "default",
  imap: { host: "imap.example.com", port: 993, secure: true, user: "me@example.com", password: "x" },
};

function makeCtx(backend: MailBackend, acct: EmailAccount): DispatchContext {
  const config: RuntimeConfig = {
    accounts: { default: acct },
    defaultAccount: "default",
    mode: "pull_push",
    cacheTtlSeconds: 0,
    eventsPollSeconds: 0,
    saveSent: "auto",
    sendAllowlist: [],
    maxBodyChars: 20000,
    attachmentMaxBytes: 2000000,
  };
  return { config, backend, cursors: memoryCursorStore() };
}

it("debug dispatch delete", async () => {
  const b = {
    listFolders: vi.fn(async () => [
      { name: "INBOX", path: "INBOX", delimiter: "." },
      { name: "CustomSent", path: "INBOX.CustomSent", delimiter: "." },
    ]),
    findEmails: vi.fn(async () => ({ emails: [], total: 0, nextCursor: null })),
    getEmail: vi.fn(),
    modifyEmails: vi.fn(async () => ({ updated: 0 })),
    sendMessage: vi.fn(),
    appendMessage: vi.fn(async () => ({ uid: 1 })),
    listNewSince: vi.fn(async () => ({ messages: [], hasMore: false })),
    getHighestUid: vi.fn(async () => 1),
    renameFolder: vi.fn(),
    createFolder: vi.fn(),
    deleteFolder: vi.fn(async () => ({ path: "INBOX.CustomSent" })),
  } as unknown as MailBackend;
  const acct = { ...account, sentFolder: "CustomSent" };
  const ctx = makeCtx(b, acct);
  console.log("folders as seen by dispatch:", JSON.stringify(await ctx.backend.listFolders(acct)));
  try {
    await dispatchTool("folder_delete", { path: "INBOX.CustomSent", confirm: true }, ctx);
    console.log("DELETE SUCCEEDED (bad)");
  } catch (e) {
    console.log("DELETE REFUSED:", (e as Error).message);
  }
});
