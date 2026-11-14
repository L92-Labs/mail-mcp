import { describe, expect, it } from "vitest";
import { parseLsubName } from "../apps/worker/src/lsub.js";

// Worker-runtime module (cf-imap has no folder-management API), so the LSUB
// line parser is pinned here against the cases GLM pass-12 enumerated.
describe("parseLsubName", () => {
  it("parses quoted names that terminate the line", () => {
    expect(parseLsubName('* LSUB () "." "INBOX.Sub"', null)).toBe("INBOX.Sub");
    expect(parseLsubName('* LSUB () "/" "Receipts"', null)).toBe("Receipts");
    expect(parseLsubName('* LSUB () NIL "Old2024"', null)).toBe("Old2024");
    expect(parseLsubName('* LSUB () "." "INBOX.Sub"  ', null)).toBe("INBOX.Sub");
  });

  it("unescapes quoted special characters", () => {
    const line = '* LSUB () "." "box\\""'; // mailbox literally named: box"
    expect(parseLsubName(line, null)).toBe('box"');
    const line2 = '* LSUB () "." "back\\\\slash"'; // mailbox named: back\slash
    expect(parseLsubName(line2, null)).toBe("back\\slash");
  });

  it("returns null for literal bodies (incl. empty {0})", () => {
    expect(parseLsubName('* LSUB () "." {9}', new Uint8Array([104, 105]))).toBeNull();
    expect(parseLsubName('* LSUB () "." {0}', new Uint8Array(0))).toBeNull();
  });

  it("returns null for unquoted atom names (no phantom delimiter entry)", () => {
    expect(parseLsubName('* LSUB () "." INBOX.X.', null)).toBeNull();
    expect(parseLsubName("* LSUB () NIL INBOX", null)).toBeNull();
    expect(parseLsubName('* LSUB () "." Old2024', null)).toBeNull();
  });

  it("returns null for non-LSUB lines", () => {
    expect(parseLsubName("* OK IMAP4rev1 ready", null)).toBeNull();
    expect(parseLsubName('* STATUS "INBOX" (MESSAGES 3)', null)).toBeNull();
  });
});
