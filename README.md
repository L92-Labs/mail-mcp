# mail-mcp

IMAP/SMTP **MCP** server for L92 Labs. Give your MCP client one endpoint to read,
search, organize, draft, send, reply and forward across several mailboxes.
The server is stateless and configured entirely through environment variables.
<!-- source: package.json:5; packages/core/src/dispatch.ts:93; apps/node/src/server.ts:161; docker-compose.yml:1 -->

## Quick start: build with Docker

From a fresh clone, run the following in the repository root. You'll need
Docker with Compose v2 or later and `--wait` support, a Docker builder that
supports `HEALTHCHECK --start-interval`, curl, OpenSSL and IMAP credentials.
<!-- source: Dockerfile:24; docker-compose.yml:1; docker compose up --help; .env.example:8; .env.example:41; README.md at origin/main:19 -->

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
and follow the published-image command and public readiness check in that section.
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
| `MAX_REQUEST_BYTES` | `33554432` | Node HTTP request body cap in bytes. Set it in the process environment before launching Node, or in the Compose `.env` file for container injection. Node reads it before its dotenv loader runs. <!-- source: apps/node/src/server.ts:21; apps/node/src/index.ts:5; docker-compose.yml:7; docker-compose.image.yml:5 --> |
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
| `email_respond` | pull_push | Reply / reply-all / forward with `In-Reply-To` + `References`, original quoted by default, own addresses removed from reply-all. Forwards include original attachments by default (set `include_attachments=false` to omit them). After a reply is sent, the server attempts to mark the original `\Answered` and returns a warning if that fails. <!-- source: packages/core/src/compose.ts:315; packages/core/src/compose.ts:386; packages/core/src/dispatch.ts:910 --> |
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
- **Bcc:** hidden from recipients. A Sent copy saved by the server includes Bcc addresses. The save policy can skip the copy, and a failed append returns a warning. <!-- source: apps/node/src/backend.ts:216; apps/worker/src/backend.ts:26; apps/worker/src/backend.ts:202; packages/core/src/compose.ts:102; packages/core/src/dispatch.ts:371 -->
- **Allowlist:** `SEND_ALLOWLIST=corp.com,boss@gmail.com` refuses any other recipient before anything is sent. This is protection against prompt injection ("forward all invoices to x@evil"). Drafts aren't restricted.
- **Draft-first:** `MAIL_MODE=draft` lets the agent write replies into Drafts while you review and press send in your own mail client.

### Sieve scripts

Set `SIEVE_HOST` (e.g. the host from `IMAP_HOST`) and the server registers six `sieve_*` tools for managing the account's mail filters over ManageSieve (RFC 5804). Auth reuses each account's IMAP credentials. Each call opens a fresh connection using STARTTLS by default. Set `SIEVE_SECURE=tls` for implicit TLS or `SIEVE_SECURE=plain` for an unencrypted connection. By convention, keep one primary script named `active`. `sieve_script_put` with `name: "active"` validates it server-side before saving, `sieve_script_activate` makes it live. Deleting the active script is refused; activate another script first. Requires a server with ManageSieve enabled (Dovecot Pigeonhole, Cyrus, …). The Node/Docker runtime provides these tools.
<!-- source: packages/core/src/config.ts:49; apps/node/src/managesieve-client.ts:109; apps/worker/src/mcp.ts:21 -->

## Deploy: Docker + Cloudflare Tunnel + MCP portal

```
MCP portal --(Authorization: Bearer)--> Cloudflare Tunnel --> mail-mcp:8787/mcp
```

1. Follow the [Docker setup](#quick-start-build-with-docker) through editing `.env`.
2. In Zero Trust, go to Networks → Tunnels and create a tunnel. Route a public hostname
   such as `mail-mcp.example.com` to `http://mail-mcp:8787`. Set `TUNNEL_TOKEN` in `.env`.
3. Start the source build from the repo root, or use the published-image command
   if you have a published image.

   ```bash
   docker compose --profile tunnel up -d --build
   ```

   ```bash
   docker compose -f docker-compose.image.yml --profile tunnel up -d
   ```

4. For either variant, replace the example hostname with your public hostname and
   run the check below. Repeat until it returns HTTP 200 and the health JSON shows
   `"ok":true`.

   ```bash
   curl --fail --show-error --include 'https://mail-mcp.example.com/health'
   ```

5. Add the same public HTTPS hostname with path `/mcp` in your MCP portal. Set the
   `Authorization` header to `Bearer` followed by your configured token.
6. Optional: if your portal setup supports it, add a Cloudflare Access policy on the hostname as a second gate.

<!-- source: docker-compose.yml:24; docker-compose.image.yml:13; apps/node/src/server.ts:145; apps/node/src/server.ts:157 -->

Compose publishes the MCP port on the host's loopback address, `127.0.0.1:8787`.
The container listener is reachable on the Compose network, which the tunnel uses.
The container is read-only, runs as non-root, has a `/health` healthcheck, and uses no volumes.
<!-- source: docker-compose.yml:12; docker-compose.image.yml:9; Dockerfile:22; apps/node/src/server.ts:115 -->

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
in `wrangler.toml` after creating the namespace. Before setting secrets or deploying,
update the Wrangler vars to match your accounts and mode. The checked-in
`DEFAULT_EMAIL_ACCOUNT = "default"` requires an account named `default`. If your
account JSON uses `work` as in the configuration example, set the var to `"work"`
or remove it to let the runtime choose.
<!-- source: CONTRIBUTING.md:3; apps/worker/wrangler.toml:6; apps/worker/wrangler.toml:18; packages/core/src/config.ts:214 -->

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
cd apps/worker
npx wrangler kv namespace create MAIL_KV
# Replace the placeholder id and update the vars in wrangler.toml before continuing.
npx wrangler secret put MCP_BEARER_TOKEN
npx wrangler secret put EMAIL_ACCOUNTS_JSON
pnpm run deploy
```
<!-- source: CONTRIBUTING.md:5; README.md at origin/main:151; apps/worker/wrangler.toml:6; apps/worker/package.json:8; pnpm run --help; wrangler kv namespace create --help -->

Workers can't use SMTP port 25 (use 587/465). `has_attachments=false` isn't supported there.
Worker SMTP requests STARTTLS when implicit TLS is off and the port is other than
465. The Worker omits the `sieve_*` tools. Use Node/Docker with ManageSieve configured.
<!-- source: apps/worker/src/backend.ts:376; apps/worker/src/mcp.ts:21; packages/core/src/config.ts:49 -->
Node/Docker is the primary deployment. Worker outbound TCP can also be blocked by
provider/network restrictions; test your actual IMAP/SMTP hosts before choosing it.
Set `MAIL_MODE=draft` and `EVENTS_POLL_SECONDS=0` in Wrangler vars for an initial
draft-only deployment. Cron is configured separately in `wrangler.toml`.

Events are polled with `emails_events`, not delivered through live MCP
notifications. Keep your own `after_uid` cursor for reliable independent consumers;
see [event semantics](docs/usage.md#events-and-cache).

## Test

From a fresh clone, use Node 22 and Corepack. The local E2E suite also needs
Bash, a running Docker daemon, and free ports (defaults: IMAP `13143`, SMTP
`13025`, MCP `8797`). Run these from the repo root.
<!-- source: CONTRIBUTING.md:3; scripts/e2e.sh:11; scripts/e2e.sh:35 -->

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test        # unit tests
pnpm typecheck
pnpm e2e:local   # starts isolated GreenMail, runs the suite, then tears it down
```
<!-- source: CONTRIBUTING.md:5; scripts/e2e.sh:26 -->

For custom targets, see the [E2E runner](apps/node/scripts/e2e.mjs).
`E2E_URL` changes only the MCP target. The runner first connects to two local
GreenMail accounts and expects the target to use matching test settings and the
runner's fixed test bearer token. Use isolated test mailboxes for this suite.
<!-- source: CONTRIBUTING.md:13; apps/node/scripts/e2e.mjs:16; apps/node/scripts/e2e.mjs:63; apps/node/scripts/e2e.mjs:77; apps/node/scripts/e2e.mjs:110 -->

## Layout

```
packages/core   config, schemas, composition (reply/threading/allowlist), dispatch
apps/node       imapflow + nodemailer (stdio / HTTP / Docker)
apps/worker     cf-imap + worker-mailer (/mcp + Cron)
```

## License

MIT
