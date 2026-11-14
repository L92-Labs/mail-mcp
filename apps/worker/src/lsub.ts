/**
 * Extract the mailbox name from an untagged LSUB line. Pure and I/O-free so
 * it can be unit-tested outside the Workers runtime. Best-effort:
 * - literal bodies (raw bytes, incl. empty `{0}`) return null — those names
 *   stay unmigrated;
 * - unquoted atom names return null (guards against the delimiter being
 *   mistaken for the name);
 * - quoted names are returned with `\"` / `\\` unescaped.
 */
export function parseLsubName(line: string, literal: unknown): string | null {
  if (literal != null) return null;
  if (!line.startsWith("* LSUB")) return null;
  const quoted = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)];
  const last = quoted.at(-1);
  if (!last) return null;
  // The mailbox name must terminate the line; an unquoted atom after the
  // last quoted token means the name was an astring we did not parse.
  if (line.slice((last.index ?? 0) + last[0].length).trim() !== "") return null;
  return last[1].replace(/\\(["\\])/g, "$1");
}
