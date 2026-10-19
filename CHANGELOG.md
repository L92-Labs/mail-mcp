# Changelog

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
