#!/usr/bin/env bash
#
# End-to-end smoke test for every Aegis workflow against the deployed Railway URL.
# SMS now posts a Telnyx-shaped inbound webhook (application/json). Requires
# SKIP_TELNYX_VERIFICATION=true on the server so unsigned curl requests pass.

set -u

BASE_URL="https://aegis-production-3220.up.railway.app"
MANAGER_PHONE="+16163280114"
MANAGER_EMAIL="xander.w.darling@gmail.com"

# The tenant's own SMS number — the recipient ("to") of inbound SMS. This is
# Watermark's Telnyx number; a different tenant uses its own number.
WATERMARK_SMS_NUMBER="+16166164898"
WATERMARK_INBOUND_EMAIL="watermark@mail.quriasolutions.com"

# Seeded employee identifiers
EMPLOYEE_PHONE="+16165550200"
EMPLOYEE_EMAIL="aisha.johnson@watermark.com"

SMS_URL="$BASE_URL/webhooks/sms"
EMAIL_URL="$BASE_URL/webhooks/email"

send_sms() {
  local from="$1"
  local body="$2"
  # Telnyx inbound webhook shape: data.event_type=message.received with the
  # sender/recipient/text under data.payload.
  curl -X POST "$SMS_URL" \
    -H "Content-Type: application/json" \
    --data @- <<JSON \
    --silent --output /dev/null --write-out "HTTP %{http_code}"
{"data":{"event_type":"message.received","payload":{"from":{"phone_number":"$from"},"to":[{"phone_number":"$WATERMARK_SMS_NUMBER"}],"text":"$body"}}}
JSON
  echo ""
}

send_email() {
  local from="$1"
  local subject="$2"
  local text="$3"
  curl -X POST "$EMAIL_URL" \
    -F "from=$from" \
    -F "to=$WATERMARK_INBOUND_EMAIL" \
    -F "subject=$subject" \
    -F "text=$text" \
    --silent --output /dev/null --write-out "HTTP %{http_code}"
  echo ""
}

header() {
  echo ""
  echo "═══════════════════════════════════════"
  echo "$1"
  echo "═══════════════════════════════════════"
}

footer() {
  echo "→ Check Railway logs and email for response"
  sleep 3
}

# ─── MANAGER TESTS ─────────────────────────────────────────────────────────────

header "TEST 1 — Operational query (who's working today)"
send_sms "$MANAGER_PHONE" "Who is working today?"
footer

header "TEST 2 — Operational query (coverage check)"
send_sms "$MANAGER_PHONE" "Do we have enough lifeguards this Saturday?"
footer

header "TEST 3 — Emergency coverage"
send_sms "$MANAGER_PHONE" "Jordan just called out sick. Who can cover the PM shift today?"
footer

header "TEST 4 — Build schedule"
send_sms "$MANAGER_PHONE" "Build next week's schedule"
footer

header "TEST 5 — Homebase edit (employee hours)"
send_sms "$MANAGER_PHONE" "Update Emma's max hours to 32"
footer

header "TEST 6 — Homebase edit (new special note)"
send_sms "$MANAGER_PHONE" "Add a note — pool closed for maintenance July 10th and 11th"
footer

header "TEST 7 — Distribute schedule"
send_sms "$MANAGER_PHONE" "Distribute the schedule"
footer

header "TEST 8 — Payroll check"
send_sms "$MANAGER_PHONE" "Run a payroll check for this week"
footer

# ─── EMPLOYEE TESTS ────────────────────────────────────────────────────────────

header "TEST 9 — Employee time off request"
send_sms "$EMPLOYEE_PHONE" "I need time off next Friday"
footer

header "TEST 10 — Employee swap request (directed)"
send_sms "$EMPLOYEE_PHONE" "Can I swap my shift next Monday with Tyler?"
footer

header "TEST 11 — Employee operational query"
send_sms "$EMPLOYEE_PHONE" "What's my schedule this week?"
footer

header "TEST 12 — Employee availability update"
send_sms "$EMPLOYEE_PHONE" "I can no longer work Fridays"
footer

# ─── QURIA ADMIN TESTS ─────────────────────────────────────────────────────────

header "TEST 13 — Broadcast to all employees"
send_sms "$MANAGER_PHONE" "Send to all employees: The pool will be closed this Sunday for maintenance. No shifts that day."
footer

header "TEST 14 — Broadcast to managers only"
send_sms "$MANAGER_PHONE" "Send to managers: Staff meeting this Thursday at 9am before opening."
footer

# ─── EMAIL TESTS ───────────────────────────────────────────────────────────────

header "TEST 15 — Manager email operational query"
send_email "$MANAGER_EMAIL" "Schedule question" "How many hours has our most scheduled employee worked this week?"
footer

header "TEST 16 — Employee email time off"
send_email "$EMPLOYEE_EMAIL" "Time off request" "I need August 5th through 7th off. Family trip."
footer

echo ""
echo "All 16 tests dispatched. Tail Railway logs to watch processing."
echo ""
