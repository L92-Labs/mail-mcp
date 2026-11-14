import type { FolderInfo } from "./types.js";

/** C0 controls (incl. CR/LF/NUL) and DEL can break IMAP command framing on some clients. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** INBOX is case-insensitive per RFC 3501; other folder names are not. */
export function isInboxPath(path: string): boolean {
  return path.trim().toUpperCase() === "INBOX";
}

export function normalizeFolderPath(value: string): string {
  const path = value.trim();
  if (!path) throw new Error("folder path is empty");
  // IMAP names may legitimately contain leading/trailing spaces (RFC 3501 §5.1);
  // trimming silently would let " Receipts " delete "Receipts". Fail closed.
  if (path !== value) {
    throw new Error("folder path has leading/trailing whitespace; pass the exact path from folders_list");
  }
  if (CONTROL_CHARS.test(path)) throw new Error("folder path contains control characters");
  return path;
}

/** Fail fast without contacting the server: INBOX can never be renamed or deleted. */
export function assertNotInbox(value: string, action: "rename" | "delete"): void {
  if (isInboxPath(normalizeFolderPath(value))) {
    throw new Error(
      `INBOX cannot be ${action}d; move its messages instead (emails_modify with move_to_folder)`,
    );
  }
}

function sharedDelimiter(folders: FolderInfo[]): string {
  return folders.find((f) => f.delimiter)?.delimiter ?? "";
}

/** Separator candidates for a folder: its own delimiter when known, else the account's. */
function separatorsFor(path: string, folders: FolderInfo[]): string[] {
  const own = folders.find((f) => f.path === path)?.delimiter;
  const shared = sharedDelimiter(folders);
  if (own || shared) return [own ?? shared];
  return ["/", "."];
}

/**
 * True when `path` is a strict descendant of `parent`, using the child's own
 * delimiter when the listing provides one, else the shared delimiter, else
 * both common separators when the server reports none. Kept next to
 * isParentOf so the two ancestry checks cannot drift.
 */
export function isDescendantFolder(path: string, parent: string, folders: FolderInfo[]): boolean {
  const lowerPath = path.toLowerCase();
  const lowerParent = parent.toLowerCase();
  if (lowerPath === lowerParent) return false;
  return separatorsFor(path, folders).some((d) => lowerPath.startsWith(`${lowerParent}${d}`));
}

/** True when `path` is an ancestor of `other` (servers rename/delete children along). */
function isParentOf(path: string, other: string, folders: FolderInfo[]): boolean {
  return separatorsFor(other, folders).some(
    (d) => other.toLowerCase().startsWith(`${path.toLowerCase()}${d}`),
  );
}

/** Separator aliasing ("Sent/", "Clients//Sent") must fail closed, never normalize into a protected folder. */
export function rejectSeparatorTricks(path: string, folders: FolderInfo[]): void {
  const seps = [
    ...new Set([sharedDelimiter(folders), ...folders.map((f) => f.delimiter)].filter((d): d is string => Boolean(d))),
  ];
  if (seps.length === 0) seps.push("/", ".");
  for (const d of seps) {
    if (path.endsWith(d)) throw new Error(`folder path must not end with "${d}"`);
    if (path.includes(d + d)) throw new Error(`folder path must not contain doubled "${d}${d}" separators`);
  }
}

/** A folder the guard must keep intact: special-use folders plus configured/resolved overrides. */
export type ProtectedFolder = { path: string; use: string };

/**
 * Folder rename/delete guard: INBOX and protected folders (special-use, plus
 * configured/resolved Sent and Drafts) must stay intact — and so must parents
 * that contain them. Matching is case-insensitive and separator tricks are
 * rejected so the guard fails closed. Returns the normalized path.
 */
export function assertFolderManageable(
  path: string,
  folders: FolderInfo[],
  action: "rename" | "delete",
  protectedFolders: ProtectedFolder[] = [],
): string {
  const normalized = normalizeFolderPath(path);
  if (isInboxPath(normalized)) {
    throw new Error(
      `INBOX cannot be ${action}d; move its messages instead (emails_modify with move_to_folder)`,
    );
  }
  rejectSeparatorTricks(normalized, folders);
  const protectedPaths = new Map<string, string>();
  for (const f of folders) {
    if (f.specialUse) protectedPaths.set(f.path, f.specialUse);
  }
  for (const p of protectedFolders) {
    if (!protectedPaths.has(p.path)) protectedPaths.set(p.path, p.use);
  }
  for (const [protectedPath, use] of protectedPaths) {
    if (protectedPath.toLowerCase() === normalized.toLowerCase()) {
      throw new Error(
        `cannot ${action} "${protectedPath}" (${use} folder); special folders must stay`,
      );
    }
    if (isParentOf(normalized, protectedPath, folders)) {
      throw new Error(
        `cannot ${action} "${normalized}": it contains the special folder "${protectedPath}" (${use})`,
      );
    }
  }
  return normalized;
}

/** True when `path` names a protected folder exactly (create-side guard). */
export function findProtectedFolder(
  path: string,
  folders: FolderInfo[],
  protectedFolders: ProtectedFolder[] = [],
): ProtectedFolder | null {
  const normalized = normalizeFolderPath(path);
  const protectedPaths = new Map<string, string>();
  for (const f of folders) {
    if (f.specialUse) protectedPaths.set(f.path, f.specialUse);
  }
  for (const p of protectedFolders) {
    if (!protectedPaths.has(p.path)) protectedPaths.set(p.path, p.use);
  }
  for (const [protectedPath, use] of protectedPaths) {
    if (protectedPath.toLowerCase() === normalized.toLowerCase()) {
      return { path: protectedPath, use };
    }
  }
  return null;
}
