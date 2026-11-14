import { describe, expect, it } from "vitest";
import { resolveProtectedName, resolveStoredName } from "@mail-mcp/core";
import { parseLsubName } from "../apps/worker/src/lsub.js";

// Worker-runtime module (cf-imap has no folder-management API), so the LSUB
// line parser is pinned here against the cases GLM pass-12 enumerated.
describe("parseLsubName", () => {
  it("parses quoted mailbox names", () => {
    expect(parseLsubName('* LSUB () "." "INBOX.Sub"', null)).toBe("INBOX.Sub");
    expect(parseLsubName('* LSUB () "/" "Receipts"', null)).toBe("Receipts");
    expect(parseLsubName('* LSUB () NIL "Old2024"', null)).toBe("Old2024");
    expect(parseLsubName('* LSUB () "." "INBOX.Sub"  ', null)).toBe("INBOX.Sub");
  });

  it("parses unquoted atom mailbox names (may contain other separators)", () => {
    expect(parseLsubName('* LSUB () "." INBOX.X.', null)).toBe("INBOX.X.");
    expect(parseLsubName('* LSUB () "." Old2024', null)).toBe("Old2024");
    expect(parseLsubName('* LSUB () "/" Old/Child', null)).toBe("Old/Child");
    expect(parseLsubName("* LSUB () NIL INBOX", null)).toBe("INBOX");
  });

  it("unescapes quoted special characters", () => {
    const line = '* LSUB () "." "box\\""'; // mailbox literally named: box"
    expect(parseLsubName(line, null)).toBe('box"');
    const line2 = '* LSUB () "." "back\\\\slash"'; // mailbox named: back\slash
    expect(parseLsubName(line2, null)).toBe("back\\slash");
  });

  it("decodes literal bodies as the mailbox name", () => {
    expect(parseLsubName('* LSUB () "." {9}', new TextEncoder().encode("INBOX.Sub"))).toBe("INBOX.Sub");
    expect(parseLsubName('* LSUB () NIL {6}', new TextEncoder().encode("Old2024"))).toBe("Old2024");
  });

  it("returns null for empty or protocol-invalid names", () => {
    expect(parseLsubName('* LSUB () "." ""', null)).toBeNull();
    expect(parseLsubName('* LSUB () "." {0}', new Uint8Array(0))).toBeNull();
  });

  it("returns null for non-LSUB lines (literals included)", () => {
    expect(parseLsubName("* OK IMAP4rev1 ready", null)).toBeNull();
    expect(parseLsubName('* STATUS "INBOX" (MESSAGES 3)', null)).toBeNull();
    // Regression pin (pass-15 LOW): a literal body on a non-LSUB line must
    // not be adopted as a subscribed path.
    expect(parseLsubName("* STATUS () NIL {7}", new TextEncoder().encode("Archive"))).toBeNull();
  });

  it("preserves whitespace in quoted and literal names", () => {
    // Pass-19 LOW pin: trimming would break exact subscription matching.
    expect(parseLsubName('* LSUB () "." "INBOX.Sub "', null)).toBe("INBOX.Sub ");
    expect(parseLsubName('* LSUB () "." {10}', new TextEncoder().encode("INBOX.Sub "))).toBe(
      "INBOX.Sub ",
    );
  });
});

describe("resolveStoredName", () => {
  // Worker-shaped entries: name = leaf segment, path = full stored path.
  const listing = [
    { name: "2026", path: "Reports.2026", delimiter: "." }, // unrelated lookalike
    { name: "Sent", path: "INBOX.Sent", delimiter: "." }, // INBOX-prefix convention
    { name: "Foo", path: "INBOX.Work/Foo", delimiter: "/" }, // composite child
    { name: "Work", path: "INBOX.Work", delimiter: "." },
    { name: "Archive", path: "Archive", delimiter: "/" },
  ];

  it("resolves exact and case-insensitive full paths", () => {
    expect(resolveStoredName(listing, "Archive")).toBe("Archive");
    expect(resolveStoredName(listing, "archive")).toBe("Archive");
    expect(resolveStoredName(listing, "INBOX.Sent")).toBe("INBOX.Sent");
  });

  it("resolves via the INBOX-prefix convention for unprefixed aliases", () => {
    expect(resolveStoredName(listing, "Sent")).toBe("INBOX.Sent");
    expect(resolveStoredName(listing, "Work")).toBe("INBOX.Work");
    // Bare child names stay unresolved: ambiguous by design (the dispatch
    // rename path resolves the full source root instead).
    expect(resolveStoredName(listing, "Foo")).toBe("Foo");
  });

  it("never resolves destructive leaf-collision lookalikes", () => {
    // Corruption pin (round 6.5q): the leaf "2026" collides with unrelated
    // Reports.2026 — must NOT resolve there (a case-insensitive leaf match
    // or LIST-order dependence would delete an unrelated mailbox).
    expect(resolveStoredName(listing, "2026")).toBe("2026");
  });

  it("no match returns the wanted name", () => {
    expect(resolveStoredName(listing, "Nope")).toBe("Nope");
  });

  it("never resolves destructive lookalikes (namespace safety)", () => {
    // Corruption pin (round 6.5q): the leaf "2026" collides with unrelated
    // Reports.2026 — must NOT resolve there (a case-insensitive leaf match
    // or LIST-order dependence would delete an unrelated mailbox).
    expect(resolveStoredName(listing, "2026")).toBe("2026");
  });
});

describe("resolveProtectedName", () => {
  // Non-INBOX namespace prefix (e.g. Courier "Folders."): the guard
  // resolution over-protects — a bare-leaf override resolves onto the
  // prefixed stored path.
  const listing = [
    { name: "Folders.Sent", path: "Folders.Sent", delimiter: "." },
    { name: "Folders.Work/Foo", path: "Folders.Work/Foo", delimiter: "/" },
  ];

  it("resolves bare-leaf overrides onto prefixed stored paths", () => {
    expect(resolveProtectedName(listing, "Sent")).toBe("Folders.Sent");
    expect(resolveProtectedName(listing, "Work/Foo")).toBe("Folders.Work/Foo");
  });

  it("falls back to the wanted name when nothing matches", () => {
    expect(resolveProtectedName(listing, "Nope")).toBe("Nope");
  });
});
