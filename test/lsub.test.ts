import { describe, expect, it } from "vitest";
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

  it("returns null for non-LSUB lines", () => {
    expect(parseLsubName("* OK IMAP4rev1 ready", null)).toBeNull();
    expect(parseLsubName('* STATUS "INBOX" (MESSAGES 3)', null)).toBeNull();
  });
});
