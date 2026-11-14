import { describe, expect, it } from "vitest";
import { assertFolderManageable, isInboxPath, normalizeFolderPath } from "@mail-mcp/core";
import type { FolderInfo } from "@mail-mcp/core";

const FOLDERS: FolderInfo[] = [
  { name: "INBOX", path: "INBOX", delimiter: "/" },
  { name: "Receipts", path: "Receipts", delimiter: "/" },
  { name: "Clients", path: "Clients", delimiter: "/" },
  { name: "Sent", path: "Clients/Sent", specialUse: "\\Sent", delimiter: "/" },
  { name: "Drafts", path: "Drafts", specialUse: "\\Drafts", delimiter: "." },
];

describe("isInboxPath", () => {
  it("matches INBOX case-insensitively only", () => {
    expect(isInboxPath("INBOX")).toBe(true);
    expect(isInboxPath(" inbox ")).toBe(true);
    expect(isInboxPath("INBOX/Sub")).toBe(false);
    expect(isInboxPath("Archive")).toBe(false);
  });
});

describe("normalizeFolderPath", () => {
  it("trims and rejects empty paths", () => {
    expect(normalizeFolderPath("  A/B  ")).toBe("A/B");
    expect(() => normalizeFolderPath("   ")).toThrow(/empty/);
  });
});

describe("assertFolderManageable", () => {
  it("allows regular folders and returns the normalized path", () => {
    expect(assertFolderManageable(" Receipts ", FOLDERS, "delete")).toBe("Receipts");
    expect(assertFolderManageable("INBOX/Sub", FOLDERS, "rename")).toBe("INBOX/Sub");
  });

  it("refuses INBOX for rename and delete", () => {
    for (const action of ["rename", "delete"] as const) {
      expect(() => assertFolderManageable("INBOX", FOLDERS, action)).toThrow(/INBOX cannot/);
      expect(() => assertFolderManageable("inbox", FOLDERS, action)).toThrow(/INBOX cannot/);
    }
  });

  it("refuses special-use folders", () => {
    for (const action of ["rename", "delete"] as const) {
      expect(() => assertFolderManageable("Clients/Sent", FOLDERS, action)).toThrow(
        /\\Sent folder/,
      );
      expect(() => assertFolderManageable("Drafts", FOLDERS, action)).toThrow(/\\Drafts folder/);
    }
  });

  it("refuses parents that contain a special-use folder", () => {
    for (const action of ["rename", "delete"] as const) {
      expect(() => assertFolderManageable("Clients", FOLDERS, action)).toThrow(
        /contains the special folder "Clients\/Sent"/,
      );
    }
  });

  it("detects parents with a dot delimiter and unknown delimiter", () => {
    expect(() => assertFolderManageable("Clients", FOLDERS, "delete")).toThrow(/Clients\/Sent/);
    const noDelimiter: FolderInfo[] = [
      { name: "P", path: "P" },
      { name: "Sent", path: "P.Sent", specialUse: "\\Sent" },
    ];
    expect(() => assertFolderManageable("P", noDelimiter, "delete")).toThrow(
      /contains the special folder/,
    );
  });

  it("ignores lookalike prefixes that are not children", () => {
    const folders: FolderInfo[] = [
      { name: "Clients2", path: "Clients2", delimiter: "/" },
      { name: "Sent", path: "Clients2x/Sent", specialUse: "\\Sent", delimiter: "/" },
    ];
    expect(assertFolderManageable("Clients2", folders, "delete")).toBe("Clients2");
  });
});
