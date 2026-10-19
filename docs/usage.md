# Using mail-mcp

## Connect and verify

For Docker HTTP, connect your MCP client using Streamable HTTP, URL
`https://<your-host>/mcp`, and header `Authorization: Bearer <MCP_BEARER_TOKEN>`.
Bearer/header configuration differs by client. This server does not implement an
OAuth authorization flow; clients requiring OAuth need a compatible MCP gateway.
Use the README's Node configuration for stdio; set `MCP_TRANSPORT=stdio`.

Start with `accounts_list {}`, then `folders_list {"account_name":"work"}`.
The second call actually contacts IMAP. The examples below are tool arguments,
not raw HTTP request bodies. Ask your MCP client to call the named tool with them.

## Read, search and organize

`emails_find` — unread mail, newest first:

```json
{"account_name":"work","folder":"INBOX","filters":{"is_unread":true},"limit":10}
```

For older pages, repeat the same arguments and add `cursor` from `next_cursor`.
Stop when `next_cursor` is null. Search with `query`, or structured filters such
as `{"from":"billing@example.com","after_date":"2026-01-01"}`.

`email_get` — use an actual ID from the search result:

```json
{"account_name":"work","email_id":"INBOX:123","include_attachment_content":true}
```

Reading does not mark mail read unless `mark_read:true`. Attachments above
`ATTACHMENT_MAX_BYTES` are listed without content. Body text is capped by
`MAX_BODY_CHARS`; override with `max_chars` when needed.

`emails_modify` — mark read and archive:

```json
{"account_name":"work","email_ids":["INBOX:123"],"mark_read":true,"move_to_folder":"archive"}
```

Use `folders_list` for actual folder paths; aliases also include `trash`, `junk`
and `inbox`. A move changes the message ID; search in the destination again.
`pull` mode permits these changes. There is no strict read-only mode yet.

## Draft, reply and send

Start with `MAIL_MODE=draft`. `email_draft` can create a new message or a threaded
reply; review and send it in your own mail app:

```json
{"account_name":"work","email_id":"INBOX:123","body":"Thanks, I will review this today."}
```

With `MAIL_MODE=pull_push`, `email_respond` sends immediately:

```json
{"account_name":"work","email_id":"INBOX:123","body":"Approved.","reply_all":true}
```

For forwarding, set `forward:true` and an explicit `to` array. Forwarded
attachments are included by default. Explicit recipients are preserved, including
your own address; inferred reply-all recipients omit your own addresses.

`email_send` — new message:

```json
{"account_name":"work","to":["colleague@example.com"],"subject":"Meeting notes","body":"Here are the notes."}
```

Optional fields include `cc`, `bcc`, `body_type:"html"`, and attachments:
`{"filename":"notes.txt","content":"aGVsbG8=","content_type":"text/plain"}`.
Set `SEND_ALLOWLIST` to approved addresses/domains. Empty means unrestricted.
`SAVE_SENT=auto` handles Sent copies; use `true`/`false` or account folder overrides
if your provider behaves differently. Inspect warnings before retrying a send:
SMTP delivery may have succeeded even if saving Sent failed. Sending is not
idempotent; blind retries can deliver duplicates.

## Events and cache

`emails_events` exposes polling, not MCP push notifications, webhooks, or IMAP IDLE.

1. Call with `{"account_name":"work","folder":"INBOX"}`. First call seeds the
   current watermark and returns no historical messages.
2. Persist the returned `next_after_uid` in your consumer.
3. Poll with `{"account_name":"work","folder":"INBOX","after_uid":123,"limit":100}`,
   replacing 123 with your stored watermark.
4. Process results oldest first; persist the new watermark after successful
   processing. Drain additional pages while `has_more` is true.

Explicit `after_uid:0` starts from existing mail. Track cursors separately for
every account/folder; UIDs belong to a mailbox and can reset if it is recreated
(UIDVALIDITY changes). Reset your consumer deliberately after such a change.
There is no automatic UIDVALIDITY recovery yet.

Without `after_uid`, clients share one server cursor. Node stores it in memory
(restart resets it); Worker stores it in KV. Background polling/Cron advances
that shared cursor and can consume events before a client asks. Leave
`EVENTS_POLL_SECONDS=0` and use explicit client cursors for reliable polling.
Worker Cron cadence comes from `wrangler.toml`; the env setting enables/disables
the scheduled work rather than changing the Cron interval.

Cache defaults off. `CACHE_TTL_SECONDS` enables listing caches, in Node memory or
Worker KV. Writes invalidate cache; changes from other mail apps can remain stale
until TTL expiry. Cache and server cursors are convenience state, not a durable
message queue or exactly-once delivery mechanism.

## Operations and troubleshooting

```bash
docker compose -f docker-compose.image.yml ps
docker compose -f docker-compose.image.yml logs --tail=100 mail-mcp
# Update selected image (MAIL_MCP_IMAGE in .env):
docker compose -f docker-compose.image.yml pull
docker compose -f docker-compose.image.yml up -d
```

Rollback by setting `MAIL_MCP_IMAGE` to the previous version/digest and repeating
pull/up. Include `--profile tunnel` on up when using the tunnel service.
No mail data is stored in container volumes; mail remains on the IMAP server.

| Symptom | Check |
|---|---|
| HTTP 401 | Client bearer token matches `.env`; restart after changing env |
| Healthy endpoint, failed folder list | IMAP host, port, app password, TLS and outbound firewall |
| SMTP auth or TLS error | 587 with `SMTP_SECURE=false` uses STARTTLS; 465 with `true` uses implicit TLS |
| Missing draft/send tools | `MAIL_MODE`; restart after changing it |
| Recipient refused | `SEND_ALLOWLIST` applies to every To/Cc/Bcc recipient |
| No events | First call seeds; shared cursor may have advanced; use explicit `after_uid` |
| GHCR pull denied | First publish completed; package visibility/access; authenticate for private package |
| Worker deployment fails | Replace placeholder KV ID, set secrets, verify provider TCP compatibility |

Never disable certificate verification to work around an expired mail-server
certificate. Renew the certificate and reload the mail services.
