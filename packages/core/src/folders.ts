import type { FolderInfo } from "./types.js";

/** INBOX is case-insensitive per RFC 3501; other folder names are not. */
export function isInboxPath(path: string): boolean {
  return path.trim().toUpperCase() === "INBOX";
}

export function normalizeFolderPath(value: string): string {
  const path = value.trim();
  if (!path) throw new Error("folder path is empty");
  return path;
}

function delimiterFor(folders: FolderInfo[]): string {
  return folders.find((f) => f.delimiter)?.delimiter ?? "";
}

/** True when `path` is an ancestor of `other` (servers rename/delete children along). */
function isParentOf(path: string, other: string, delimiter: string): boolean {
  const seps = delimiter ? [delimiter] : ["/", "."];
  return seps.some((d) => other.toLowerCase().startsWith(`${path.toLowerCase()}${d}`));
}

/**
 * Folder create/rename/delete guard: INBOX and special-use folders
 * (\\Sent, \\Drafts, \\Trash, \\Archive, \\Junk, ...) must stay intact,
 * and so must parents that contain them. Returns the normalized path.
 */
export function assertFolderManageable(
  path: string,
  folders: FolderInfo[],
  action: "rename" | "delete",
): string {
  const normalized = normalizeFolderPath(path);
  if (isInboxPath(normalized)) {
    throw new Error(
      `INBOX cannot be ${action}d; move its messages instead (emails_modify with move_to_folder)`,
    );
  }
  const special = folders.filter((f) => f.specialUse);
  const hit = special.find(
    (f) => f.path === normalized || isParentOf(normalized, f.path, delimiterFor(folders)),
  );
  if (hit) {
    if (hit.path === normalized) {
      throw new Error(
        `cannot ${action} "${hit.path}" (${hit.specialUse} folder); special folders must stay`,
      );
    }
    throw new Error(
      `cannot ${action} "${normalized}": it contains the special folder "${hit.path}" (${hit.specialUse})`,
    );
  }
  return normalized;
}
