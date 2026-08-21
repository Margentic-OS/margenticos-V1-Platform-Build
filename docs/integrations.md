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

## Instantly polling — how to tell a healthy run from a silent one

The poller is `/api/cron/instantly-poll`, which calls
`src/lib/integrations/polling/instantly.ts` every 15 minutes. It polls three
resources: `replies`, `leads_bounced`, `leads_unsubscribed`. Each has one row in
the `polling_cursors` table.

**What each column actually means.** Read them together — one on its own will
mislead you.

| Column | Means | Written when |
|---|---|---|
| `last_run_at` | The cron fired and the function started. | Every run, success or failure. |
| `last_polled_at` | We genuinely reached Instantly and it answered. | Only when at least one call returned 2xx with a readable body. Zero results still counts. |
| `last_cursor` | Where to resume next time. | `replies` only. Always NULL for the two lead resources, on purpose — see below. |
| `error_count` | Running total of failed calls. | Adds this run's failures. Resets to 0 only on a run with no failures. |
| `last_error` | The first failure of the run, with its HTTP status and the campaign it came from. | Only when the run had a failure. Cleared only by a clean run. |

**The question these answer.** Before August 2026 every one of these rows read
clean no matter what happened: a run where every single API call failed still
wrote `error_count = 0` and `last_error = NULL`, and the route returned
`ok: true`. So "the poller found no bounces" and "the poller never managed to
ask" looked identical. `last_polled_at` is what tells them apart now.

**How to read it when something feels wrong:**

- `last_run_at` recent, `last_polled_at` NULL or stale → the cron is firing but
  Instantly is not answering. Check `last_error` for the status code. A 401 means
  the API key in `integration_credentials` is dead. A 400 means the request shape
  was rejected.
- `last_run_at` stale → the cron itself is not firing. Check pg_cron, not the app.
- Both recent, `error_count` 0 → the poll genuinely happened and genuinely found
  nothing. That is a real answer, not a silence.
- `error_count` climbing across runs → failures are persistent, not a blip. The
  count only resets on a fully clean run.

**Why `last_cursor` is always NULL for `leads_bounced` and `leads_unsubscribed`.**
This is deliberate, not a bug and not an oversight. Those two resources re-scan
every matching lead on every run, because a bounce is a status change on a lead
that may have been created weeks earlier. A saved cursor would make the next run
resume *after* the last lead it saw, and any lead that bounced later would never
be looked at again. Duplicate signals are prevented by a unique index instead, so
re-scanning is free. If you ever see a value in that column for those two rows,
something has gone wrong.

`replies` does keep a cursor, because replies genuinely arrive in order.

**A note on `last_polled_at`.** The original migration
(`20260428_instantly_polling.sql`) reserved this column as a timestamp cursor for
APIs that support "give me everything since X". Instantly has no such filter, no
other source uses one, and nothing had ever written the column. It now carries the
did-we-actually-reach-Instantly meaning described above.

**Where `ok` comes from.** The route sets one value and uses it for all three
instruments — the `cron_heartbeats` row, the Sentry check-in, and the HTTP
response. It is true only when every resource that made a call got at least one
success back, and nothing errored anywhere. A resource with nothing to poll (no
registered campaigns) reports `attempted: false` in the response and is not
counted as a failure.

**What this does NOT do.** It does not change how a bounce is detected, does not
touch the status constants, and does not connect bounces or unsubscribes to
suppression. Those signals are still written and read by nothing. See
`docs/audits/bounce-path-2026-08-21.md`.
