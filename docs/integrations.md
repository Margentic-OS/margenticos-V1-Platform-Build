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

**Paging within a run is a different thing from resuming across runs. Do not mix
them up.** These two both use the word "cursor" and they are not the same set.

| | Pages through every result inside one run? | Remembers where it stopped, for the next run? |
|---|---|---|
| `replies` | Yes | Yes — `last_cursor` |
| `leads_bounced` | Yes | No, deliberately |
| `leads_unsubscribed` | Yes | No, deliberately |

All three page. Only one persists. Fixed 2026-08-21: the code read the "next page"
token from `json.pagination.next_starting_after`, but Instantly returns
`next_starting_after` at the top level of the response, next to `items`, with no
`pagination` object at all. The path did not exist, so the token was always missing and
all three resources stopped after their first page of 100 rows. At 15 leads that
changed nothing, which is why it went unnoticed. At 500 prospects it would have quietly
capped reply collection at 100 per run.

**Two safety limits on the paging loop, and how to spot them firing.** Both write to
`last_error` and increment `error_count`, so a truncated scan shows up as a failed run
rather than as a clean one over partial data.

- *Page cap.* 20 pages per scan, 100 rows a page, so 2,000 rows. The whole cron
  function has 300 seconds before Vercel kills it, and it polls all three resources in
  that one window, so the cap keeps the pagination itself to roughly 10% of the budget
  and leaves the rest for the work done per row. If you see `page cap reached` in
  `last_error`, there was genuinely more data on the other side of it.
- *Cursor that stops moving.* If Instantly hands back the same "next page" token twice,
  the scan stops and records `the cursor is not advancing`. Without this, an API that
  echoed its token would loop until Vercel killed the function with nothing written
  anywhere to explain why.

**What happens to `replies`'s stored cursor when a run goes wrong.** Three different
answers, on purpose:

| What went wrong | Stored cursor | Why |
|---|---|---|
| A page request failed (500, 401, network) | Stays put | That page was never read. It must be re-fetched next run. |
| The page cap was hit | **Moves forward** | The 20 pages before the cap were read and their rows written, so the cursor points at finished work. Freezing it would make every future run re-read the same 20 pages and never reach page 21. The failure is still recorded; the alarm and the progress are both wanted. |
| The cursor stopped advancing | Stays put | The cursor is the thing that misbehaved. Saving a value Instantly keeps echoing would pin every future run to one page. |

**Why `last_cursor` is always NULL for `leads_bounced` and `leads_unsubscribed`.**
This is deliberate, not a bug and not an oversight. Those two resources re-scan
every matching lead on every run, because a bounce is a status change on a lead
that may have been created weeks earlier. A saved cursor would make the next run
resume *after* the last lead it saw, and any lead that bounced later would never
be looked at again. Duplicate signals are prevented by a unique index instead, so
re-scanning is free. If you ever see a value in that column for those two rows,
something has gone wrong.

`replies` does keep a cursor, because replies genuinely arrive in order. Note that this
is about resuming across runs only. Both lead resources still page through every result
within a single run — they just start from the beginning again next time.

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

**What this does NOT do.** It does not change how a bounce is detected and does not
touch the status constants. See `docs/audits/bounce-path-2026-08-21.md`.

**Update, 2026-08-21: bounces and unsubscribes now feed a suppression gate.** The
sentence that used to sit here said those signals were "written and read by nothing".
That is no longer true. Every verified bounced or unsubscribed lead's address is
recorded in the global `suppressed_emails` table, and the upload path excludes matches
before anything reaches Instantly. See the section below.


---

## Global suppression list (`suppressed_emails`)

**What it does.** Holds every email address that has bounced or unsubscribed in any
client's campaign, so we never mail it again from anywhere. One row per address per
suppression, keyed on a lowercased and trimmed address.

**What it connects to.**
- Written by the Instantly bounce/unsubscribe poller, in `pollInstantlyLeadStatus`
  (`src/lib/integrations/polling/instantly.ts`), immediately after each verified
  signal is written.
- Read by `findBlockedProspects()` (`src/lib/suppression/send-gate.ts`), which
  `handleUploadLeads` calls twice: once before claiming prospects, once as the final
  check before the upload.
- All list operations live in `src/lib/suppression/suppression-list.ts`.

**Why it is separate from `prospects.suppressed`.** That column is per organisation and
already means four different things: the client rejected this prospect, the research
agent disqualified them, they replied with an opt-out, or sourcing dedupe blocked them.
It cannot also mean "this mailbox is dead everywhere". The two are independent gates,
checked together in one function so there is still one chokepoint for the decision.

**Normalisation, and why it matters.** Addresses are lowercased and trimmed on write
and on every lookup, and Postgres enforces it with
`CHECK (email = lower(btrim(email)))`. Without this, `Bob@X.com` and `bob@x.com` are
two rows and the same person escapes suppression by capitalisation. Plus-addresses and
dots are deliberately left alone: folding them is a provider-specific guess, and
guessing wrong suppresses a mailbox that never bounced.

**How to lift a suppression.** Never delete the row. Set `revoked_at` and
`revoked_reason` together — the database rejects one without the other:

```ts
await revokeSuppression(serviceClient, 'Bob@X.com', 'mailbox restored, confirmed by client')
```

or by hand, normalising the address yourself:

```sql
UPDATE suppressed_emails
   SET revoked_at = now(), revoked_reason = 'why this is safe to contact again'
 WHERE email = lower(btrim('Bob@X.com')) AND revoked_at IS NULL;
```

The lookup filters on `revoked_at IS NULL`, so the revocation takes effect on the next
upload. The row stays, so the history of an address is always answerable. If the same
address bounces again later, a new active row is created and the revoked one is left
alone: the unique index is partial and only covers active rows.

**Who can read it.** Service role only. RLS is enabled with zero policies, and `anon`
and `authenticated` are revoked at the grant level as well. There is no client-facing
surface and there must never be one.

**What to check if it breaks.**
- *Suppressed addresses are still being uploaded.* Check that `findBlockedProspects` is
  still called at the final safety check in `handleUploadLeads`. The pre-filter before
  the claim is an optimisation and can be removed without affecting correctness; the
  final gate cannot.
- *Nothing is landing in the table.* Check `polling_cursors` for
  `resource = 'leads_bounced'` / `'leads_unsubscribed'`. A suppression write failure is
  recorded as a poll failure, so it reaches `last_error` and makes the run's `ok` false.
- *An upload aborts with "Final rejection check failed".* The gate fails closed on a
  query error rather than treating an unreadable list as an empty one. The message
  carries which of the two gates errored.

**Why it is global, and how to narrow it later.** A hard bounce is a fact about the
mailbox; an unsubscribe is arguably narrower ("not from you", not "not from anyone").
Today both are enforced globally, which is the strict reading. `reason` and
`source_org_id` are stored on every row so that judgement can change as a WHERE clause
rather than a migration. The global assumption is hardcoded in exactly one place, the
query in `lookupSuppressedEmails()`. Nothing else in the codebase may assume it.
