# approval.md — Approval System Reference
# Stub — update as approval system is built.
# Cover: channel modes, notification timing, what to check if approvals break.
# The spec is in /prd/sections/08-approval.md.

## Approval system status
[Not yet built]

## Channel summary
cold_email:      3-day auto-approve. Notifications: T+0, T+15h, T+48h, T-12h.
linkedin_post:   24-hour auto-approve. Content delivery to Taplio after approval.
linkedin_dm:     3-day auto-approve. Same model as cold_email.

## Taplio reminder
linkedin_post approval = approved in dashboard → Doug delivers to Taplio manually/Zapier.
No programmatic Taplio API call. See /docs/ADR.md ADR-010.
