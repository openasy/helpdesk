#!/bin/bash
# End to end against a real Stalwart, the mail server OpenAsy Mail runs on: starts the version Mail pins in Docker,
# then e2e/stalwart.ts finishes its first start through its API, makes a support and a customer account, and runs
# Helpdesk's mail path against it over IMAP and SMTP. Needs Docker. Exits non-zero on failure.
set -u
cd "$(dirname "$0")/.."
IMAGE=${E2E_SW_IMAGE:-stalwartlabs/stalwart:v0.16}
HTTP=${E2E_SW_PORT:-18090}
IMAP=${E2E_SW_IMAP:-11994}
SMTP=${E2E_SW_SMTP:-11465}
NAME=helpdesk-e2e-sw
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; }
cleanup
[ -n "${E2E_KEEP:-}" ] || trap cleanup EXIT
RECOVERY="e2e-recovery-$(openssl rand -hex 8)"
docker run -d --name "$NAME" -p "127.0.0.1:$HTTP:8080" -p "127.0.0.1:$IMAP:993" -p "127.0.0.1:$SMTP:465" -e STALWART_RECOVERY_ADMIN="admin:$RECOVERY" "$IMAGE" >/dev/null
for _ in $(seq 1 60); do curl -s -o /dev/null "http://localhost:$HTTP/.well-known/jmap" && break; sleep 1; done
echo "# $IMAGE on port $HTTP"
SW="http://localhost:$HTTP" SW_IMAP_PORT="$IMAP" SW_SMTP_PORT="$SMTP" SW_RECOVERY="$RECOVERY" SW_CONTAINER="$NAME" node e2e/stalwart.ts
status=$?
[ $status -eq 0 ] || docker logs --tail 40 "$NAME"
exit $status
