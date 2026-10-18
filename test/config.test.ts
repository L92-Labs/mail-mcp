import { describe, expect, it } from "vitest";
import { loadRuntimeConfig, resolveAccount } from "@mail-mcp/core";

describe("loadRuntimeConfig", () => {
  it("loads single-account IMAP/SMTP env", () => {
    const config = loadRuntimeConfig({
      IMAP_HOST: "imap.example.com",
      IMAP_USER: "a@example.com",
      IMAP_PASS: "secret",
      SMTP_HOST: "smtp.example.com",
      SMTP_USER: "a@example.com",
      SMTP_PASS: "secret",
      MAIL_MODE: "pull_push",
    });
    expect(config.defaultAccount).toBe("default");
    expect(config.mode).toBe("pull_push");
    expect(config.accounts.default?.imap.host).toBe("imap.example.com");
    expect(config.accounts.default?.smtp?.host).toBe("smtp.example.com");
  });

  it("loads EMAIL_ACCOUNTS_JSON", () => {
    const config = loadRuntimeConfig({
      EMAIL_ACCOUNTS_JSON: JSON.stringify({
        work: {
          imap: {
            host: "imap.example.com",
            port: 993,
            user: "w@example.com",
            password: "x",
          },
          smtp: {
            host: "smtp.example.com",
            port: 587,
            user: "w@example.com",
            password: "x",
          },
        },
      }),
      DEFAULT_EMAIL_ACCOUNT: "work",
      MAIL_MODE: "pull",
    });
    expect(resolveAccount(config).name).toBe("work");
    expect(config.mode).toBe("pull");
  });

  it("rejects pull_push without SMTP", () => {
    expect(() =>
      loadRuntimeConfig({
        IMAP_HOST: "imap.example.com",
        IMAP_USER: "a@example.com",
        IMAP_PASS: "secret",
        MAIL_MODE: "pull_push",
      }),
    ).toThrow(/requires SMTP/);
  });

  it("allows pull without SMTP", () => {
    const config = loadRuntimeConfig({
      IMAP_HOST: "imap.example.com",
      IMAP_USER: "a@example.com",
      IMAP_PASS: "secret",
      MAIL_MODE: "pull",
    });
    expect(config.accounts.default?.smtp).toBeUndefined();
  });

  it("defaults to safe policy values", () => {
    const config = loadRuntimeConfig({ IMAP_HOST: "h", IMAP_USER: "u", IMAP_PASS: "p", MAIL_MODE: "pull" });
    expect(config).toMatchObject({
      saveSent: "auto",
      sendAllowlist: [],
      maxBodyChars: 20_000,
      attachmentMaxBytes: 2_000_000,
      cacheTtlSeconds: 0,
    });
  });

  it("accepts draft mode without SMTP and parses policy env", () => {
    const config = loadRuntimeConfig({
      EMAIL_ACCOUNTS_JSON: JSON.stringify({
        me: {
          imap: { host: "h", user: "u@x.com", password: "p" },
          save_sent: false,
          drafts_folder: "INBOX.Drafts",
        },
      }),
      MAIL_MODE: "draft",
      SAVE_SENT: "true",
      SEND_ALLOWLIST: "corp.com, Boss@Gmail.com",
    });
    expect(config.mode).toBe("draft");
    expect(config.saveSent).toBe("always");
    expect(config.sendAllowlist).toEqual(["corp.com", "boss@gmail.com"]);
    expect(config.accounts.me).toMatchObject({ saveSent: "never", draftsFolder: "INBOX.Drafts" });
  });

  it("rejects invalid MAIL_MODE and SAVE_SENT", () => {
    const base = { IMAP_HOST: "h", IMAP_USER: "u", IMAP_PASS: "p" };
    expect(() => loadRuntimeConfig({ ...base, MAIL_MODE: "push" })).toThrow(/MAIL_MODE/);
    expect(() => loadRuntimeConfig({ ...base, MAIL_MODE: "pull", SAVE_SENT: "maybe" })).toThrow(/SAVE_SENT/);
  });
});
