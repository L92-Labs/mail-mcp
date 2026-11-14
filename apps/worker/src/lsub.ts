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
  if (literal != null) {
    const decoded = new TextDecoder().decode(literal).trim();
    return decoded || null;
  }
  const m = /^\* LSUB \([^)]*\) (?:"((?:[^"\\]|\\.)*)"|NIL|\S+) (.+)$/.exec(line);
  if (!m) return null;
  const mailbox = m[2].trim();
  if (!mailbox) return null;
  if (mailbox.startsWith('"') && mailbox.endsWith('"') && mailbox.length >= 2) {
    return mailbox.slice(1, -1).replace(/\\(["\\])/g, "$1") || null;
  }
  return mailbox;
}
