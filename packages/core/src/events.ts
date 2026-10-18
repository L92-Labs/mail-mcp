import type { CursorStore, EmailAccount, EmailMessage, MailBackend } from "./types.js";

export function eventCursorKey(accountName: string, folder: string): string {
  return `events:uid:${accountName}:${folder}`;
}

export async function pollNewMessages(opts: {
  backend: MailBackend;
  account: EmailAccount;
  folder: string;
  cursors: CursorStore;
  limit: number;
  advance: boolean;
}): Promise<{
  messages: EmailMessage[];
  cursor: number;
  advanced: boolean;
  seeded: boolean;
  hasMore: boolean;
}> {
  const { backend, account, folder, cursors, limit, advance } = opts;
  const key = eventCursorKey(account.name, folder);
  const raw = await cursors.get(key);
  const stored = raw === null ? NaN : Number(raw);

  if (!Number.isFinite(stored) || stored < 0) {
    // First run: seed at the current high-water mark so we don't dump the inbox.
    const high = await backend.getHighestUid(account, folder);
    if (advance) await cursors.set(key, String(high));
    return { messages: [], cursor: high, advanced: advance, seeded: true, hasMore: false };
  }

  const { messages, hasMore } = await backend.listNewSince(account, folder, stored, limit);
  const cursor = messages.reduce((m, e) => Math.max(m, e.uid), stored);
  const advanced = advance && cursor > stored;
  if (advanced) await cursors.set(key, String(cursor));
  return { messages, cursor: advance ? cursor : stored, advanced, seeded: false, hasMore };
}

export async function warmEventCursors(opts: {
  backend: MailBackend;
  accounts: EmailAccount[];
  folder: string;
  cursors: CursorStore;
  limit: number;
}): Promise<Array<{ account: string; newCount: number; cursor: number }>> {
  const out: Array<{ account: string; newCount: number; cursor: number }> = [];
  for (const account of opts.accounts) {
    const result = await pollNewMessages({
      backend: opts.backend,
      account,
      folder: opts.folder,
      cursors: opts.cursors,
      limit: opts.limit,
      advance: true,
    });
    out.push({
      account: account.name,
      newCount: result.messages.length,
      cursor: result.cursor,
    });
  }
  return out;
}

export function memoryCursorStore(): CursorStore {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
  };
}
