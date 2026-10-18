import { describe, expect, it } from "vitest";
import {
  extractAddress,
  htmlToText,
  isRecipientAllowed,
  pageUids,
  parseFolderAlias,
  resolveSpecialFolder,
  splitAddressList,
} from "@mail-mcp/core";

describe("addresses", () => {
  it("extracts and splits", () => {
    expect(extractAddress('"Doe, Jane" <Jane@X.com>')).toBe("jane@x.com");
    expect(extractAddress(" bob@y.com ")).toBe("bob@y.com");
    expect(splitAddressList('"Doe, Jane" <j@x.com>, bob@y.com; <c@z.com>')).toEqual([
      '"Doe, Jane" <j@x.com>',
      "bob@y.com",
      "<c@z.com>",
    ]);
  });
});

describe("isRecipientAllowed", () => {
  it("matches exact addresses, domains and subdomains", () => {
    const list = ["corp.com", "@partner.io", "me@gmail.com"];
    expect(isRecipientAllowed(list, "a@corp.com")).toBe(true);
    expect(isRecipientAllowed(list, "a@eu.corp.com")).toBe(true);
    expect(isRecipientAllowed(list, "a@notcorp.com")).toBe(false);
    expect(isRecipientAllowed(list, "x@partner.io")).toBe(true);
    expect(isRecipientAllowed(list, "Me <ME@gmail.com>")).toBe(true);
    expect(isRecipientAllowed(list, "other@gmail.com")).toBe(false);
    expect(isRecipientAllowed([], "anyone@anywhere.com")).toBe(true);
  });
});

describe("pageUids", () => {
  const uids = Array.from({ length: 45 }, (_, i) => i + 1);
  it("pages newest first with an exclusive cursor", () => {
    const p1 = pageUids(uids, 20);
    expect(p1.selected).toEqual(uids.slice(25));
    expect(p1).toMatchObject({ total: 45, nextCursor: "26" });
    const p2 = pageUids(uids, 20, p1.nextCursor!);
    expect(p2.selected).toEqual(uids.slice(5, 25));
    const p3 = pageUids(uids, 20, p2.nextCursor!);
    expect(p3.selected).toEqual(uids.slice(0, 5));
    expect(p3.nextCursor).toBeNull();
  });
  it("rejects garbage cursors", () => {
    expect(() => pageUids(uids, 5, "abc")).toThrow(/cursor/);
  });
});

describe("folders", () => {
  const folders = [
    { name: "INBOX", path: "INBOX" },
    { name: "Sent Items", path: "INBOX.Sent Items" },
    { name: "Corbeille", path: "Corbeille" },
    { name: "All Mail", path: "[Gmail]/All Mail", specialUse: "\\All" },
    { name: "Archive", path: "Archive", specialUse: "\\Archive" },
  ];
  it("resolves by special-use, then by name", () => {
    expect(resolveSpecialFolder(folders, "archive")).toBe("Archive");
    expect(resolveSpecialFolder(folders, "sent")).toBe("INBOX.Sent Items");
    expect(resolveSpecialFolder(folders, "trash")).toBe("Corbeille");
    expect(resolveSpecialFolder(folders, "drafts")).toBeNull();
  });
  it("parses aliases", () => {
    expect(parseFolderAlias("\\Trash")).toBe("trash");
    expect(parseFolderAlias("Spam")).toBe("junk");
    expect(parseFolderAlias("Projects")).toBeNull();
  });
});

describe("htmlToText", () => {
  it("strips markup and decodes entities", () => {
    expect(
      htmlToText("<style>p{}</style><p>Hi&nbsp;Bob &amp; co</p><ul><li>one</li><li>two</li></ul>caf&#233;"),
    ).toBe("Hi Bob & co\n- one\n- two\ncafé");
  });
});
