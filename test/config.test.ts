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
});
