#!/usr/bin/env bash
# One-command local run of the GreenMail e2e suite — the same image, users and
# checks CI runs, reproducible on any machine with Docker and pnpm:
#
#   pnpm e2e:local               # build + start GreenMail + run e2e + teardown
#   E2E_KEEP=1 pnpm e2e:local    # keep the container running for debugging
#                                # (stop it later: docker rm -f mailmcp-greenmail-e2e)
#
# Ports default to CI's (IMAP 13143, SMTP 13025, MCP 8797) and honor the same
# E2E_IMAP_PORT / E2E_SMTP_PORT / E2E_PORT env vars the suite itself uses.
set -euo pipefail

IMAGE="greenmail/standalone:2.1.3"
NAME="mailmcp-greenmail-e2e"
IMAP_PORT="${E2E_IMAP_PORT:-13143}"
SMTP_PORT="${E2E_SMTP_PORT:-13025}"
SERVER_PORT="${E2E_PORT:-8797}"

for port in "$IMAP_PORT" "$SMTP_PORT" "$SERVER_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "port $port is already in use — set E2E_IMAP_PORT / E2E_SMTP_PORT / E2E_PORT to free ones" >&2
    exit 1
  fi
done

cleanup() {
  if [ "${E2E_KEEP:-0}" = "1" ]; then
    echo "keeping $NAME running (E2E_KEEP=1); stop it with: docker rm -f $NAME"
  else
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --rm --name "$NAME" \
  -p "127.0.0.1:$SMTP_PORT:3025" \
  -p "127.0.0.1:$IMAP_PORT:3143" \
  -e GREENMAIL_OPTS='-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled=false -Dgreenmail.users=me:pw@example.com,alice:pw@corp.com -Dgreenmail.users.login=email' \
  "$IMAGE" >/dev/null

echo "waiting for GreenMail IMAP on 127.0.0.1:$IMAP_PORT ..."
ready=0
for _ in $(seq 1 60); do
  if PORT="$IMAP_PORT" node -e "
    const net = require('node:net');
    const s = net.connect({ port: Number(process.env.PORT), host: '127.0.0.1' });
    s.setTimeout(2000);
    s.on('data', (d) => process.exit(d.toString().includes('OK') ? 0 : 1));
    s.on('error', () => process.exit(1));
    s.on('timeout', () => process.exit(1));
  " 2>/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "GreenMail did not become ready; container logs:" >&2
  docker logs "$NAME" >&2 || true
  exit 1
fi
echo "GreenMail ready."

pnpm build
E2E_IMAP_PORT="$IMAP_PORT" E2E_SMTP_PORT="$SMTP_PORT" E2E_PORT="$SERVER_PORT" \
  pnpm --filter @mail-mcp/node e2e
