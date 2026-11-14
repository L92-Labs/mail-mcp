# Changelog

## Unreleased

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
