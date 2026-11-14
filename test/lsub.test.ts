import { describe, expect, it } from "vitest";
import { resolveProtectedCandidates, resolveStoredName } from "@mail-mcp/core";
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
    { name: "Work", path: "INBOX/Work", delimiter: "/" }, // slash-delimiter convention
    { name: "Archive", path: "Archive", delimiter: "/" },
  ];

  it("resolves exact full paths only (never case substitution)", () => {
    expect(resolveStoredName(listing, "Archive")).toBe("Archive");
    // Case variants are not substituted into destructive targets: the
    // backend acts on the raw name and the server errors harmlessly.
    expect(resolveStoredName(listing, "archive")).toBe("archive");
    expect(resolveStoredName(listing, "INBOX.Sent")).toBe("INBOX.Sent");
  });

  it("resolves via the INBOX-prefix convention (dot and slash forms)", () => {
    expect(resolveStoredName(listing, "Sent")).toBe("INBOX.Sent");
    expect(resolveStoredName(listing, "Work")).toBe("INBOX/Work");
  });

  it("never resolves destructive lookalikes (namespace safety)", () => {
    // Corruption pin (round 6.5q): the leaf "2026" collides with unrelated
    // Reports.2026 — must NOT resolve there (a case-insensitive leaf match
    // or LIST-order dependence would delete an unrelated mailbox).
    expect(resolveStoredName(listing, "2026")).toBe("2026");
  });

  it("INBOX.X on a flat namespace is an independent mailbox (no convention)", () => {
    // Codex P1 (round 6.5t2): flat namespace — "INBOX.Receipts" is a literal
    // name; folder_delete Receipts must not delete INBOX.Receipts.
    const flat = [
      { name: "Receipts", path: "Receipts", delimiter: "" },
      { name: "INBOX.Receipts", path: "INBOX.Receipts", delimiter: "" },
    ];
    expect(resolveStoredName(flat, "Receipts")).toBe("Receipts");
    expect(resolveStoredName(flat, "receipts")).toBe("receipts");
  });

  it("INBOX.X on a flat/unreported namespace never resolves (discriminating pin)", () => {
    // The listing contains ONLY INBOX.Receipts — no exact Receipts entry —
    // so the byPath stage cannot short-circuit: a pre-fix resolver would
    // return INBOX.Receipts (the Codex P1 corruption shape); the delimiter
    // guard must return the raw name instead.
    const flatOnlyInbox = [{ name: "INBOX.Receipts", path: "INBOX.Receipts", delimiter: "" }];
    expect(resolveStoredName(flatOnlyInbox, "Receipts")).toBe("Receipts");
    // Unreported delimiter (undefined) takes the same fail-closed branch.
    const unreported = [{ name: "INBOX.Receipts", path: "INBOX.Receipts" }];
    expect(resolveStoredName(unreported, "Receipts")).toBe("Receipts");
  });

  it("INBOX.X on a slash-delimiter hierarchical server resolves (convention)", () => {
    const slash = [
      { name: "Sent", path: "INBOX/Sent", delimiter: "/" },
    ];
    expect(resolveStoredName(slash, "Sent")).toBe("INBOX/Sent");
  });

  it("no match returns the wanted name", () => {
    expect(resolveStoredName(listing, "Nope")).toBe("Nope");
  });
});

describe("resolveProtectedCandidates", () => {
  // Non-INBOX namespace prefix (e.g. Courier "Folders."): the guard
  // resolution over-protects — a bare-leaf override resolves onto the
  // prefixed stored path. The configured value itself is always included
  // verbatim (protection applies even when the listing lacks it).
  const listing = [
    { name: "Folders.Sent", path: "Folders.Sent", delimiter: "." },
    { name: "Folders.Work/Foo", path: "Folders.Work/Foo", delimiter: "/" },
  ];

  it("resolves bare-leaf overrides onto prefixed stored paths (plus verbatim)", () => {
    const got = resolveProtectedCandidates(listing, "Sent");
    expect(got).toEqual(expect.arrayContaining(["Sent", "Folders.Sent"]));
  });

  it("resolves composite overrides onto prefixed stored paths (plus verbatim)", () => {
    const got = resolveProtectedCandidates(listing, "Work/Foo");
    expect(got).toEqual(expect.arrayContaining(["Work/Foo", "Folders.Work/Foo"]));
  });

  it("no listing match still protects the configured value verbatim", () => {
    expect(resolveProtectedCandidates(listing, "Nope")).toEqual(["Nope"]);
  });

  it("duplicate leaf names protect every candidate (plus verbatim)", () => {
    const dup = [
      { name: "Other", path: "Folders.Other.Sent", delimiter: "." },
      { name: "Sent", path: "Folders.Sent", delimiter: "." },
    ];
    const got = resolveProtectedCandidates(dup, "Sent");
    expect(got).toEqual(expect.arrayContaining(["Folders.Other.Sent", "Folders.Sent", "Sent"]));
  });
});
