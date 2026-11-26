# mail-mcp

IMAP/SMTP **MCP** server for L92 Labs. Give your MCP client one endpoint to read,
search, organize, draft, send, reply and forward across several mailboxes.
Mail stays on the mail server. Node and Docker use environment variables for configuration. Workers also use Wrangler bindings and triggers.
<!-- source: package.json:5; packages/core/src/dispatch.ts:93; apps/node/src/server.ts:163; docs/usage.md:157; docs/usage.md:181; apps/worker/wrangler.toml:6 -->

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
# For Compose, single-quote the entire JSON value to preserve literal dollar signs.
# Paste token into MCP_BEARER_TOKEN.
# Set MAIL_MODE=draft.
docker compose up -d --build --wait
curl --fail \
  http://127.0.0.1:8787/health
```
<!-- source: .env.example:1; .env.example:3; .env.example:43; README.md at origin/main:17; docker-compose.yml:7; docker-compose.image.yml:5; docker compose up --help; https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/#env-file-syntax -->

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
through editing `.env`, then run the commands below. Both Compose recipes load the same `.env` file.
The image must already be published. Anonymous pulls require a public GHCR package.
<!-- source: docker-compose.yml:7; docker-compose.image.yml:5; docs/releases.md:81 -->

```bash
docker compose -f docker-compose.image.yml pull
docker compose -f docker-compose.image.yml up -d --wait
curl --fail \
  http://127.0.0.1:8787/health
```
<!-- source: README.md at origin/main:20; docker-compose.image.yml:3; Dockerfile:24; docker compose up --help -->

Use the same MCP client settings as for the source build. For remote clients, use
an HTTPS endpoint. Use the [tunnel setup](#deploy-docker--cloudflare-tunnel--mcp-portal)
and follow the published-image command and public readiness check in that section.
<!-- source: docker-compose.image.yml:6; docker-compose.image.yml:13; docs/usage.md:3; SECURITY.md:7 -->

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

<!-- source: packages/core/src/schemas.ts:286; packages/core/src/config.ts:224; packages/core/src/dispatch.ts:244 -->

## Configure

Use [`.env.example`](.env.example) as the Docker or Node template. Set Worker values in Wrangler vars and secrets. Defaults below are runtime defaults unless the runtime is named.
<!-- source: .env.example:1; apps/worker/wrangler.toml:14 -->

| Variable | Default | Purpose |
|----------|---------|---------|
| `EMAIL_ACCOUNTS_JSON` | Unset | `{"work":{"imap":{…},"smtp":{…},"default_from_name":"…","sender_emails":[…]}}`; or single-account `IMAP_*`/`SMTP_*` <!-- source: .env.example:41; packages/core/src/config.ts:149 --> |
| `IMAP_HOST`, `IMAP_PORT`, `IMAP_SECURE`, `IMAP_USER`, `IMAP_PASS` | Port `993`, implicit TLS on by default for port `993` | Single-account IMAP settings. Host, user and password are required. <!-- source: packages/core/src/config.ts:171 --> |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | Port `587`, implicit TLS on by default for port `465` | Single-account SMTP settings. Required in `pull_push` mode. <!-- source: packages/core/src/config.ts:190; packages/core/src/config.ts:224 --> |
| `DEFAULT_FROM_NAME`, `SENDER_EMAILS` | Unset | Single-account display name and comma-separated sender addresses. <!-- source: packages/core/src/config.ts:182; .env.example:56 --> |
| `DEFAULT_EMAIL_ACCOUNT` | `default` if present, otherwise the first account | Mailbox used when a tool call omits `account_name`. <!-- source: packages/core/src/config.ts:214; packages/core/src/dispatch.ts:419 --> |
| `MAIL_MODE` | `pull_push` | `pull` / `draft` / `pull_push` <!-- source: packages/core/src/config.ts:28 --> |
| `MCP_BEARER_TOKEN` | Unset | Required for HTTP <!-- source: apps/node/src/index.ts:17; apps/worker/src/mcp.ts:69 --> |
| `SEND_ALLOWLIST` | empty = anyone | addresses or domains (subdomains match) <!-- source: .env.example:15; packages/core/src/config.ts:244 --> |
| `SAVE_SENT` | `auto` | `auto` / `true` / `false` <!-- source: .env.example:19; packages/core/src/config.ts:243 --> |
| `MAX_BODY_CHARS` | `20000` | `email_get` text cap (per call: `max_chars`) <!-- source: packages/core/src/config.ts:245; docs/usage.md:33 --> |
| `ATTACHMENT_MAX_BYTES` | `2000000` | larger attachments are listed, content omitted <!-- source: packages/core/src/config.ts:246; docs/usage.md:33 --> |
| `CACHE_TTL_SECONDS` | `0` | optional listing cache (Node memory / Worker KV), listing invalidation after mail and folder writes is best effort <!-- source: packages/core/src/config.ts:240; packages/core/src/dispatch.ts:251; docs/usage.md:164 --> |
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

Use a provider **app password** where available. The server uses the configured IMAP and SMTP usernames and passwords.
<!-- source: SECURITY.md:7; packages/core/src/config.ts:171 -->

## Tools

| Tool | Mode | What it does |
|------|------|--------------|
| `accounts_list` | all | Mailboxes, default account, what each can do |
| `folders_list` | all | Folders with special use (`\Sent`, `\Drafts`, `\Trash`, `\Archive`, `\Junk`) and the hierarchy delimiter |
| `folder_create` | all | Create a folder, e.g. `INBOX/Receipts` (delimiter comes from `folders_list`). Create missing parents explicitly if your server requires it. <!-- source: apps/node/src/backend.ts:427; apps/worker/src/backend.ts:420 --> |
| `folder_rename` | all | Rename or move a folder; children follow. INBOX and special folders are protected |
| `folder_delete` | all | Delete a folder and every message in it; requires `confirm: true`. INBOX and special folders are protected |
| `emails_find` | all | Search/list in descending UID order: `query`, filters (from/to/subject/unread/flagged/dates/attachments), `limit` + `cursor` → `next_cursor`, `total` <!-- source: packages/core/src/dispatch.ts:588; apps/node/src/backend.ts:269; apps/worker/src/backend.ts:300 --> |
| `email_get` | all | One email with capped text (HTML converted to text when needed), attachment metadata and threading IDs. Request HTML or attachment content separately. Set `mark_read` to mark it read. <!-- source: packages/core/src/dispatch.ts:646; apps/node/src/backend.ts:284; apps/worker/src/backend.ts:312 --> |
| `emails_modify` | all | Read/unread, flag/unflag, move: folder path or alias `archive`/`trash`/`junk`/`inbox` |
| `emails_events` | all | New mail since a UID watermark, in ascending UID order. Stateless with `after_uid` → `next_after_uid` <!-- source: packages/core/src/dispatch.ts:773; apps/node/src/backend.ts:411; apps/worker/src/backend.ts:407 --> |
| `email_draft` | draft, pull_push | Save a new message, reply or forward to Drafts via IMAP. <!-- source: packages/core/src/dispatch.ts:815; packages/core/src/compose.ts:414 --> |
| `email_send` | pull_push | Send to/cc/bcc, plain or HTML, attachments |
| `email_respond` | pull_push | Reply or reply-all quotes the original by default. Without an explicit To list, reply-all adds the original recipients and filters the account’s own addresses, with a fallback for self-addressed mail. A forward requires an explicit To list, includes the original message, and includes original attachments by default (set `include_attachments=false` to omit them). If requested original attachment content is unavailable, the forward fails before sending. See threading below. After sending either type of reply, the server attempts to mark the original `\Answered` and returns a warning on failure. <!-- source: packages/core/src/compose.ts:315; packages/core/src/compose.ts:386; packages/core/src/dispatch.ts:910 --> |
| `sieve_scripts_list` | all (Node/Docker) | Sieve filter scripts (ManageSieve) with the active one marked |
| `sieve_script_get` | all (Node/Docker) | Full source of one script by exact name |
| `sieve_script_put` | all (Node/Docker) | Save a script under `name`; server-side validation runs first (unless `validate: false`), invalid scripts are reported and not saved |
| `sieve_script_check` | all (Node/Docker) | Validate script source server-side without saving |
| `sieve_script_activate` | all (Node/Docker) | Make a script the account's active script |
| `sieve_script_delete` | all (Node/Docker) | Delete a script; requires `confirm: true`, the ManageSieve server enforces active-script deletion restrictions <!-- source: packages/core/src/schemas.ts:258; packages/core/src/dispatch.ts:762; apps/node/src/managesieve-client.ts:219 --> |

`accounts_list` takes no parameters. All other tools accept optional `account_name`. Email IDs look like `<folder>:<uid>`.
<!-- source: packages/core/src/schemas.ts:39; packages/core/src/schemas.ts:229; packages/core/src/compose.ts:154 -->

### Send behavior

- **Threading:** When the original has a `Message-ID`, reply and reply-all set `In-Reply-To` to that ID and build `References` from the original references and ID. A forward omits both headers. <!-- source: packages/core/src/compose.ts:414 -->
- **Sent copy:** `SAVE_SENT=auto` attempts to append an IMAP Sent copy after SMTP delivery. It skips the attempt if the SMTP hostname matches one of these domains or a subdomain, case-insensitively: `gmail.com`, `googlemail.com`, `google.com`, `office365.com`, `outlook.com`, `hotmail.com`, `live.com`. Set `true` to always attempt the copy or `false` to skip it. The account’s `save_sent` overrides the global policy. An unresolved Sent folder or failed append returns a warning after SMTP delivery. <!-- source: packages/core/src/compose.ts:99; packages/core/src/dispatch.ts:362 -->
- **Bcc:** hidden from recipients. A Sent copy saved by the server includes Bcc addresses. <!-- source: apps/node/src/backend.ts:216; apps/worker/src/backend.ts:26; apps/worker/src/backend.ts:202; packages/core/src/compose.ts:102; packages/core/src/dispatch.ts:371 -->
- **Allowlist:** `SEND_ALLOWLIST=corp.com,boss@gmail.com` refuses any other recipient before anything is sent. The check covers To, Cc and Bcc. Drafts are exempt. <!-- source: packages/core/src/compose.ts:78; packages/core/src/compose.ts:425; packages/core/src/dispatch.ts:362; packages/core/src/dispatch.ts:815 -->
- **Draft-first:** `MAIL_MODE=draft` lets the agent write replies into Drafts while you review and press send in your own mail client.

### Sieve scripts

Set `SIEVE_HOST` (e.g. the host from `IMAP_HOST`) and the server registers six `sieve_*` tools for managing the account's mail filters over ManageSieve (RFC 5804). Auth reuses each account's IMAP credentials. Each ManageSieve operation opens a fresh connection. The default security setting is STARTTLS. Set `SIEVE_SECURE=tls` for implicit TLS or `SIEVE_SECURE=plain` for an unencrypted connection. By convention, keep one primary script named `active`. `sieve_script_put` with `name: "active"` validates it server-side before saving, `sieve_script_activate` makes it live. Activate another script before deleting the current one. The server can refuse the deletion. Requires a server with ManageSieve enabled (Dovecot Pigeonhole, Cyrus, …). The Node/Docker runtime provides these tools.
<!-- source: packages/core/src/config.ts:49; apps/node/src/managesieve-client.ts:109; apps/node/src/managesieve-client.ts:219; apps/node/src/managesieve-client.ts:529; packages/core/src/dispatch.ts:733; apps/worker/src/mcp.ts:21 -->

## Deploy: Docker + Cloudflare Tunnel + MCP portal

```
MCP portal --(Authorization: Bearer)--> Cloudflare Tunnel --> mail-mcp:8787/mcp
```

1. Follow the [Docker setup](#quick-start-build-with-docker) through editing `.env`.
2. Create a Cloudflare Tunnel in Zero Trust. Route a public hostname
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

<!-- source: README.md at origin/main:121; docker-compose.yml:24; docker-compose.image.yml:13; apps/node/src/server.ts:145; apps/node/src/server.ts:157 -->

Compose publishes the MCP port on the host's loopback address, `127.0.0.1:8787`.
The container listener is reachable on the Compose network, which the tunnel uses.
The container is read-only, runs as non-root, has a `/health` healthcheck, and declares no Compose volumes.
<!-- source: docker-compose.yml:12; docker-compose.image.yml:9; Dockerfile:22; apps/node/src/server.ts:115 -->

## Node / stdio (Claude Desktop, Cursor)

Use Node 22.12.0 or later on the Node 22 line and Corepack. From the repository root, copy `.env.example` to
`.env` and edit the mailbox settings and mode before launching the client.
<!-- source: CONTRIBUTING.md:3; pnpm-lock.yaml:1852; .env.example:1; apps/node/src/index.ts:7 -->

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

Use Node 22.12.0 or later on the Node 22 line, Corepack and an authenticated Wrangler session. Replace the KV ID
in `wrangler.toml` after creating the namespace. Before setting secrets or deploying,
update the Wrangler vars to match your accounts and mode. The checked-in
`DEFAULT_EMAIL_ACCOUNT = "default"` requires an account named `default`. If your
account JSON uses `work` as in the configuration example, set the var to `"work"`
or remove it to let the runtime choose.
<!-- source: CONTRIBUTING.md:3; pnpm-lock.yaml:1852; apps/worker/wrangler.toml:6; apps/worker/wrangler.toml:18; packages/core/src/config.ts:214 -->

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

Workers cannot connect to SMTP port 25. Configure Worker SMTP with port 587 for STARTTLS or 465 for implicit TLS if your SMTP server supports those settings. The Worker rejects `has_attachments=false`.
Worker SMTP requests STARTTLS when `SMTP_SECURE` is false and the port is other than 465. Port 465 forces implicit TLS. The Worker omits the `sieve_*` tools. Use Node/Docker with ManageSieve configured.
<!-- source: README.md at origin/main:157; apps/worker/src/backend.ts:121; apps/worker/src/backend.ts:376; docs/usage.md:187; apps/worker/src/mcp.ts:21; packages/core/src/config.ts:49 -->
Node/Docker is the primary deployment. Worker outbound TCP can also be blocked by
provider or network restrictions. Check connectivity to your IMAP and SMTP hosts.
<!-- source: apps/worker/src/backend.ts:29; apps/worker/src/backend.ts:376; docs/usage.md:186 -->
Set `MAIL_MODE=draft` and `EVENTS_POLL_SECONDS=0` in Wrangler vars for an initial
deployment with drafting enabled and sending disabled. Cron timing is set separately in `wrangler.toml`.
<!-- source: packages/core/src/schemas.ts:289; apps/worker/src/index.ts:43; apps/worker/wrangler.toml:11 -->

Events are polled with `emails_events`, not delivered through live MCP
notifications. Keep your own `after_uid` cursor for reliable independent consumers;
see [event semantics](docs/usage.md#events-and-cache).

## Test

From a fresh clone, use Node 22.12.0 or later on the Node 22 line and Corepack. The local E2E suite also needs
Bash, a running Docker daemon, and free ports (defaults: IMAP `13143`, SMTP
`13025`, MCP `8797`). Run these from the repo root.
<!-- source: CONTRIBUTING.md:3; pnpm-lock.yaml:1852; scripts/e2e.sh:11; scripts/e2e.sh:35 -->

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
