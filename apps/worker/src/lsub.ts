/**
 * Extract the mailbox name from an untagged LSUB line
 * (`* LSUB (<flags>) <delimiter> <mailbox>`). Pure and I/O-free so it can be
 * unit-tested outside the Workers runtime.
 *
 * - Literal bodies: the raw bytes ARE the mailbox name (no quoting), decoded
 *   as text here and mUTF-7-decoded by the caller.
 * - Quoted mailbox: `\"` / `\\` unescaped.
 * - Unquoted atom mailbox (may contain the delimiter, e.g. `Old/Child` on
 *   multi-delimiter setups): returned as-is.
 * Returns null when the line is not LSUB or carries no usable name.
 */
export function parseLsubName(line: string, literal: Uint8Array | null | undefined): string | null {
  if (!line.startsWith("* LSUB")) return null;
  if (literal != null) {
    // Names may legitimately end in whitespace — decode without trimming.
    const decoded = new TextDecoder().decode(literal);
    return decoded.length ? decoded : null;
  }
  // Trim the line (transport padding) — the captured mailbox keeps its own
  // whitespace, which may legitimately be part of the name.
  const m = /^\* LSUB \([^)]*\) (?:"((?:[^"\\]|\\.)*)"|NIL|\S+) (.+)$/.exec(line.trim());
  if (!m) return null;
  const mailbox = m[2];
  if (!mailbox) return null;
  if (mailbox.startsWith('"') && mailbox.endsWith('"') && mailbox.length >= 2) {
    return mailbox.slice(1, -1).replace(/\\(["\\])/g, "$1") || null;
  }
  return mailbox;
}

/**
 * Resolve the server-stored name for a created/renamed folder from a listing:
 * exact match, then case-insensitive, then suffix match at a delimiter
 * boundary (namespace prefixes like "INBOX." store prefixed names for
 * unprefixed arguments; the boundary may also be the child's own separator,
 * e.g. "Work/Foo" stored as "INBOX.Work/Foo"). Returns `wanted` when nothing
 * matches (caller treats it as server truth).
 */
export function resolveStoredName(
  after: Array<{ name: string; delimiter?: string }>,
  wanted: string,
): string {
  const lower = wanted.toLowerCase();
  const exact = after.find((f) => f.name === wanted);
  if (exact) return exact.name;
  const ci = after.find((f) => f.name.toLowerCase() === lower);
  if (ci) return ci.name;
  const prefixed = after.find((f) => {
    const name = f.name.toLowerCase();
    if (!name.endsWith(lower)) return false;
    const boundary = name.charAt(name.length - lower.length - 1);
    return boundary === f.delimiter?.toLowerCase() || boundary === "/" || boundary === ".";
  });
  return prefixed?.name ?? wanted;
}
