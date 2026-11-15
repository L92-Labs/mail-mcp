# Changelog

## 0.4.0 — 2026-11-15

- Sieve filter script management (RFC 5804 ManageSieve): six `sieve_*` tools —
  `sieve_scripts_list`, `sieve_script_get`, `sieve_script_put`,
  `sieve_script_check`, `sieve_script_activate`, `sieve_script_delete` — gated
  on `SIEVE_HOST` (with `SIEVE_PORT` / `SIEVE_SECURE`). Auth reuses each
  account's IMAP credentials over STARTTLS (or implicit TLS / plaintext via
  `SIEVE_SECURE`). Server-side validation (CHECKSCRIPT) runs before saving;
  the server's WARNINGS response code is surfaced; deleting the active script
  is refused. Node/Docker runtime only — the tools never register on Workers.
- Wire-protocol correctness, verified against RFC 5804 and a live Dovecot
  Pigeonhole server and pinned by an in-process fake ManageSieve server:
  greeting capability parsing without the CAPABILITY token (§1.7), STARTTLS
  command ordering with post-handshake capability-greeting replacement (§2.2),
  non-synchronised `{N+}` literal arguments for PUTSCRIPT/CHECKSCRIPT (§2.6),
  synchronised `{N}` literal decoding for GETSCRIPT content and LISTSCRIPTS
  names — including names that themselves start with OK/NO/BYE or contain the
  ACTIVE marker (§2.7/§2.9), tagged messages delivered as trailing literals
  (§2.8/§2.12), quoted-string forms, NO/BYE detection with response codes,
  SNI for DNS hosts (omitted for IP literals per RFC 6066), control-character
  rejection at the tool boundary, and socket hygiene (destroy on refused
  STARTTLS/AUTHENTICATE, 20s inactivity timeout, bounded handshake).

## 0.3.1 — 2026-11-15

- Fixed phantom moves: `emails_modify` now validates move targets against
  the server and refuses non-existent folders before any backend call.
- Fixed malformed-id batch failures: both `findEmails` backends skip
  uid-less messages (expunge races no longer emit `INBOX:undefined` ids),
  and `emails_modify` skips malformed ids per-id — the rest of the batch
  still applies; all-malformed batches surface an explicit error instead
  of a silent success-shaped no-op.
- Flag-only `emails_modify` batches skip the folder-listing roundtrip.
- Move targets: exact listed paths win verbatim (whitespace names
  preserved); INBOX destinations always exist regardless of the listing's
  INBOX spelling.

## 0.3.0 — 2026-11-14

- Full folder management: `folder_create`, `folder_rename` and `folder_delete`
  work on both runtimes (Node/imapflow and Workers/cf-imap).
- `folder_delete` requires `confirm: true`; INBOX, special-use folders and
  parents containing them are always refused.
- Hardened guards (review findings): folder paths with control characters are
  rejected before any IMAP command is built; separator aliasing (trailing and
  doubled delimiters) fails closed; rename destinations are guarded like
  sources; INBOX and special folders cannot be created either; configured
  `sent_folder`/`drafts_folder` and name-resolved specials are protected even
  when the server omits special-use attributes.
- `folders_list` cache is invalidated by folder mutations (generation now part
  of the cache key), and `folders_list` reports each folder's hierarchy
  delimiter for building nested paths.
- Duplicate `folder_create` returns `created: false` consistently on both
  runtimes (ALREADYEXISTS / "already exists" detection).
- Review round 3: folder paths with surrounding whitespace are refused (exact
  mailbox names are never silently trimmed); create-side separator aliasing is
  refused like rename/delete; the event poll cursor is reset when a folder is
  created so recreated folders don't lose events; cache invalidation is
  collision-safe (random generation) and best-effort (a failed cache write
  never masks a successful mutation); the Workers delete unsubscribes only
  after a successful DELETE; Node create probes existence when imapflow's
  internal SUBSCRIBE fails after a successful CREATE.
- `pnpm e2e:local` reproduces the CI GreenMail e2e suite locally with one
  command (container lifecycle, readiness wait, teardown, port overrides).

## 0.2.0 — 2026-10-19

- Read, search, paginate and organize mail across multiple IMAP accounts.
- Read messages and attachments without marking them read by default.
- Save drafts, send new mail, and reply/forward with threading and Sent copies.
- Restrict sending with recipient allowlists and draft-only mode.
- Poll new mail using explicit UID cursors; optional listing cache.
- Run through Node/stdio, Docker/HTTP, or Cloudflare Workers.
- Fix replies to note-to-self threads and preserve explicit recipients.
- Add tested multi-architecture GHCR publishing, SHA/SemVer/stable tags, and a
  manual publishing fallback for Actions outages or billing failures.
- Document setup, tools, operations, security, contributions and releases.

Initial public release. `emails_events` uses polling; live MCP notifications and
OAuth authorization are not implemented.
