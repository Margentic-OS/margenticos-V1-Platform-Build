# reply-handling.md — Reply Handling Reference
# Living technical reference — points to authoritative spec in /prd/sections/09-reply-handling.md.
# Update this when reply handling is built or when spec changes.

## Authoritative source
All reply handling specification lives in `/prd/sections/09-reply-handling.md`.
This file documents implementation gotchas, dependencies, and what to check if it breaks.

## Reply types (summary)
positive        → Automated same-hour response with booking link. Signed with founder name and title.
information     → No automation. Flag to client. Escalation: 15h → 48h → 72h holding msg.
negative/opt-out → Immediate suppression. Push to Instantly API. No further contact.
out-of-office   → Pause sequence. Extract return date. Resume day after (10 days default).

## Identity rule (see ADR-020)
Operator-reviewed replies: signed as founder first name, last name, and title (e.g. "Doug Pettit, Founder & Head of Pipeline").
System-generated messages (not operator-reviewed): signed as "[Company] Team".
Signature format: plain text, no links except Calendly in replies. See `design.md` for signature block spec.
