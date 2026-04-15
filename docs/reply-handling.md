# reply-handling.md — Reply Handling Reference
# Stub — update as reply handling is built.
# Cover: reply types, routing, escalation, opt-out, what to check if it breaks.
# The spec is in /prd/sections/09-reply-handling.md.

## Reply handling status
[Not yet built]

## Reply types
positive        → Automated same-hour response with booking link. Signed "[Company] Team."
information     → No automation. Flag to client. Escalation: 15h → 48h → 72h holding msg.
negative/opt-out → Immediate suppression. Push to Instantly API. No further contact.
out-of-office   → Pause sequence. Extract return date. Resume day after (10 days default).

## Identity rule
Always signed as "[Client Company Name] Team". Never founder name. Never "AI". Never "MargenticOS".
