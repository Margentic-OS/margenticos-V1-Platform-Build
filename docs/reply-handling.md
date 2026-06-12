# reply-handling.md — Reply Handling Reference
# Stub — update as reply handling is built.
# Cover: reply types, routing, escalation, opt-out, what to check if it breaks.
# The spec is in /prd/sections/09-reply-handling.md.

## Reply handling status
[Not yet built]

## Reply types
positive        → Automated same-hour response with booking link. Signed with founder first name.
information     → No automation. Flag to client. Escalation: 15h → 48h → 72h holding msg.
negative/opt-out → Immediate suppression. Push to Instantly API. No further contact.
out-of-office   → Pause sequence. Extract return date. Resume day after (10 days default).

## Identity rule
All operator-reviewed replies signed as: founder first name only. Never "AI". Never "automated". Never "MargenticOS".
System-generated messages not reviewed by operator (holding messages, opt-out confirmations) signed as "[Company] Team".
