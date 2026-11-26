# mail-mcp

IMAP/SMTP **MCP** server for L92 Labs. Give your MCP client one endpoint to read,
search, organize, draft, send, reply and forward across several mailboxes.
The server is stateless and configured entirely through environment variables.
<!-- source: package.json:5; packages/core/src/dispatch.ts:93; apps/node/src/server.ts:161; docker-compose.yml:1 -->

## Quick start: build with Docker

From a fresh clone, run the following in the repository root. You'll need
Docker with Compose v2 or later and `--wait` support, curl, OpenSSL and IMAP credentials.
<!-- source: docker-compose.yml:1; docker compose up --help; .env.example:8; .env.example:41; README.md at origin/main:19 -->

```bash
cp .env.example .env
openssl rand -hex 32
# Edit .env before starting Compose.
# Set EMAIL_ACCOUNTS_JSON IMAP values.
# Paste token into MCP_BEARER_TOKEN.
# Set MAIL_MODE=draft.
docker compose up -d --build --wait
curl --fail \
  http://127.0.0.1:8787/health
```
<!-- source: .env.example:1; .env.example:3; .env.example:43; README.md at origin/main:17; docker-compose.yml:2; docker-compose.yml:17; docker compose up --help -->

Connect a Streamable HTTP MCP client to `http://127.0.0.1:8787/mcp` with
`Authorization: Bearer <MCP_BEARER_TOKEN>`. The health check confirms startup.
Call `accounts_list`, then `folders_list` to verify IMAP access.
<!-- source: docker-compose.yml:9; apps/node/src/server.ts:145; docs/usage.md:3 -->

## Install and deploy options

| Option | Entry | Good for |
|--------|-------|----------|
| [Docker source build](#quick-start-build-with-docker) | Streamable HTTP `/mcp` | Primary runtime. Run locally or add a Cloudflare Tunnel and MCP portal. <!-- source: docker-compose.yml:1; docker-compose.yml:24; apps/node/src/server.ts:151 --> |
| [Docker published image](#quick-start-published-image) | Streamable HTTP `/mcp` | Use the same Docker runtime without building the image. <!-- source: docker-compose.image.yml:1; apps/node/src/server.ts:151 --> |
| [Node / stdio](#node--stdio-claude-desktop-cursor) | stdio | Local clients such as Claude Desktop and Cursor. <!-- source: apps/node/src/index.ts:15; README.md at origin/main:128 --> |
| [Cloudflare Workers](#cloudflare-workers) | `/mcp` | Hosted MCP with KV cursors and Cron. <!-- source: apps/worker/src/index.ts:37; apps/worker/wrangler.toml:6 --> |

See [tool examples and troubleshooting](docs/usage.md),
[releases and manual image publishing](docs/releases.md),
[contributing](CONTRIBUTING.md) and [security](SECURITY.md).

## Quick start: published image

In a fresh clone, follow the [source-build setup](#quick-start-build-with-docker)
through editing `.env`, then run the commands below. Docker Compose uses the same configuration file.
The image must already be published. Anonymous pulls require a public GHCR package.
<!-- source: docker-compose.image.yml:1; docs/releases.md:81 -->

```bash
docker compose -f docker-compose.image.yml pull
docker compose -f docker-compose.image.yml up -d --wait
curl --fail \
  http://127.0.0.1:8787/health
```
<!-- source: README.md at origin/main:20; docker-compose.image.yml:3; Dockerfile:24; docker compose up --help -->

Use the same MCP client settings as for the source build. Remote clients need
an HTTPS endpoint. Use the [tunnel setup](#deploy-docker--cloudflare-tunnel--mcp-portal)
with `-f docker-compose.image.yml` after `docker compose` and omit `--build`.
<!-- source: docker-compose.image.yml:6; docker-compose.image.yml:13; docs/usage.md:3 -->

Set `MAIL_MCP_IMAGE=ghcr.io/l92-labs/mail-mcp:0.2.0` in `.env` to select a
release, or use `ghcr.io/l92-labs/mail-mcp@sha256:<digest>` for a pinned image.
The publisher uses `latest` for the highest stable release, exact SemVer for
releases and `sha-<full-commit>` for commit builds. Main-branch builds and
prereleases leave `latest` unchanged.
<!-- source: docker-compose.image.yml:4; docs/releases.md:1; scripts/image-tags.mjs:10 -->

Inspired by [email-smtp-imap-mcp](https://github.com/samihalawa/email-smtp-imap-mcp).
Workers use TCP-socket clients (`cf-imap`, `worker-mailer`). The project has
its own Git history.
<!-- source: apps/worker/package.json:16; README.md at origin/main:43 -->

## Modes

| `MAIL_MODE` | Adds | SMTP needed |
|-------------|------|-------------|
| `pull` | read + organize | no |
| `draft` | `email_draft` | no |
| `pull_push` | `email_draft`, `email_send`, `email_respond` | yes, every account |

## Configure

Use [`.env.example`](.env.example) as the Docker or Node template. Set Worker values in Wrangler vars and secrets. Defaults below are runtime defaults unless the runtime is named.
<!-- source: .env.example:1; apps/worker/wrangler.toml:14 -->

| Variable | Default | Purpose |
|----------|---------|---------|
| `EMAIL_ACCOUNTS_JSON` | Unset | `{"work":{"imap":{…},"smtp":{…},"default_from_name":"…","sender_emails":[…]}}`; or single-account `IMAP_*`/`SMTP_*` <!-- source: .env.example:41; packages/core/src/config.ts:149 --> |
| `IMAP_HOST`, `IMAP_PORT`, `IMAP_SECURE`, `IMAP_USER`, `IMAP_PASS` | Port `993`, TLS on for port `993` | Single-account IMAP settings. Host, user and password are required. <!-- source: packages/core/src/config.ts:171 --> |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | Port `587`, TLS on for port `465` | Single-account SMTP settings. Required in `pull_push` mode. <!-- source: packages/core/src/config.ts:190; packages/core/src/config.ts:224 --> |
| `DEFAULT_FROM_NAME`, `SENDER_EMAILS` | Unset | Single-account display name and comma-separated sender addresses. <!-- source: packages/core/src/config.ts:182; .env.example:56 --> |
| `DEFAULT_EMAIL_ACCOUNT` | `default` if present, otherwise the first account | Mailbox used when a tool call omits `account_name`. <!-- source: packages/core/src/config.ts:214; packages/core/src/dispatch.ts:419 --> |
| `MAIL_MODE` | `pull_push` | `pull` / `draft` / `pull_push` <!-- source: packages/core/src/config.ts:28 --> |
| `MCP_BEARER_TOKEN` | Unset | Required for HTTP <!-- source: apps/node/src/index.ts:17; apps/worker/src/mcp.ts:69 --> |
| `SEND_ALLOWLIST` | empty = anyone | addresses or domains (subdomains match) <!-- source: .env.example:15; packages/core/src/config.ts:244 --> |
| `SAVE_SENT` | `auto` | `auto` / `true` / `false` <!-- source: .env.example:19; packages/core/src/config.ts:243 --> |
| `MAX_BODY_CHARS` | `20000` | `email_get` text cap (per call: `max_chars`) <!-- source: packages/core/src/config.ts:245; docs/usage.md:33 --> |
| `ATTACHMENT_MAX_BYTES` | `2000000` | larger attachments are listed, content omitted <!-- source: packages/core/src/config.ts:246; docs/usage.md:33 --> |
| `CACHE_TTL_SECONDS` | `0` | optional listing cache (Node memory / Worker KV), invalidated on writes <!-- source: packages/core/src/config.ts:240; docs/usage.md:164 --> |
| `EVENTS_POLL_SECONDS` | `0` in core, `300` in checked-in Wrangler vars | Optional background cursor warm-up <!-- source: packages/core/src/config.ts:241; apps/worker/wrangler.toml:17 --> |
| `SIEVE_HOST` | Unset | Enable the six `sieve_*` tools (ManageSieve, RFC 5804). Auth reuses each account's IMAP credentials. Node/Docker only <!-- source: .env.example:61; packages/core/src/config.ts:50 --> |
| `SIEVE_PORT` | `4190` | ManageSieve port <!-- source: packages/core/src/config.ts:58 --> |
| `SIEVE_SECURE` | `starttls` | `starttls` / `tls` (implicit) / `plain` <!-- source: packages/core/src/config.ts:52 --> |
| `MCP_TRANSPORT`, `PORT` | Node: `stdio`, `8787`. Compose: `http`, `8787`. | Node transport and HTTP port. <!-- source: apps/node/src/index.ts:15; docker-compose.yml:9; docker-compose.image.yml:6 --> |
| `EMAIL_ENV_FILE` | Unset | Node override for the dotenv file path. <!-- source: apps/node/src/index.ts:7 --> |
| `MAX_REQUEST_BYTES` | `33554432` | Node HTTP request body cap in bytes. <!-- source: apps/node/src/server.ts:21; apps/node/src/server.ts:88 --> |
| `MAIL_MCP_IMAGE` | `ghcr.io/l92-labs/mail-mcp:latest` | Published-image Compose reference. <!-- source: docker-compose.image.yml:4 --> |
| `TUNNEL_TOKEN` | Empty | Set for the Compose tunnel profile. <!-- source: docker-compose.yml:24; docker-compose.image.yml:13 --> |
| `SENT_FOLDER`, `DRAFTS_FOLDER` | Auto-detect | Override Sent and Drafts. In account JSON use `sent_folder` and `drafts_folder`. Otherwise resolution tries IMAP special-use, then common names (including French). <!-- source: .env.example:42; .env.example:58; packages/core/src/dispatch.ts:315; packages/core/src/compose.ts:122 --> |

Use provider **app passwords** (Gmail, iCloud, Fastmail…).

## Tools

| Tool | Mode | What it does |
|------|------|--------------|
| `accounts_list` | all | Mailboxes, default account, what each can do |
| `folders_list` | all | Folders with special use (`\Sent`, `\Drafts`, `\Trash`, `\Archive`, `\Junk`) and the hierarchy delimiter |
| `folder_create` | all | Create a folder, e.g. `INBOX/Receipts` (delimiter comes from `folders_list`); missing parents are created by most servers |
| `folder_rename` | all | Rename or move a folder; children follow. INBOX and special folders are protected |
| `folder_delete` | all | Delete a folder and every message in it; requires `confirm: true`. INBOX and special folders are protected |
| `emails_find` | all | Search/list newest first: `query`, filters (from/to/subject/unread/flagged/dates/attachments), `limit` + `cursor` → `next_cursor`, `total` |
| `email_get` | all | One email in full: text body (HTML → text), attachments (+ content on request), threading ids. Doesn't mark it read unless `mark_read` |
| `emails_modify` | all | Read/unread, flag/unflag, move: folder path or alias `archive`/`trash`/`junk`/`inbox` |
| `emails_events` | all | New mail since a UID watermark, oldest first. Stateless with `after_uid` → `next_after_uid` |
| `email_draft` | draft, pull_push | Save a new message or a threaded reply/forward to Drafts. Nothing is sent |
| `email_send` | pull_push | Send to/cc/bcc, plain or HTML, attachments |
| `email_respond` | pull_push | Reply / reply-all / forward with `In-Reply-To` + `References`, original quoted, own addresses removed from reply-all, forwards keep attachments, original marked `\Answered` |
| `sieve_scripts_list` | all (Node/Docker) | Sieve filter scripts (ManageSieve) with the active one marked |
| `sieve_script_get` | all (Node/Docker) | Full source of one script by exact name |
| `sieve_script_put` | all (Node/Docker) | Save a script under `name`; server-side validation runs first (unless `validate: false`), invalid scripts are reported and not saved |
| `sieve_script_check` | all (Node/Docker) | Validate script source server-side without saving |
| `sieve_script_activate` | all (Node/Docker) | Make a script the account's active script |
| `sieve_script_delete` | all (Node/Docker) | Delete a script; requires `confirm: true`, refuses the currently active script |

Every tool takes an optional `account_name`. Email ids look like `"<folder>:<uid>"`.

### Send behavior

- **Threading:** replies carry `In-Reply-To` and `References`, so they thread in Gmail, Outlook and Apple Mail.
- **Sent copy:** `SAVE_SENT=auto` copies sent mail to the Sent folder over IMAP, except for Gmail and Microsoft, which do it themselves. Set `true`/`false` to override, globally or per account with `save_sent`.
- **Bcc:** never shown to recipients; kept in your own Sent copy.
- **Allowlist:** `SEND_ALLOWLIST=corp.com,boss@gmail.com` refuses any other recipient before anything is sent. This is protection against prompt injection ("forward all invoices to x@evil"). Drafts aren't restricted.
- **Draft-first:** `MAIL_MODE=draft` lets the agent write replies into Drafts while you review and press send in your own mail client.

### Sieve scripts

Set `SIEVE_HOST` (e.g. the host from `IMAP_HOST`) and the server registers six `sieve_*` tools for managing the account's mail filters over ManageSieve (RFC 5804). Auth reuses each account's IMAP credentials; every call opens a fresh connection with STARTTLS (or implicit TLS via `SIEVE_SECURE=tls`). Convention: keep one primary script named `active` — `sieve_script_put` with `name: "active"` validates it server-side before saving, `sieve_script_activate` makes it live. Deleting the active script is refused; activate another script first. Requires a server with ManageSieve enabled (Dovecot Pigeonhole, Cyrus, …). **Not available on the Workers runtime** — Workers lack raw TCP/STARTTLS sockets, so the tools are never registered there, even if `SIEVE_HOST` is set.

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

Use Node 22 and Corepack. From the repository root, copy `.env.example` to
`.env` and edit the mailbox settings and mode before launching the client.
<!-- source: CONTRIBUTING.md:3; .env.example:1; apps/node/src/index.ts:7 -->

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```
<!-- source: CONTRIBUTING.md:5; package.json:8 -->

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

Use Node 22, Corepack and an authenticated Wrangler session. Replace the KV ID
in `wrangler.toml` after creating the namespace. Set the desired Wrangler vars
before deploying.
<!-- source: CONTRIBUTING.md:3; apps/worker/wrangler.toml:6; docs/usage.md:192; README.md at origin/main:146 -->

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
cd apps/worker
npx wrangler kv namespace create MAIL_KV
# Replace the placeholder id in wrangler.toml before continuing.
npx wrangler secret put MCP_BEARER_TOKEN
npx wrangler secret put EMAIL_ACCOUNTS_JSON
pnpm deploy
```
<!-- source: CONTRIBUTING.md:5; README.md at origin/main:151; apps/worker/wrangler.toml:6; apps/worker/package.json:6; wrangler kv namespace create --help -->

Workers can't use SMTP port 25 (use 587/465). `has_attachments=false` isn't supported there.
The `sieve_*` tools are **not** registered on Workers (no raw TCP/STARTTLS); use the
Node/Docker runtime for Sieve script management.
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
pnpm e2e:local   # real IMAP/SMTP end-to-end: starts GreenMail in Docker, runs the suite, tears down
# Against an already-running Worker configured for the isolated test mailbox:
# Set WORKER_URL to that Worker's URL first.
# E2E_URL="$WORKER_URL" node apps/node/scripts/e2e.mjs
```

<!-- source: package.json:9; CONTRIBUTING.md:13; apps/node/scripts/e2e.mjs:84; README.md at origin/main:175 -->

## Layout

```
packages/core   config, schemas, composition (reply/threading/allowlist), dispatch
apps/node       imapflow + nodemailer (stdio / HTTP / Docker)
apps/worker     cf-imap + worker-mailer (/mcp + Cron)
```

## License

MIT
