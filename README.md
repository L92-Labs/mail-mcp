# mail-mcp

SMTP/IMAP **MCP** server for L92 Labs. One tool surface, two runtimes:

| Runtime | Entry | Good for |
|---------|--------|----------|
| **Node** | stdio or Streamable HTTP | Local MCP clients, Docker on any host |
| **Cloudflare Worker** | `GET/POST /mcp` | Hosted remote MCP + Cron event cursors |

Inspired by [email-smtp-imap-mcp](https://github.com/samihalawa/email-smtp-imap-mcp) (tool names / workflow). Not a git fork — Workers need TCP-socket IMAP/SMTP clients (`cf-imap`, `worker-mailer`).

## Modes

| `MAIL_MODE` | Tools |
|-------------|--------|
| `pull` | `accounts_list`, `folders_list`, `emails_find`, `emails_modify`, `emails_events` |
| `pull_push` | above + `email_send`, `email_respond` |

**Events** are poll-based watermarks (not IMAP IDLE). Call `emails_events` for new mail since the cursor; first call seeds the high-water mark. On Workers, Cron warms cursors when `EVENTS_POLL_SECONDS > 0`.

**Cache** (`CACHE_TTL_SECONDS`, default `0` = off) optionally caches folder lists and lightweight search results.

## Configure

Copy [`.env.example`](.env.example) → `.env` (Node/Docker) or [`apps/worker/.dev.vars.example`](apps/worker/.dev.vars.example) → `apps/worker/.dev.vars`.

```bash
# multi-account
EMAIL_ACCOUNTS_JSON='{"work":{"imap":{...},"smtp":{...}}}'
DEFAULT_EMAIL_ACCOUNT=work
MAIL_MODE=pull_push
MCP_BEARER_TOKEN=long-random-string
```

Use provider **app passwords** for Gmail / iCloud / etc. Workers cannot use SMTP port 25 (use 587/465).

## Node / stdio (Claude Desktop, Cursor)

```bash
pnpm install
pnpm --filter @mail-mcp/core build
pnpm --filter @mail-mcp/node build
```

MCP client config:

```json
{
  "mcpServers": {
    "mail": {
      "command": "node",
      "args": ["/absolute/path/to/mail-mcp/apps/node/dist/index.js"],
      "env": {
        "EMAIL_ENV_FILE": "/absolute/path/to/mail-mcp/.env",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

## Docker (HTTP)

```bash
cp .env.example .env   # set IMAP/SMTP + MCP_BEARER_TOKEN
docker compose up --build
curl -s localhost:8787/health
```

Point a remote MCP client at `http://HOST:8787/mcp` with header `Authorization: Bearer <MCP_BEARER_TOKEN>`.

## Cloudflare Workers

```bash
pnpm install
pnpm --filter @mail-mcp/core build
cd apps/worker
cp .dev.vars.example .dev.vars
# create a real KV namespace and put its id in wrangler.toml
npx wrangler kv namespace create MAIL_KV
pnpm dev          # local
# secrets for prod:
npx wrangler secret put MCP_BEARER_TOKEN
npx wrangler secret put EMAIL_ACCOUNTS_JSON
pnpm deploy
```

Optional: `cf-bootstrap plan mail-mcp --recipe worker-api --modules kv` to align infra with other L92 Labs projects (provision when you want).

## Layout

```
packages/core   shared config, schemas, dispatch, cache/events
apps/node       imapflow + nodemailer (stdio / HTTP)
apps/worker     cf-imap + worker-mailer (/mcp + Cron)
```

## License

MIT
