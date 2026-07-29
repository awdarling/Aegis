#!/usr/bin/env bash
#
# Tier-0 SMS test harness (SMS Testing Strategy §2). Posts a single Telnyx-shaped
# inbound webhook (application/json, event_type=message.received) to the Aegis
# SMS webhook — no phone, no real send. Use it to exercise the full chain
# (parse -> classify -> route -> workflow -> DB write -> generated outbound text)
# against the SANDBOX tenant and assert behaviour from the logs / DB.
#
# The server must run with SKIP_TELNYX_VERIFICATION=true (local/sandbox only,
# NEVER production) so this unsigned request passes signature verification, and
# with EMAIL_ONLY=false so the SMS path is live.
#
# Usage:
#   FROM="+16165550123" TEXT="what's my schedule this week?" ./scripts/sms-sim-inbound.sh
#   BASE_URL=http://localhost:3000 FROM=... TO=... TEXT=... ./scripts/sms-sim-inbound.sh
#   ./scripts/sms-sim-inbound.sh "+16165550123" "I need next Friday off"   # positional FROM TEXT
#
# Env / args:
#   BASE_URL  Aegis base URL           (default http://localhost:3000)
#   FROM      sender phone (E.164)      (arg 1; required)
#   TO        tenant SMS number (E.164) (default the sandbox tenant's number below)
#   TEXT      message body              (arg 2; required)

set -u

BASE_URL="${BASE_URL:-http://localhost:3000}"
FROM="${FROM:-${1:-}}"
TEXT="${TEXT:-${2:-}}"
# Default recipient = the sandbox tenant's SMS number (company_channels sms row
# for company_id 00000000-0000-0000-0000-000000000001). Override with TO=...
TO="${TO:-+16166164898}"

if [[ -z "$FROM" || -z "$TEXT" ]]; then
  echo "usage: FROM=<e164> TEXT=<message> $0   (or: $0 <FROM> <TEXT>)" >&2
  exit 1
fi

# Escape double quotes and backslashes in the body so the JSON stays valid.
esc_text=$(printf '%s' "$TEXT" | sed 's/\\/\\\\/g; s/"/\\"/g')

echo "-> POST $BASE_URL/webhooks/sms  from=$FROM to=$TO"
echo "   text: $TEXT"
curl -X POST "$BASE_URL/webhooks/sms" \
  -H "Content-Type: application/json" \
  --data "{\"data\":{\"event_type\":\"message.received\",\"payload\":{\"from\":{\"phone_number\":\"$FROM\"},\"to\":[{\"phone_number\":\"$TO\"}],\"text\":\"$esc_text\"}}}" \
  --silent --write-out $'\nHTTP %{http_code}\n'
