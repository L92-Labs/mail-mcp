import type { SieveScriptSummary } from "./types.js";


/** Escape a string for a ManageSieve quoted string. */
/** Render a ManageSieve quoted string. The caller must pre-screen: CR, LF
 *  and other control characters are illegal inside a quoted string (they
 *  would split the command stream) and must travel as a {N+} literal — so
 *  this throws rather than emitting them raw. */
export function quoteSieveString(value: string): string {
  if (/[\r\n\x00-\x1f\x7f]/.test(value)) {
    throw new Error(
      "quoted Sieve string would contain a control character; use the literal form instead",
    );
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Unescape a parsed ManageSieve quoted string (\" and \\). */
export function unescapeSieveString(value: string): string {
  return value.replace(/\\(["\\])/g, "$1");
}

/** Parse an untagged LISTSCRIPTS entry line into its name and active flag.
 *  Handles quoted names; ACTIVE token marks the active script. Returns null
 *  for non-data lines. */
export function parseListScriptsEntry(line: string): SieveScriptSummary | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (/^(OK|NO|BYE)\b/i.test(trimmed)) return null; // tagged line, not an entry
  const activeMatch = /\s+ACTIVE$/i.exec(trimmed);
  const active = activeMatch !== null;
  const bare = activeMatch ? trimmed.slice(0, activeMatch.index) : trimmed;
  if (!bare) return null;
  if (bare.startsWith('"')) {
    // Quoted form: RFC 5804 §2.7 `"name" [ACTIVE]`.
    const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(bare);
    if (!quoted) return null;
    return { name: unescapeSieveString(quoted[1]), active };
  }
  // Bare form: the client assembled the raw bytes of a synchronised-literal
  // name back into the line — the name is exactly those bytes.
  return { name: bare, active };
}

/** Parse a CAPABILITY untagged line into capability tokens (quoted or bare). */
export function parseCapabilityLine(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) out.push(unescapeSieveString(m[1]));
  if (out.length === 0) {
    // Bare-token form: * CAPABILITY SIEVE FILEINTO ...
    for (const tok of line.split(/\s+/).slice(2)) if (tok) out.push(tok);
  } else if (out[0].toUpperCase() !== "CAPABILITY") {
    out.unshift("CAPABILITY");
  }
  return out;
}

/** Extract the human-readable message from a tagged OK/NO line (drops the
 *  parens-wrapped response code if present; unwraps a quoted message). */
export function sieveTaggedMessage(line: string): string {
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(line.trim());
  if (quoted) return unescapeSieveString(quoted[1]);
  const parens = /^\((.*?)\)\s*(.*)$/.exec(line.trim());
  if (parens) {
    const rest = parens[2] || parens[1];
    const innerQuoted = /^"((?:[^"\\]|\\.)*)"$/.exec(rest);
    return innerQuoted ? unescapeSieveString(innerQuoted[1]) : rest;
  }
  return line.trim();
}

/** True when the tagged result line is OK. */
export function isSieveOk(line: string): boolean {
  return /^OK\b/i.test(line.trim());
}

/** True when the tagged result line is NO (server refused). */
export function isSieveNo(line: string): boolean {
  return /^NO\b/i.test(line.trim());
}

/** True when the line is a BYE (server closing the connection). */
export function isSieveBye(line: string): boolean {
  return /^BYE\b/i.test(line.trim());
}

/** True when the line announces a literal: {N} or {N+}. */
export function isSieveLiteral(line: string): { size: number } | null {
  const m = /^\{(\d+)(\+)?\}\s*$/.exec(line.trim());
  return m ? { size: Number(m[1]) } : null;
}
