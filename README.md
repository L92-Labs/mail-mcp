# mail-mcp

IMAP/SMTP **MCP** server for L92 Labs. Read, search, organize, draft, send, reply and forward
across several mailboxes from one MCP endpoint. Stateless, configured entirely by env vars.

Start here: [Docker quick start](#quick-start-published-image),
[tool examples and troubleshooting](docs/usage.md),
[releases and manual image publishing](docs/releases.md),
[contributing](CONTRIBUTING.md), [security](SECURITY.md).

## Quick start: published image

Requires Docker Compose v2. Images become available after the first successful
publish; public anonymous pulls require the GHCR package to be made public.

```bash
cp .env.example .env
# Edit .env: real mail settings + strong MCP_BEARER_TOKEN; start with MAIL_MODE=draft.
# Generate a bearer token: openssl rand -hex 32
docker compose -f docker-compose.image.yml pull
docker compose -f docker-compose.image.yml up -d
curl --fail http://127.0.0.1:8787/health
```

Connect a Streamable HTTP MCP client to `http://127.0.0.1:8787/mcp` with
`Authorization: Bearer <your-token>`. Remote clients need an HTTPS endpoint;
use the tunnel recipe below with `-f docker-compose.image.yml`.
`/health` checks server/config availability, not mailbox connectivity; call
`accounts_list`, then `folders_list` to verify IMAP access.

Set `MAIL_MCP_IMAGE=ghcr.io/l92-labs/mail-mcp:0.2.0` in `.env` to select a
release, or use `ghcr.io/l92-labs/mail-mcp@sha256:<digest>` for a pinned image.
Available tags: stable `latest`, exact SemVer, and `sha-<full-commit>`.
Main-branch builds never move `latest`; prereleases never move it either.
To build locally before images are published, use the original
`docker compose up -d --build` recipe.

| Runtime | Entry | Good for |
|---------|--------|----------|
| **Node / Docker** (primary) | Streamable HTTP `/mcp` or stdio | Any server, behind Cloudflare Tunnel + MCP portal |
| **Cloudflare Worker** | `/mcp` | Hosted remote MCP, KV cursors, Cron |

Inspired by [email-smtp-imap-mcp](https://github.com/samihalawa/email-smtp-imap-mcp). Not a git fork; Workers need TCP-socket clients (`cf-imap`, `worker-mailer`).

## Tools

| Tool | Mode | What it does |
|------|------|--------------|
| `accounts_list` | all | Mailboxes, default account, what each can do |
| `folders_list` | all | Folders with special use (`\Sent`, `\Drafts`, `\Trash`, `\Archive`, `\Junk`) |
| `emails_find` | all | Search/list newest first: `query`, filters (from/to/subject/unread/flagged/dates/attachments), `limit` + `cursor` → `next_cursor`, `total` |
| `email_get` | all | One email in full: text body (HTML → text), attachments (+ content on request), threading ids. Doesn't mark it read unless `mark_read` |
| `emails_modify` | all | Read/unread, flag/unflag, move: folder path or alias `archive`/`trash`/`junk`/`inbox` |
| `emails_events` | all | New mail since a UID watermark, oldest first. Stateless with `after_uid` → `next_after_uid` |
| `email_draft` | draft, pull_push | Save a new message or a threaded reply/forward to Drafts. Nothing is sent |
| `email_send` | pull_push | Send to/cc/bcc, plain or HTML, attachments |
| `email_respond` | pull_push | Reply / reply-all / forward with `In-Reply-To` + `References`, original quoted, own addresses removed from reply-all, forwards keep attachments, original marked `\Answered` |

Every tool takes an optional `account_name`. Email ids look like `"<folder>:<uid>"`.

### Send behavior

- **Threading:** replies carry `In-Reply-To` and `References`, so they thread in Gmail, Outlook and Apple Mail.
- **Sent copy:** `SAVE_SENT=auto` copies sent mail to the Sent folder over IMAP, except for Gmail and Microsoft, which do it themselves. Set `true`/`false` to override, globally or per account with `save_sent`.
- **Bcc:** never shown to recipients; kept in your own Sent copy.
- **Allowlist:** `SEND_ALLOWLIST=corp.com,boss@gmail.com` refuses any other recipient before anything is sent. This is protection against prompt injection ("forward all invoices to x@evil"). Drafts aren't restricted.
- **Draft-first:** `MAIL_MODE=draft` lets the agent write replies into Drafts while you review and press send in your own mail client.

## Modes

| `MAIL_MODE` | Adds | SMTP needed |
|-------------|------|-------------|
| `pull` | read + organize | no |
| `draft` | `email_draft` | no |
| `pull_push` | `email_draft`, `email_send`, `email_respond` | yes, every account |

## Configure

Copy [`.env.example`](.env.example) → `.env`. Main variables:

| Var | Default | |
|-----|---------|--|
| `EMAIL_ACCOUNTS_JSON` | — | `{"work":{"imap":{…},"smtp":{…},"default_from_name":"…","sender_emails":[…]}}`; or single-account `IMAP_*`/`SMTP_*` |
| `DEFAULT_EMAIL_ACCOUNT` | `default` / first | |
| `MAIL_MODE` | `pull_push` | `pull` / `draft` / `pull_push` |
| `MCP_BEARER_TOKEN` | — | Required for HTTP |
| `SEND_ALLOWLIST` | empty = anyone | addresses or domains (subdomains match) |
| `SAVE_SENT` | `auto` | `auto` / `true` / `false` |
| `MAX_BODY_CHARS` | `20000` | `email_get` text cap (per call: `max_chars`) |
| `ATTACHMENT_MAX_BYTES` | `2000000` | larger attachments are listed, content omitted |
| `CACHE_TTL_SECONDS` | `0` | optional listing cache (Node memory / Worker KV), invalidated on writes |
| `EVENTS_POLL_SECONDS` | `0` | optional background cursor warm-up |

Per-account folder overrides: `sent_folder`, `drafts_folder` (or `SENT_FOLDER`/`DRAFTS_FOLDER`). Otherwise they're resolved through IMAP special-use, then common names (incl. French).

Use provider **app passwords** (Gmail, iCloud, Fastmail…).

## Deploy: Docker + Cloudflare Tunnel + MCP portal

```
MCP portal --(Authorization: Bearer)--> Cloudflare Tunnel --> mail-mcp:8787/mcp
```

1. `cp .env.example .env`, then fill in accounts, `MAIL_MODE`, a long random `MCP_BEARER_TOKEN`, and `TUNNEL_TOKEN`.
2. Zero Trust → Networks → Tunnels: create a tunnel, add the public hostname `mail-mcp.<your-domain>` → service `http://mail-mcp:8787`.
3. `docker compose --profile tunnel up -d --build`
4. MCP portal: add server `https://mail-mcp.<your-domain>/mcp` with header `Authorization: Bearer <MCP_BEARER_TOKEN>`.
5. Optional: if your portal setup supports it, add a Cloudflare Access policy on the hostname as a second gate.

Without the tunnel profile, MCP listens on `127.0.0.1:8787` only. The container is read-only, runs as non-root, has a `/health` healthcheck, and uses no volumes.

## Node / stdio (Claude Desktop, Cursor)

```bash
pnpm install && pnpm build
```

```json
{
  "mcpServers": {
    "mail": {
      "command": "node",
      "args": ["/absolute/path/to/mail-mcp/apps/node/dist/index.js"],
      "env": { "EMAIL_ENV_FILE": "/absolute/path/to/mail-mcp/.env", "MCP_TRANSPORT": "stdio" }
    }
  }
}
```

## Cloudflare Workers

```bash
pnpm install && pnpm build
cd apps/worker
npx wrangler kv namespace create MAIL_KV     # put the id in wrangler.toml
npx wrangler secret put MCP_BEARER_TOKEN
npx wrangler secret put EMAIL_ACCOUNTS_JSON
pnpm deploy
```

Workers can't use SMTP port 25 (use 587/465). `has_attachments=false` isn't supported there.
Node/Docker is the primary deployment. Worker outbound TCP can also be blocked by
provider/network restrictions; test your actual IMAP/SMTP hosts before choosing it.
Set `MAIL_MODE=draft` and `EVENTS_POLL_SECONDS=0` in Wrangler vars for an initial
draft-only deployment. Cron is configured separately in `wrangler.toml`.

Events are polled with `emails_events`, not delivered through live MCP
notifications. Keep your own `after_uid` cursor for reliable independent consumers;
see [event semantics](docs/usage.md#events-and-cache).

## Test

```bash
pnpm test        # unit tests
pnpm typecheck
# real IMAP/SMTP end-to-end (GreenMail in Docker; see header of apps/node/scripts/e2e.mjs)
pnpm e2e
# same suite against the Worker: E2E_URL=http://127.0.0.1:8798 node apps/node/scripts/e2e.mjs
```

## Layout

```
packages/core   config, schemas, composition (reply/threading/allowlist), dispatch
apps/node       imapflow + nodemailer (stdio / HTTP / Docker)
apps/worker     cf-imap + worker-mailer (/mcp + Cron)
```

## License

MIT
