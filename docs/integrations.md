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

## Cache invalidation — mandatory when updating the registry

The integrations_registry is loaded into an in-memory cache with a 5-minute TTL
(see src/lib/registry-cache.ts). This means changes saved to the database are not
picked up immediately unless the cache is explicitly cleared.

Rule: any operator UI that saves a change to an integrations_registry row must call
invalidateRegistry() from src/lib/registry-cache.ts immediately after the Supabase
update succeeds. This ensures the change takes effect on the next agent call rather
than waiting up to 5 minutes for the TTL to expire.

No operator UI exists yet. This note is a reminder for when it is built.

---

## Taplio reminder
Taplio has no public scheduling API. The integration is content delivery only.
Approved posts are delivered to Taplio manually or via Zapier. No API call is built.
See /docs/ADR.md ADR-010.
