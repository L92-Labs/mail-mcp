import { describe, expect, it } from "vitest";
import {
  assertFolderManageable,
  assertNotInbox,
  findProtectedFolder,
  isDescendantFolder,
  isInboxPath,
  normalizeFolderPath,
  type FolderInfo,
  type ProtectedFolder,
} from "@mail-mcp/core";

const FOLDERS: FolderInfo[] = [
  { name: "INBOX", path: "INBOX", delimiter: "/" },
  { name: "Receipts", path: "Receipts", delimiter: "/" },
  { name: "Clients", path: "Clients", delimiter: "/" },
  { name: "Sent", path: "Clients/Sent", specialUse: "\\Sent", delimiter: "/" },
  { name: "Drafts", path: "Drafts", specialUse: "\\Drafts", delimiter: "." },
];

const NO_PROTECTED: ProtectedFolder[] = [];

describe("isInboxPath", () => {
  it("matches INBOX case-insensitively only", () => {
    expect(isInboxPath("INBOX")).toBe(true);
    expect(isInboxPath(" inbox ")).toBe(true);
    expect(isInboxPath("INBOX/Sub")).toBe(false);
    expect(isInboxPath("Archive")).toBe(false);
  });
});

describe("normalizeFolderPath", () => {
  it("rejects empty paths", () => {
    expect(() => normalizeFolderPath("   ")).toThrow(/empty/);
  });

  it("rejects leading/trailing whitespace instead of trimming (exact mailbox names)", () => {
    expect(() => normalizeFolderPath("  A/B  ")).toThrow(/leading\/trailing whitespace/);
    expect(() => normalizeFolderPath("Receipts ")).toThrow(/whitespace/);
    expect(normalizeFolderPath("A/B")).toBe("A/B");
  });

  it("rejects control characters (IMAP command framing)", () => {
    expect(() => normalizeFolderPath("Receipts\r\nB1 DELETE Sent")).toThrow(/control characters/);
    expect(() => normalizeFolderPath("A\nB")).toThrow(/control characters/);
    expect(() => normalizeFolderPath("A\u0000B")).toThrow(/control characters/);
    expect(() => normalizeFolderPath("A\u007fB")).toThrow(/control characters/);
  });
});

describe("assertNotInbox", () => {
  it("refuses INBOX for both actions without contacting the server", () => {
    for (const action of ["rename", "delete"] as const) {
      expect(() => assertNotInbox("inbox", action)).toThrow(/INBOX cannot/);
      // Whitespace-carrying variants fail closed too (exact-names rule).
      expect(() => assertNotInbox(" inbox ", action)).toThrow(/whitespace/);
    }
    expect(() => assertNotInbox("Receipts", "delete")).not.toThrow();
  });
});

describe("assertFolderManageable", () => {
  it("allows regular folders and returns the normalized path", () => {
    expect(assertFolderManageable("Receipts", FOLDERS, "delete", NO_PROTECTED)).toBe("Receipts");
    expect(assertFolderManageable("INBOX/Sub", FOLDERS, "rename", NO_PROTECTED)).toBe("INBOX/Sub");
    expect(() => assertFolderManageable(" Receipts ", FOLDERS, "delete", NO_PROTECTED)).toThrow(/whitespace/);
  });

  it("refuses INBOX for rename and delete", () => {
    for (const action of ["rename", "delete"] as const) {
      expect(() => assertFolderManageable("INBOX", FOLDERS, action, NO_PROTECTED)).toThrow(/INBOX cannot/);
      expect(() => assertFolderManageable("inbox", FOLDERS, action, NO_PROTECTED)).toThrow(/INBOX cannot/);
    }
  });

  it("refuses special-use folders (case-insensitive)", () => {
    for (const action of ["rename", "delete"] as const) {
      expect(() => assertFolderManageable("Clients/Sent", FOLDERS, action, NO_PROTECTED)).toThrow(
        /\\Sent folder/,
      );
      expect(() => assertFolderManageable("clients/sent", FOLDERS, action, NO_PROTECTED)).toThrow(
        /\\Sent folder/,
      );
      expect(() => assertFolderManageable("Drafts", FOLDERS, action, NO_PROTECTED)).toThrow(/\\Drafts folder/);
    }
  });

  it("refuses parents that contain a special-use folder", () => {
    for (const action of ["rename", "delete"] as const) {
      expect(() => assertFolderManageable("Clients", FOLDERS, action, NO_PROTECTED)).toThrow(
        /contains the special folder "Clients\/Sent"/,
      );
    }
  });

  it("uses each protected folder's own delimiter for the parent check", () => {
    const mixed: FolderInfo[] = [
      { name: "INBOX", path: "INBOX", delimiter: "/" },
      { name: "Shared", path: "Shared", delimiter: "/" },
      { name: "Sent", path: "Shared.Sent", specialUse: "\\Sent", delimiter: "." },
    ];
    // "/"-only parent matching must NOT catch "Shared", but "." matching must.
    expect(() => assertFolderManageable("Shared", mixed, "delete", NO_PROTECTED)).toThrow(
      /contains the special folder "Shared\.Sent"/,
    );
    const other: FolderInfo[] = [
      { name: "INBOX", path: "INBOX", delimiter: "/" },
      { name: "Other", path: "Other", delimiter: "/" },
      { name: "Sent", path: "Other/Sent", specialUse: "\\Sent", delimiter: "/" },
    ];
    expect(() => assertFolderManageable("Other", other, "delete", NO_PROTECTED)).toThrow(/contains the special folder/);
  });

  it("protects configured/resolved entries passed in", () => {
    const configured: ProtectedFolder[] = [{ path: "X/Drafts", use: "\\Drafts" }];
    expect(() => assertFolderManageable("X/Drafts", FOLDERS, "delete", configured)).toThrow(
      /\\Drafts folder/,
    );
    expect(() => assertFolderManageable("X", FOLDERS, "delete", configured)).toThrow(
      /contains the special folder "X\/Drafts"/,
    );
  });

  it("fails closed on separator aliasing", () => {
    expect(() => assertFolderManageable("Clients/Sent/", FOLDERS, "delete", NO_PROTECTED)).toThrow(/must not end with/);
    expect(() => assertFolderManageable("Clients//Sent", FOLDERS, "delete", NO_PROTECTED)).toThrow(/doubled/);
    expect(() => assertFolderManageable("Drafts.", FOLDERS, "rename", NO_PROTECTED)).toThrow(/must not end with/);
  });

  it("allows case-only renames of ordinary folders through the guard", () => {
    expect(assertFolderManageable("receipts", FOLDERS, "rename", NO_PROTECTED)).toBe("receipts");
  });
});

describe("findProtectedFolder", () => {
  it("matches special-use and configured paths case-insensitively", () => {
    expect(findProtectedFolder("Clients/Sent", FOLDERS, NO_PROTECTED)).toEqual({ path: "Clients/Sent", use: "\\Sent" });
    expect(findProtectedFolder("CLIENTS/SENT", FOLDERS, NO_PROTECTED)?.use).toBe("\\Sent");
    expect(
      findProtectedFolder("X/Drafts", FOLDERS, [{ path: "X/Drafts", use: "\\Drafts" }])?.use,
    ).toBe("\\Drafts");
    expect(findProtectedFolder("Receipts", FOLDERS, NO_PROTECTED)).toBeNull();
  });

  it("rejects control characters", () => {
    expect(() => findProtectedFolder("Sent\r\nX", FOLDERS, NO_PROTECTED)).toThrow(/control characters/);
  });
});


describe("flat namespaces (NIL delimiter)", () => {
  // "." and "/" are literal characters here — "Old.Child" is an unrelated
  // sibling, never a descendant of "Old" (Codex P2, round 6.5r).
  const flat: FolderInfo[] = [
    { name: "Old", path: "Old", delimiter: "" },
    { name: "Old.Child", path: "Old.Child", delimiter: "" },
    { name: "New.Child", path: "New.Child", delimiter: "" },
    { name: "Sent", path: "INBOX.Sent", delimiter: "", specialUse: "\\Sent" },
  ];

  it("infers no descendants in an explicitly flat namespace", () => {
    expect(isDescendantFolder("Old.Child", "Old", flat)).toBe(false);
    expect(isDescendantFolder("Old", "Old", flat)).toBe(false);
  });

  it("keeps destructive targeting exact on flat namespaces", () => {
    // Deleting unrelated "Old" is allowed (protected INBOX.Sent untouched);
    // the protected folder itself is refused (exact match, ci).
    expect(assertFolderManageable("Old", flat, "delete")).toBe("Old");
    expect(() => assertFolderManageable("INBOX.Sent", flat, "delete")).toThrow(/\\Sent folder/);
  });

  it("allows literal dots and slashes in flat-namespace names", () => {
    // Codex P2 (round 6.5t2 era): on flat namespaces dots/slashes are
    // literal characters — ordinary names like Receipts. or Reports..2026
    // rename and delete freely.
    expect(assertFolderManageable("Receipts.", flat, "rename")).toBe("Receipts.");
    expect(assertFolderManageable("Reports..2026", flat, "delete")).toBe("Reports..2026");
    expect(assertFolderManageable("Old/Child", flat, "rename")).toBe("Old/Child");
  });
});