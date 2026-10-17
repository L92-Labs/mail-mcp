# mail-mcp

## Plan

- [x] Create L92-Labs/mail-mcp layout + GitHub repo
- [x] `packages/core` — config, mode, cache, events, tool dispatch
- [x] `apps/node` — imapflow/nodemailer, stdio + HTTP, Docker
- [x] `apps/worker` — cf-imap/worker-mailer, KV, Cron, `/mcp`
- [x] Tests + README; deploy-ready handoff

## Review

- 10 unit tests passing (`pnpm test`)
- `@mail-mcp/core` + `@mail-mcp/node` build clean; worker `tsc --noEmit` clean
- cf-bootstrap plan skipped (existing custom scaffold); Worker uses `wrangler.toml` + KV binding
- Ready for user IMAP/SMTP secrets + Docker or `wrangler deploy`
