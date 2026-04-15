# integrations.md — Integration Documentation
# Stub — update as each integration is connected.
# Cover: registry pattern, each registered tool, handler locations, what to check if it breaks.
# The spec is in /prd/sections/13-integrations.md.

## Integrations connected
[None yet — integrations_registry table not yet created]

## Capability registry reminder
No agent or component may reference a tool name directly.
All external calls go through executeCapability() in src/lib/handlers/capability.ts.
Handler functions are the only place where tool-specific code lives.

## Taplio reminder
Taplio has no public scheduling API. The integration is content delivery only.
Approved posts are delivered to Taplio manually or via Zapier. No API call is built.
See /docs/ADR.md ADR-010.
