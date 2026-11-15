import { describe, expect, it, vi } from "vitest";
import {
  dispatchTool,
  enabledToolMeta,
  isSieveBye,
  isSieveLiteral,
  isSieveNo,
  isSieveOk,
  memoryCursorStore,
  parseCapabilityLine,
  parseListScriptsEntry,
  quoteSieveString,
  sieveTaggedMessage,
  type DispatchContext,
  type EmailAccount,
  type MailBackend,
  type RuntimeConfig,
  type SieveBackend,
} from "@mail-mcp/core";

describe("sieve wire helpers", () => {
  it("parses LISTSCRIPTS entries with the ACTIVE flag", () => {
    expect(parseListScriptsEntry('"dovecot.sieve" ACTIVE')).toEqual({
      name: "dovecot.sieve",
      active: true,
    });
    expect(parseListScriptsEntry('"vacation"')).toEqual({ name: "vacation", active: false });
    expect(parseListScriptsEntry("OK done")).toBeNull();
  });

  it("parses CAPABILITY lines (quoted and bare)", () => {
    // Quoted form: capabilities are quoted; bare CAPABILITY token added when
    // the first token isn't already CAPABILITY.
    expect(parseCapabilityLine('* CAPABILITY "SIEVE" "FILEINTO" "VACATION"')).toEqual([
      "CAPABILITY",
      "SIEVE",
      "FILEINTO",
      "VACATION",
    ]);
    // Bare form: raw tokens after "* CAPABILITY" (no synthetic CAPABILITY).
    expect(parseCapabilityLine("* CAPABILITY SIEVE FILEINTO")).toEqual([
      "SIEVE",
      "FILEINTO",
    ]);
  });

  it("classifies tagged result lines", () => {
    expect(isSieveOk('OK "Done"')).toBe(true);
    expect(isSieveNo('NO (AUTHFAILED) "bad credentials"')).toBe(true);
    expect(isSieveBye('BYE "closing"')).toBe(true);
    // Non-quoted lines (even with parens) are returned as-is.
    expect(sieveTaggedMessage('NO (AUTHFAILED) "bad credentials"')).toBe(
      'NO (AUTHFAILED) "bad credentials"',
    );
    expect(sieveTaggedMessage('(AUTHFAILED) "bad credentials"')).toBe("bad credentials");
  });

  it("detects literal announcements", () => {
    expect(isSieveLiteral("{123}\r\n")).toEqual({ size: 123 });
    expect(isSieveLiteral("{45+}\r\n")).toEqual({ size: 45 });
    expect(isSieveLiteral("OK")).toBeNull();
  });

  it("quotes and unescapes sieve strings", () => {
    expect(quoteSieveString('He said "hi"')).toBe('"He said \\"hi\\""');
    expect(quoteSieveString("back\\slash")).toBe('"back\\\\slash"');
  });
});

// ---------- dispatch with a fake SieveBackend ----------

const account: EmailAccount = {
  name: "default",
  imap: { host: "imap.example.com", port: 993, secure: true, user: "me@example.com", password: "x" },
};

function fakeSieve(): SieveBackend {
  return {
    capabilities: vi.fn(async () => ["SIEVE", "FILEINTO", "VACATION"]),
    listScripts: vi.fn(async () => [
      { name: "active", active: true },
      { name: "vacation", active: false },
    ]),
    getScript: vi.fn(async (_a: EmailAccount, name: string) =>
      name === "active" ? 'require ["fileinto"]; keep;' : "# vacation draft",
    ),
    putScript: vi.fn(async () => {}),
    checkScript: vi.fn(async (_a: EmailAccount, content: string) =>
      content.includes("BOGUS")
        ? { valid: false, errors: "line 1: unknown command BOGUS" }
        : { valid: true },
    ),
    setActive: vi.fn(async () => {}),
    deleteScript: vi.fn(async () => {}),
  };
}

function sieveCtx(backend: Partial<SieveBackend> = {}): DispatchContext {
  const config: RuntimeConfig = {
    accounts: { default: account },
    defaultAccount: "default",
    mode: "pull",
    cacheTtlSeconds: 0,
    eventsPollSeconds: 0,
    saveSent: "auto",
    sendAllowlist: [],
    maxBodyChars: 20000,
    attachmentMaxBytes: 2000000,
    sieve: { host: "mail.example.com", port: 4190, secure: "starttls" },
  };
  const mailBackend: MailBackend = {
    listFolders: vi.fn(async () => []),
    findEmails: vi.fn(async () => ({ emails: [], total: 0, nextCursor: null })),
    getEmail: vi.fn(),
    modifyEmails: vi.fn(async () => ({ updated: 0 })),
    sendMessage: vi.fn(),
    appendMessage: vi.fn(async () => ({ uid: 1 })),
    listNewSince: vi.fn(async () => ({ messages: [], hasMore: false })),
    getHighestUid: vi.fn(async () => 1),
  };
  return {
    config,
    backend: mailBackend,
    sieve: { ...fakeSieve(), ...backend },
    cursors: memoryCursorStore(),
  };
}

describe("sieve tools", () => {
  it("sieve_scripts_list returns scripts with active flag", async () => {
    const r = (await dispatchTool("sieve_scripts_list", {}, sieveCtx())) as {
      scripts: Array<{ name: string; active: boolean }>;
    };
    expect(r.scripts).toEqual([
      { name: "active", active: true },
      { name: "vacation", active: false },
    ]);
  });

  it("sieve_script_get reads the named script", async () => {
    const sieve = fakeSieve();
    const r = (await dispatchTool(
      "sieve_script_get",
      { name: "active" },
      sieveCtx(sieve),
    )) as { name: string; script: string };
    expect(r.script).toContain("fileinto");
    expect(sieve.getScript).toHaveBeenCalledWith(account, "active");
  });

  it("sieve_script_put validates before saving (default true)", async () => {
    const sieve = fakeSieve();
    await expect(
      dispatchTool("sieve_script_put", { name: "active", content: "BOGUS script" }, sieveCtx(sieve)),
    ).rejects.toThrow(/invalid — not saved/);
    expect(sieve.putScript).not.toHaveBeenCalled();
    await dispatchTool(
      "sieve_script_put",
      { name: "active", content: 'require ["fileinto"]; keep;', validate: false },
      sieveCtx(sieve),
    );
    expect(sieve.putScript).toHaveBeenCalledWith(account, "active", 'require ["fileinto"]; keep;');
  });

  it("sieve_script_check returns server verdict", async () => {
    const r = (await dispatchTool("sieve_script_check", { content: "keep;" }, sieveCtx())) as {
      valid: boolean;
    };
    expect(r.valid).toBe(true);
  });

  it("sieve_script_activate activates", async () => {
    const sieve = fakeSieve();
    const r = (await dispatchTool("sieve_script_activate", { name: "vacation" }, sieveCtx(sieve))) as {
      activated: boolean;
      name: string;
    };
    expect(r).toMatchObject({ activated: true, name: "vacation" });
  });

  it("sieve_script_delete requires confirm (schema)", async () => {
    const sieve = fakeSieve();
    await expect(
      dispatchTool("sieve_script_delete", { name: "old" }, sieveCtx(sieve)),
    ).rejects.toThrow(/confirm/);
    expect(sieve.deleteScript).not.toHaveBeenCalled();
    const r = (await dispatchTool(
      "sieve_script_delete",
      { name: "old", confirm: true },
      sieveCtx(sieve),
    )) as { deleted: boolean };
    expect(r.deleted).toBe(true);
  });

  it("sieve tools are hidden without SIEVE config", () => {
    const config: RuntimeConfig = {
      accounts: { default: account },
      defaultAccount: "default",
      mode: "pull",
      cacheTtlSeconds: 0,
      eventsPollSeconds: 0,
      saveSent: "auto",
      sendAllowlist: [],
      maxBodyChars: 20000,
      attachmentMaxBytes: 2000000,
    };
    const names = enabledToolMeta(config).map((t) => t.name);
    expect(names).not.toContain("sieve_scripts_list");
    expect(names).toContain("emails_find");
  });

  it("sieve tools are registered when SIEVE config is present", () => {
    const config: RuntimeConfig = {
      accounts: { default: account },
      defaultAccount: "default",
      mode: "pull",
      cacheTtlSeconds: 0,
      eventsPollSeconds: 0,
      saveSent: "auto",
      sendAllowlist: [],
      maxBodyChars: 20000,
      attachmentMaxBytes: 2000000,
      sieve: { host: "mail.example.com", port: 4190, secure: "starttls" },
    };
    const names = enabledToolMeta(config).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "sieve_scripts_list",
        "sieve_script_get",
        "sieve_script_put",
        "sieve_script_check",
        "sieve_script_activate",
        "sieve_script_delete",
      ]),
    );
  });
});
