# mail-mcp

## v0.1 (initial)

- [x] Dual runtime (Node/Docker + Worker), pull / pull_push, cache, poll events

## v0.2 — actionable email MCP

- [x] `emails_find` cursor pagination (`cursor` → `next_cursor`, `total`), light summaries (envelope + partial source)
- [x] `email_get` full read: text (HTML→text), attachments (+content cap), threading ids, `max_chars`, opt-in `mark_read`
- [x] `emails_events` stateless `after_uid` → `next_after_uid`; oldest-first, no skipped mail
- [x] Reply threading (`In-Reply-To`/`References`), self removed from reply-all, forward keeps attachments, `\Answered`
- [x] Sent copy (`SAVE_SENT=auto|true|false`), Drafts (`email_draft`, `MAIL_MODE=draft`)
- [x] `SEND_ALLOWLIST`, typed + described tool schemas, MCP annotations
- [x] Move aliases (archive/trash/junk/inbox) via special-use
- [x] Docker: loopback port, healthcheck, read-only, non-root, cloudflared profile; README portal recipe
- [x] Fixes: Worker Bcc header leak, Worker named recipients dropped, Worker UIDNEXT key, events skipping mail

## Review

- `pnpm test` 36 unit tests; `pnpm typecheck` clean
- `apps/node/scripts/e2e.mjs` vs GreenMail: 26/26 on Node, Docker container, and `wrangler dev` Worker
