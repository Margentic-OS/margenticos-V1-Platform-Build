# Bounce and unsubscribe path — read-only code audit

Date: 2026-08-21
Scope: Instantly API response → final effect, as the code actually behaves.
Method: repo-wide grep, then direct read of every file that touches the path.
No code was changed. No migration was applied. No database was queried.
No live API was called.

---

## 0. Scope discovery — every file that touches an Instantly lead status field

Greps run across the whole repo (excluding `node_modules` and `.next`) for
`lt_interest_status`, `FILTER_VAL`, `bounce`, `unsubscrib`, `suppress`, and bare
`-1 / -2 / -3` in comparison position.

**`FILTER_VAL_BOUNCED` does not exist anywhere in this repo.** Zero hits. If that
name came from another system or an earlier draft, it was never committed here.

### Files that read or write an Instantly lead status field

| File:line | Field | Direction |
|---|---|---|
| [instantly.ts:49](src/lib/integrations/polling/instantly.ts#L49) | `status` (as request filter) | write to request body, value `'-2'` |
| [instantly.ts:50](src/lib/integrations/polling/instantly.ts#L50) | `status` (as request filter) | write to request body, value `'-1'` |
| [instantly.ts:625](src/lib/integrations/polling/instantly.ts#L625) | `status` | placed in POST body |
| [reply-actions.ts:53](src/lib/integrations/handlers/instantly/reply-actions.ts#L53) | `lt_interest_status` | write, hardcoded `-1` |
| [reply-actions.ts:11](src/lib/integrations/handlers/instantly/reply-actions.ts#L11) | `lt_interest_status` | comment documenting the write |
| [mock-dispatch.ts:80](src/lib/integrations/handlers/instantly/mock-dispatch.ts#L80) | `lt_interest_status` | mock response body, `-1` |
| [reply-actions.contract.test.ts:64,69](src/lib/integrations/handlers/instantly/__tests__/reply-actions.contract.test.ts#L64) | `lt_interest_status` | test asserts the request body |
| [instantly.test.ts:7,15,23,57,73,88,90](src/lib/integrations/polling/instantly.test.ts#L7) | `status` (synthetic objects only) | reads the constants, never the code path |
| [process-reply.ts:302,555](src/lib/reply-handling/process-reply.ts#L302) | `lt_interest_status` | comments only |
| [instantly.ts:25](src/lib/integrations/polling/instantly.ts#L25) | comment hedging 3 candidate fields | comment only |
| [20260429_reply_handling.sql:46](supabase/migrations/20260429_reply_handling.sql#L46) | `lt_interest_status` | comment only |

**Nothing in this repo ever READS a `status` or `lt_interest_status` value off an
Instantly API response.** Both fields appear only in outbound request bodies, mock
bodies, comments, and synthetic test fixtures. This single fact drives most of
section B and section C below.

### Other files in the bounce/unsubscribe blast radius

- [src/app/api/cron/instantly-poll/route.ts](src/app/api/cron/instantly-poll/route.ts) — the poller entry point
- [src/lib/integrations/handlers/instantly/constants.ts](src/lib/integrations/handlers/instantly/constants.ts) — dispatch mode
- [src/lib/integrations/handlers/instantly/auth.ts](src/lib/integrations/handlers/instantly/auth.ts) — the flag read
- [src/lib/integrations/handlers/instantly/campaign-analytics.ts](src/lib/integrations/handlers/instantly/campaign-analytics.ts) — a *separate* bounce path (aggregate counts)
- [src/lib/metrics/campaign-metrics.ts](src/lib/metrics/campaign-metrics.ts), [src/lib/metrics/get-client-visible-campaign-metrics.ts](src/lib/metrics/get-client-visible-campaign-metrics.ts) — display of the aggregate counts
- [src/components/dashboard/operator/CampaignMetricsPanel.tsx](src/components/dashboard/operator/CampaignMetricsPanel.tsx) — the only place a bounce number reaches a human
- [src/lib/benchmarks/tier1-benchmarks.ts:55-62](src/lib/benchmarks/tier1-benchmarks.ts#L55) — bounce thresholds, defined
- [src/components/dashboard/operator/SignalsLogView.tsx:29](src/components/dashboard/operator/SignalsLogView.tsx#L29) — label map
- [supabase/migrations/20260428_instantly_polling.sql](supabase/migrations/20260428_instantly_polling.sql) — tables, idempotency index, cron
- [supabase/migrations/20260429_reply_handling.sql](supabase/migrations/20260429_reply_handling.sql) — process-replies cron
- [supabase/migrations/20260502_signals_signal_type_constraint.sql:37-38](supabase/migrations/20260502_signals_signal_type_constraint.sql#L37) — CHECK constraint allows both types

---

## A. RETRIEVAL

### A1. Endpoint, request body, campaign filter

The bounce poll and the unsubscribe poll are the same function called twice with
different arguments: [route.ts:97-102](src/app/api/cron/instantly-poll/route.ts#L97)
and [route.ts:111-116](src/app/api/cron/instantly-poll/route.ts#L111).

Transport is **POST**, not GET, via `instantlyPost`
([instantly.ts:377-423](src/lib/integrations/polling/instantly.ts#L377)):

```
fetch(`${baseUrl}${path}`, { method: 'POST', ... })   // instantly.ts:394
```

Path is `'/leads/list'` ([instantly.ts:631](src/lib/integrations/polling/instantly.ts#L631)).
`baseUrl` resolves to `https://api.instantly.ai/api/v2`
([constants.ts:5,29-33](src/lib/integrations/handlers/instantly/constants.ts#L5))
unless `INSTANTLY_API_BASE_URL` is set. So the full URL is
`https://api.instantly.ai/api/v2/leads/list`.

The request body, verbatim from [instantly.ts:624-629](src/lib/integrations/polling/instantly.ts#L624):

```ts
const body: Record<string, unknown> = {
  status: instantlyStatus,
  campaign: instantlyCampaignId,
  limit: 100,
}
if (pageCursor) body.starting_after = pageCursor
```

`instantlyStatus` is a **string**, not a number:
`INSTANTLY_LEAD_STATUS_BOUNCED = '-2'` and `INSTANTLY_LEAD_STATUS_UNSUBSCRIBED = '-1'`
([instantly.ts:49-50](src/lib/integrations/polling/instantly.ts#L49)). It is serialised
by `JSON.stringify` at [instantly.ts:400](src/lib/integrations/polling/instantly.ts#L400),
so the wire body is `{"status":"-2","campaign":"<uuid>","limit":100}`.

**Yes, it passes a campaign filter** — the `campaign` key, one campaign per request,
looped at [instantly.ts:613-614](src/lib/integrations/polling/instantly.ts#L613).

Three things about this body that the code cannot confirm and neither can I:

1. Whether `/leads/list` accepts a body key named `status`. **CANNOT DETERMINE**
   from the code. What would answer it: one live `POST /api/v2/leads/list` against
   the real workspace, or the request-body schema for that operation in the Instantly
   V2 OpenAPI spec. The ground truth supplied for this audit covers the *Lead* schema,
   not the list-endpoint request schema.
2. Whether `campaign` is the correct key (versus `campaign_ids`, `campaign_id`, etc.).
   **CANNOT DETERMINE** from the code. Same evidence would answer it.
3. Whether a **string** `"-2"` is accepted where the Lead schema types `status` as an
   integer. **CANNOT DETERMINE**. Note that [instantly.test.ts:37-46](src/lib/integrations/polling/instantly.test.ts#L37)
   asserts the string type is correct, with the justification "Instantly V2 API
   returns status as string in JSON, not numeric" — that comment contradicts the
   ground-truth Lead schema for this audit, and nothing in the repo substantiates it.

The file's own header comment is also **wrong about its own transport**:
[instantly.ts:8-9](src/lib/integrations/polling/instantly.ts#L8) documents
`GET /api/v2/lead/list?status=BOUNCED_STATUS`. The code does POST `/leads/list`.
Singular `lead` versus plural `leads`, GET versus POST. The comment describes a
different endpoint from the one that ships.

### A2. Pagination

It does paginate, and it does loop on the cursor
([instantly.ts:673-674](src/lib/integrations/polling/instantly.ts#L673)):

```ts
if (!nextCursor) break
pageCursor = nextCursor
```

with a hard ceiling of 50 pages per campaign
([instantly.ts:618](src/lib/integrations/polling/instantly.ts#L618)) at
`limit: 100`, so **5,000 bounced leads per campaign per run** is the structural cap.
Nothing logs when that ceiling is hit — the loop simply ends and the run reports
success.

The cursor is extracted at [instantly.ts:315-317](src/lib/integrations/polling/instantly.ts#L315):

```ts
const nextCursor: string | null =
  ((json as Record<string, unknown>)?.pagination as Record<string, unknown>)
    ?.next_starting_after as string | null ?? null
```

It reads `next_starting_after` **nested inside a `pagination` object**. The ground
truth for this audit states the API returns `next_starting_after`; it does not state
whether that key sits at the top level or inside a `pagination` wrapper. The only
in-repo evidence for the nested shape is the mock, which the same author wrote:
[mock-dispatch.ts:66](src/lib/integrations/handlers/instantly/mock-dispatch.ts#L66)
returns `{ items: [], pagination: {} }`. A mock agreeing with the parser it was
written alongside is not evidence about the real API. **The nesting is UNVERIFIED.**

Stated plainly, as requested: **if `next_starting_after` is returned at the top level
rather than under `pagination`, `nextCursor` is `null` on every page, the loop breaks
after page one, and every bounced lead past the first 100 is invisible to the poller.**
That break is silent — no log, no error, no counter.

How many leads before it bites, if that is the shape:

- The list is already filtered to bounced leads, so the ceiling is **100 bounced
  leads in a single campaign**, not 100 leads total.
- At the amber/red boundary the code itself uses (2%,
  [tier1-benchmarks.ts:59](src/lib/benchmarks/tier1-benchmarks.ts#L59)), 100 bounces
  means roughly **5,000 emails sent** on that campaign.
- At a healthy 1% ([tier1-benchmarks.ts:57](src/lib/benchmarks/tier1-benchmarks.ts#L57)),
  roughly **10,000 sent**.
- At a domain-destroying 10%, roughly **1,000 sent** — the worse the bounce problem,
  the sooner the poller stops being able to see it.

The reply poll has the same parser and the same 50-page ceiling
([instantly.ts:448](src/lib/integrations/polling/instantly.ts#L448),
[instantly.ts:531](src/lib/integrations/polling/instantly.ts#L531)), so the same
uncertainty applies there.

### A3. Which organisations the poller covers

Decided entirely by one query, [instantly.ts:585-589](src/lib/integrations/polling/instantly.ts#L585):

```ts
const { data: campaigns, error: campaignsError } = await supabase
  .from('campaigns')
  .select('id, organisation_id, external_id, organisations!inner(archived_at)')
  .not('external_id', 'is', null)
  .is('organisations.archived_at', null)
```

Coverage is therefore: **every row in `campaigns` that has a non-null `external_id`
and whose organisation has `archived_at IS NULL`.** There is no per-organisation
allowlist, no client filter, no `is_active` check on the campaign, and no `.limit()`
(the PostgREST default row cap applies; the project's configured value is UNVERIFIED).

**The DRY RUN TEST org (`a2b621fc-4c9d-43d9-9af4-1253ff49d12d`): excluded, on the
strength of `archived_at`, not on any bounce-specific rule.**
[docs/BACKLOG.md:56-57](docs/BACKLOG.md#L56) records that org as
"archived 2026-08-05". If that is still true in the live database, the
`organisations.archived_at IS NULL` filter drops all of its campaigns and the poller
never asks Instantly about any of its leads.

Two caveats I will not paper over:
- I did not query the database, so the current value of `archived_at` for that org is
  **UNVERIFIED**. What would answer it: `SELECT archived_at FROM organisations WHERE id = 'a2b621fc-4c9d-43d9-9af4-1253ff49d12d'`.
- The exclusion is incidental. Unarchive that org for any reason — [BACKLOG.md:53-55](docs/BACKLOG.md#L53)
  records exactly that being done for 30 seconds on 2026-08-20 — and it is back in
  scope for the poller with no separate decision made.

### A4. Non-200, timeout, empty items

**Non-200** — [instantly.ts:407-414](src/lib/integrations/polling/instantly.ts#L407):

```ts
if (!response.ok) {
  const text = await response.text().catch(() => '')
  return {
    data: null,
    nextCursor: null,
    error: `Instantly API ${response.status}: ${text.slice(0, 200)}`,
  }
}
```

That error string is handled at [instantly.ts:633-643](src/lib/integrations/polling/instantly.ts#L633):

```ts
if (error) {
  // Log and move on to the next campaign — one campaign failure doesn't abort the run.
  logger.error('Instantly poll: lead status fetch failed', { ... })
  result.errors++
  break
}
```

`break` exits the page loop for that campaign; the outer `for` continues to the next.
**No `Sentry.captureException` is raised on this path** (contrast
[instantly.ts:296-299](src/lib/integrations/polling/instantly.ts#L296), where a
failed *signal write* does report to Sentry). A 401 on a rotated API key, or a 400 on
a rejected `status` filter, produces a `logger.error` line and nothing else.

Then — and this is the part that matters — control reaches
[instantly.ts:678](src/lib/integrations/polling/instantly.ts#L678):

```ts
await setCursorSuccess(supabase, resource, null)
```

`setCursorSuccess` writes `error_count: 0, last_error: null`
([instantly.ts:134-135](src/lib/integrations/polling/instantly.ts#L134)). **A run in
which every single campaign returned 400 still stamps the `polling_cursors` row as a
clean success.** `setCursorError` is only reachable from the campaigns-query failure
at [instantly.ts:596](src/lib/integrations/polling/instantly.ts#L596) or the outer
`catch` at [instantly.ts:688](src/lib/integrations/polling/instantly.ts#L688), neither
of which a per-campaign HTTP error reaches.

**No `catch` block covers the HTTP error path at all.** The only `catch` in
`instantlyPost` is around `fetch` itself
([instantly.ts:402-404](src/lib/integrations/polling/instantly.ts#L402)):

```ts
} catch (err) {
  return { data: null, nextCursor: null, error: `Network error: ${String(err)}` }
}
```

which converts a thrown network failure into the same non-fatal `error` string, feeding
the same `break`. The outer `catch` at [instantly.ts:686-694](src/lib/integrations/polling/instantly.ts#L686)
catches only what escapes all of that — in practice, `InstantlyFlagError` from the
safety gate at [instantly.ts:385-387](src/lib/integrations/polling/instantly.ts#L385)
and Supabase throws.

**Timeout** — there is none. Neither `instantlyPost`
([instantly.ts:394-401](src/lib/integrations/polling/instantly.ts#L394)) nor
`instantlyGet` ([instantly.ts:347-352](src/lib/integrations/polling/instantly.ts#L347))
passes an `AbortSignal` or any timeout. The only timeout in the file is the 5s abort in
`fetchOutboundEmailBody` ([instantly.ts:212-213](src/lib/integrations/polling/instantly.ts#L212)),
which is on the reply path, not the lead-status path. The route exports no
`maxDuration` (whole file read: [route.ts](src/app/api/cron/instantly-poll/route.ts),
201 lines, no such export), so the platform default applies. The scheduler-side
`timeout_milliseconds := 55000` in
[20260428_instantly_polling.sql:216](supabase/migrations/20260428_instantly_polling.sql#L216)
caps pg_net's wait, not the function's work. A hung Instantly connection stalls the
run until the platform kills it, and the killed run writes no heartbeat row at all
([route.ts:183-192](src/app/api/cron/instantly-poll/route.ts#L183) is never reached).

**Empty items array** — [instantly.ts:645](src/lib/integrations/polling/instantly.ts#L645):

```ts
if (!leads || leads.length === 0) break
```

Treated as "end of results". Zero written, zero errors, run reports success. This is
correct when there genuinely are no bounces. It is **indistinguishable from** the case
where the API returned 200 with a payload shape the parser does not understand:
[instantly.ts:312-314](src/lib/integrations/polling/instantly.ts#L312) returns `[]`
for any JSON that is neither an array nor has an `items` key. A 200 with
`{"data":[...]}` or `{"leads":[...]}` yields "no bounces" forever, silently.

**Paths that return a success value on failure, named explicitly:**
- `pollInstantlyLeadStatus` returns its `result` object regardless of error count
  ([instantly.ts:696](src/lib/integrations/polling/instantly.ts#L696)).
- `setCursorSuccess` at [instantly.ts:678](src/lib/integrations/polling/instantly.ts#L678)
  runs after any number of per-campaign HTTP failures.
- The Sentry cron check-in is stamped `'ok'` unconditionally at
  [route.ts:194](src/app/api/cron/instantly-poll/route.ts#L194) — `totalErrors` is
  computed at [route.ts:171](src/app/api/cron/instantly-poll/route.ts#L171) and is
  used for the DB heartbeat at [route.ts:182](src/app/api/cron/instantly-poll/route.ts#L182)
  but never for the check-in status.
- The HTTP response is `{ ok: true, ... }` at [route.ts:196-200](src/app/api/cron/instantly-poll/route.ts#L196),
  always, whatever `totalErrors` is.

The one place errors do surface is `cron_heartbeats.ok`
([route.ts:182-192](src/app/api/cron/instantly-poll/route.ts#L182)), read by the
`mon_002` view ([20260807T000000_create_monitor_tables.sql:133-147](supabase/migrations/20260807T000000_create_monitor_tables.sql#L133)).
Note what `mon_002` measures: `MAX(ran_at)` freshness with a 30-minute threshold, and
it surfaces `detail` only via `MAX(CASE WHEN ok = false THEN detail END)` over all
history — so a job that runs on time and errors every time reads as `OK` on freshness
with a stale failure string attached. A job that runs on time and *silently finds
nothing* reads as fully green.

---

## B. INTERPRETATION

### B1. Which field detects a bounce, and what values are compared

**No field is read, and no value is compared. There is no local bounce detection.**

The code sends `status: '-2'` as a *server-side filter*
([instantly.ts:625](src/lib/integrations/polling/instantly.ts#L625)) and then writes an
`email_bounced` signal for **every row the server returns**, without inspecting any
field on those rows other than `id`
([instantly.ts:647-666](src/lib/integrations/polling/instantly.ts#L647)):

```ts
for (const lead of leads) {
  const l = lead as Record<string, unknown>
  const leadId = l.id as string | undefined
  if (!leadId) { ...continue }
  const outcome = await writeSignal(supabase, {
    ...
    signal_type: signalType,
    external_event_id: leadId,
    raw_data: l as Json,
  })
```

`l.status` is never read. `l.lt_interest_status` is never read. The classification is
100% delegated to whatever the server did with the filter.

The test suite asserts a mechanism that **does not exist in the shipped code**.
[instantly.test.ts:60](src/lib/integrations/polling/instantly.test.ts#L60) states:

```
// Mechanism: if (lead.status === INSTANTLY_LEAD_STATUS_BOUNCED) → write email_bounced signal
```

and [instantly.test.ts:54-63](src/lib/integrations/polling/instantly.test.ts#L54) then
verifies that comparison against a hand-built object literal. There is no such `if` in
[instantly.ts](src/lib/integrations/polling/instantly.ts). Every test in that file
exercises constants or re-implemented expressions; not one calls
`pollInstantlyLeadStatus`. The suite would stay green through any change to the
polling logic whatsoever.

**Against the ground truth for this audit, the two constants are inverted.**
Ground truth: `status` is `-1 Bounced`, `-2 Unsubscribed`.
Code: `INSTANTLY_LEAD_STATUS_BOUNCED = '-2'`, `INSTANTLY_LEAD_STATUS_UNSUBSCRIBED = '-1'`
([instantly.ts:49-50](src/lib/integrations/polling/instantly.ts#L49)).

Because the code trusts the filter and never re-checks, the consequence is not "no
data" but **mislabelled data**: the bounce poll asks for status `-2` (really
Unsubscribed) and stamps those leads `email_bounced`; the unsubscribe poll asks for
status `-1` (really Bounced) and stamps those leads `lead_unsubscribed`. Every real
bounce lands in the system labelled as an unsubscribe, and every real unsubscribe lands
labelled as a bounce. A local `l.status` check would have caught this the first time it
ran; there is no such check.

`INSTANTLY_LEAD_STATUS_VERIFIED = false` at
[instantly.ts:54](src/lib/integrations/polling/instantly.ts#L54) does nothing except
emit a `logger.warn` on every run ([instantly.ts:567-576](src/lib/integrations/polling/instantly.ts#L567)).
It gates no behaviour. Polling proceeds identically whether the flag is true or false.

### B2. Is `lt_interest_status` read and compared against -1 or -2?

**No.** It is never read anywhere in the repo. Every occurrence is a write, a mock, a
test assertion on a request body, or a comment — the table in section 0 is exhaustive.
There is therefore **no wrong-axis read** to report.

There is a wrong-axis *risk* the other way around, worth naming because the two axes
share values: the suppression write sends `lt_interest_status: -1`
([reply-actions.ts:53](src/lib/integrations/handlers/instantly/reply-actions.ts#L53)),
which under the ground-truth enum means **Not Interested** — the intended meaning, and
what the comment at [reply-actions.ts:11-13](src/lib/integrations/handlers/instantly/reply-actions.ts#L11)
claims. **That write is correct.** But `-1` on the `status` axis means Bounced, and the
polling constants use `-1` for Unsubscribed. Three different meanings for `-1` are live
in this codebase at once, in files that import from each other, with no type or named
enum separating them. That is how the inversion in B1 survived review.

### B3. Does anything attempt to WRITE `status`?

**No.** Every serialised request body in the Instantly integration was enumerated:

- [reply-actions.ts:53](src/lib/integrations/handlers/instantly/reply-actions.ts#L53) — `{ lt_interest_status: -1 }`
- [reply-actions.ts:110](src/lib/integrations/handlers/instantly/reply-actions.ts#L110) — thread reply body
- [uploadLeads.ts:45-58](src/lib/integrations/handlers/instantly/uploadLeads.ts#L45) — lead upload body, no status field
- [orderMailboxes.ts:84](src/lib/integrations/handlers/instantly/orderMailboxes.ts#L84) — DFY order
- [syncSequenceShell.ts:208](src/lib/integrations/handlers/instantly/syncSequenceShell.ts#L208) — campaign sequence PATCH
- [instantly.ts:400](src/lib/integrations/polling/instantly.ts#L400) — the lead-list POST **body**, where `status` is a query filter on a list endpoint, not a field update on a lead resource
- [process-reply.ts:137](src/lib/reply-handling/process-reply.ts#L137) — `{ email, limit: 1 }` lead lookup

No PATCH or PUT anywhere sets `status` on a lead. The `readOnly` constraint is not
violated.

---

## C. PERSISTENCE

### C1. Table and column

Table `signals`. The write, verbatim
([instantly.ts:275-286](src/lib/integrations/polling/instantly.ts#L275)):

```ts
const { error } = await supabase.from('signals').insert({
  organisation_id: params.organisation_id,
  campaign_id: params.campaign_id,
  prospect_id: params.prospect_id,
  signal_type: params.signal_type,
  source: params.source,
  external_event_id: params.external_event_id,
  raw_data: params.raw_data,
  processed: false,
  original_outbound_body: params.original_outbound_body ?? null,
  original_outbound_message_id: params.original_outbound_message_id ?? null,
})
```

The bounce outcome is carried by `signals.signal_type = 'email_bounced'`, with the
full Instantly lead object preserved in `signals.raw_data`
([instantly.ts:665](src/lib/integrations/polling/instantly.ts#L665)). Both
`'email_bounced'` and `'lead_unsubscribed'` are permitted by the CHECK constraint at
[20260502_signals_signal_type_constraint.sql:37-38](supabase/migrations/20260502_signals_signal_type_constraint.sql#L37),
so the insert is not blocked.

`prospect_id` is written as **`null`** ([instantly.ts:661](src/lib/integrations/polling/instantly.ts#L661)),
with the comment on the reply path explaining why:
"prospect linkage is downstream signal processing concern"
([instantly.ts:511](src/lib/integrations/polling/instantly.ts#L511)). No downstream
processing exists for these two types (section D), so the link is never made. **A
stored bounce signal contains no reference to the prospect that bounced** other than
whatever email address happens to be inside the `raw_data` blob.

**No column on `prospects` records a bounce.** The full `prospects` row type
([types/database.ts:1340-1418](src/types/database.ts#L1340)) has `email_status`,
`independent_email_status`, `email_send_eligible`, `suppressed`, `suppressed_at`,
`suppression_reason` — and none of them is written by this path.

### C2. Is the written value derived from the validated value?

I assumed it was broken here, as instructed, and looked for the transform. **The
answer is worse than a mismatched transform: there is no transform, because there is
no validation of a retrieved value at all.**

Walk it:

1. The constant `INSTANTLY_LEAD_STATUS_BOUNCED = '-2'` is defined at
   [instantly.ts:49](src/lib/integrations/polling/instantly.ts#L49).
2. It is validated — by unit tests, at
   [instantly.test.ts:15-16](src/lib/integrations/polling/instantly.test.ts#L15)
   (`expect(INSTANTLY_LEAD_STATUS_BOUNCED).toBe('-2')`). That test validates that a
   constant equals its own literal. It touches no API response.
3. The constant is passed into `pollInstantlyLeadStatus` as `instantlyStatus`
   ([route.ts:100](src/app/api/cron/instantly-poll/route.ts#L100) →
   [instantly.ts:564](src/lib/integrations/polling/instantly.ts#L564)).
4. It leaves the process in the request body
   ([instantly.ts:625](src/lib/integrations/polling/instantly.ts#L625)) and is **never
   referenced again**.
5. The value that gets written is `signalType` — a **separate parameter**
   ([instantly.ts:565](src/lib/integrations/polling/instantly.ts#L565)), hardcoded as
   the literal `'email_bounced'` at [route.ts:101](src/app/api/cron/instantly-poll/route.ts#L101),
   passed straight through to the insert at
   [instantly.ts:662](src/lib/integrations/polling/instantly.ts#L662).

So: **the value validated (`'-2'`) and the value written (`'email_bounced'`) are
different variables with no data dependency between them.** Their correspondence is
maintained only by the pairing at the two call sites,
[route.ts:100-101](src/app/api/cron/instantly-poll/route.ts#L100) and
[route.ts:114-115](src/app/api/cron/instantly-poll/route.ts#L114). Nothing in the type
system, the validator, or the runtime couples them. Per the ground truth those two
pairings are exactly the ones that are inverted (B1), and the entire test suite passes
regardless.

The sharpest consequence: **if the `status` filter is not honoured by the server — key
ignored, string not coerced, wrong param name — `/leads/list` returns the campaign's
leads unfiltered, and this loop stamps every one of them `email_bounced`.** There is no
guard against that. It is not a hypothetical class of bug; it is the direct
consequence of writing a classification the response was never inspected to justify.

### C3. Idempotency across repeated polls

Partially, with one collision that matters.

The mechanism is the partial unique index at
[20260428_instantly_polling.sql:85-87](supabase/migrations/20260428_instantly_polling.sql#L85):

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_idempotency
  ON signals (organisation_id, source, external_event_id)
  WHERE source IS NOT NULL AND external_event_id IS NOT NULL;
```

caught at [instantly.ts:290-291](src/lib/integrations/polling/instantly.ts#L290):

```ts
// Unique constraint violation = idempotency fired = already written. Not an error.
if (error.code === '23505') return 'skipped'
```

Both key columns are populated on this path — `source` is the module constant
`'instantly'` ([instantly.ts:46](src/lib/integrations/polling/instantly.ts#L46),
[instantly.ts:663](src/lib/integrations/polling/instantly.ts#L663)) and
`external_event_id` is the Instantly lead UUID
([instantly.ts:664](src/lib/integrations/polling/instantly.ts#L664)). Re-polling the
same bounced lead on the next 15-minute run is a clean no-op counted as `skipped`.
**Repeat-poll idempotency: yes.**

**But `signal_type` is not in the index.** The bounce poll and the unsubscribe poll
both key on the same namespace — the lead UUID. A lead that is both bounced and
unsubscribed in Instantly can only ever produce **one** signal row: whichever poll runs
first wins, and the second is silently swallowed as `'skipped'`, indistinguishable in
the counters from an ordinary already-seen row. Bounces run first
([route.ts:96-107](src/app/api/cron/instantly-poll/route.ts#L96)) and unsubscribes
second ([route.ts:110-121](src/app/api/cron/instantly-poll/route.ts#L110)), so a
bounce-then-unsubscribe lead loses the unsubscribe. Given the inversion in B1, in
practice it is the *real unsubscribe* filter that runs first and the *real bounce*
filter that gets swallowed.

Separately: the index key is only ever computed from `l.id`
([instantly.ts:649](src/lib/integrations/polling/instantly.ts#L649)). If Instantly
were to reassign or re-create lead UUIDs, deduplication silently breaks — but that
would produce duplicates, which is the safe direction.

---

## D. EFFECT

### D1. What is supposed to happen to a bounced lead

The intended design is written down, unambiguously, and unbuilt.
[docs/BACKLOG.md:652-654](docs/BACKLOG.md#L652), under a `[c0-blocker]` tag:

```
6. Wire consumers:
   - email_bounced signal → update prospect.bounced=true, exclude from send_eligible checks
   - lead_unsubscribed signal → update prospect.suppressed=true (same as reply opt-out)
```

and [docs/BACKLOG.md:658-659](docs/BACKLOG.md#L658):

```
Gap C (auto-pause at 2% bounce rate): defer to pre-c1. At c0, operator watches bounced_count
on dashboard and pauses campaigns manually. Build detection+exclusion at dry run; automation deferred.
```

So: a `bounced` flag on `prospects`, exclusion from send eligibility, and manual
campaign pausing at c0. `prospects.bounced` does not exist in the schema
([types/database.ts:1340-1418](src/types/database.ts#L1340) — no such column). None of
step 6 is built.

`docs/integrations.md`, `docs/signals.md` and `docs/reply-handling.md` contain **zero
occurrences** of "bounce" or "unsubscrib". The intent lives only in BACKLOG and in
source comments.

### D2. Does the send/upload path read the flag?

**The flag is written and read by no gate.** In those words, because that is exactly
the state.

The evidence is a complete enumeration of readers of `signals` for these types.
Every consumer of the `signals` table in the repo:

| Reader | Filter |
|---|---|
| [process-reply.ts:792-798](src/lib/reply-handling/process-reply.ts#L792) | `.eq('signal_type', 'reply_received')` |
| [campaign-metrics.ts:35](src/lib/metrics/campaign-metrics.ts#L35) | positive-reply count |
| [get-client-visible-campaign-metrics.ts:53,102](src/lib/metrics/get-client-visible-campaign-metrics.ts#L53) | positive-reply / meeting counts |
| [send-approved-draft.ts:163](src/lib/reply-handling/send-approved-draft.ts#L163) | reply draft path |
| [signals/page.tsx:23-31](src/app/dashboard/operator/signals/page.tsx#L23) | unfiltered display, last 200 |
| [polling/instantly.ts:275](src/lib/integrations/polling/instantly.ts#L275) | the writer |

The only signal processor, `processReplies`, filters to `reply_received` and nothing
else ([process-reply.ts:795](src/lib/reply-handling/process-reply.ts#L795)). A grep for
`email_bounced` and `lead_unsubscribed` across the whole repo returns the writer, the
route's two call sites, the CHECK constraint, comments, and the tests — **no consumer**.

The send path reads a different flag entirely. `handleUploadLeads`
([actions.ts:219](src/app/dashboard/operator/clients/[id]/actions.ts#L219)) gates on
`prospects.suppressed` twice:

```ts
.eq('suppressed', false)                       // Suppression gate     // actions.ts:277
```

```ts
.or('suppressed.eq.true,client_review_status.eq.rejected')             // actions.ts:617
```

That gate is real and it works — but **nothing on the bounce path ever sets
`prospects.suppressed`.** The writers of that column are
[process-reply.ts:571-581](src/lib/reply-handling/process-reply.ts#L571) (reply-based
opt-out), [prospects/[id]/reject/route.ts:42-43](src/app/api/dashboard/client/prospects/[id]/reject/route.ts#L42)
(client rejection), and
[prospect-research-agent-v2.ts:191-196](src/lib/agents/prospect-research-agent-v2.ts#L191)
(research disqualification). Not the poller.

So the full effect of a bounce signal today is: a row in `signals` with
`processed = false`, forever. It will never be marked processed —
`markSignalProcessed` ([process-reply.ts:250-262](src/lib/reply-handling/process-reply.ts#L250))
is only called from the reply processor, which never selects these rows. The
`signals.processed` column accumulates permanently-false bounce rows with nothing
watching the count.

**A bounced address is re-uploadable and re-sendable indefinitely.** Nothing in
`handleUploadLeads` ([actions.ts:262-278](src/app/dashboard/operator/clients/[id]/actions.ts#L262))
consults `signals`, and Instantly-side dedup relies on
`skip_if_in_workspace: true, skip_if_in_campaign: true`
([uploadLeads.ts:56-57](src/lib/integrations/handlers/instantly/uploadLeads.ts#L56)),
which prevents re-adding the same lead but says nothing about bounce history.

There is one **independent** bounce path that does reach a human, and it does not use
`signals` at all. `fetchCampaignStats` reads `bounced_count` from
`GET /campaigns/analytics` ([campaign-analytics.ts:30-32,93](src/lib/integrations/handlers/instantly/campaign-analytics.ts#L30)),
the route writes it to `campaigns.bounced_count`
([route.ts:144-152](src/app/api/cron/instantly-poll/route.ts#L144)), and the operator
panel renders a rate and a banner above 2%
([CampaignMetricsPanel.tsx:33,79-85](src/components/dashboard/operator/CampaignMetricsPanel.tsx#L33)).
That path works. It is aggregate-only — it can tell you the campaign is bouncing, never
which address bounced — and it is display-only. `TIER1_BENCHMARKS.bounceRate`
([tier1-benchmarks.ts:55-62](src/lib/benchmarks/tier1-benchmarks.ts#L55)) is defined
and never evaluated: [BenchmarksView.tsx](src/components/dashboard/benchmarks/BenchmarksView.tsx)
consumes `replyRate`, `meetingBookingRate` and `positiveReplyRate` only. No auto-pause
exists anywhere (grep for `auto.?pause|pauseCampaign` returns nothing in the send or
monitor path).

### D3. Same trace for unsubscribed

Two distinct unsubscribe paths exist, and only one of them works.

**Path 1 — reply-based opt-out. Works.** A prospect replying "stop" produces a
`reply_received` signal, is classified, and reaches the suppress branch at
[process-reply.ts:534](src/lib/reply-handling/process-reply.ts#L534). It writes the DB
flag ([process-reply.ts:571-581](src/lib/reply-handling/process-reply.ts#L571)):

```ts
if (prospectId) {
  await supabase
    .from('prospects')
    .update({
      suppressed: true,
      suppressed_at: new Date().toISOString(),
      suppression_reason: 'explicit_opt_out',
      updated_at: new Date().toISOString(),
    })
    .eq('id', prospectId)
}
```

and pushes to Instantly via `suppressLead`
([process-reply.ts:546](src/lib/reply-handling/process-reply.ts#L546) →
[reply-actions.ts:31-73](src/lib/integrations/handlers/instantly/reply-actions.ts#L31)).
That `suppressed` flag is then honoured by both send gates
([actions.ts:277](src/app/dashboard/operator/clients/[id]/actions.ts#L277),
[actions.ts:617](src/app/dashboard/operator/clients/[id]/actions.ts#L617)) and by
sourcing dedupe ([dedupe-verdict.ts:60,80,101](src/lib/sourcing/dedupe-verdict.ts#L60)).
End to end, this one closes.

Two documented soft spots in it, both by design and both logged:
`suppressResult` is forced to `ok: true` when the Instantly lead ID cannot be resolved
([process-reply.ts:557](src/lib/reply-handling/process-reply.ts#L557)) — DB suppression
is treated as authoritative, which is defensible and is explained at
[process-reply.ts:553-556](src/lib/reply-handling/process-reply.ts#L553). And when no
prospect row matches the replying address, DB suppression is skipped entirely with only
a `logger.error` ([process-reply.ts:561-570](src/lib/reply-handling/process-reply.ts#L561)).

**Path 2 — Instantly-status-based unsubscribe. Dead, exactly like bounce.**
`pollInstantlyLeadStatus(..., INSTANTLY_LEAD_STATUS_UNSUBSCRIBED, 'lead_unsubscribed')`
([route.ts:111-116](src/app/api/cron/instantly-poll/route.ts#L111)) writes a
`lead_unsubscribed` signal row and stops. No consumer. No `prospects.suppressed` write.
No send gate reads it. Identical dead end to D2, with the same
`prospect_id = null` ([instantly.ts:661](src/lib/integrations/polling/instantly.ts#L661))
making after-the-fact reconciliation harder.

The legal exposure, stated precisely: **someone who unsubscribes through Instantly's own
unsubscribe link — rather than by replying — is recorded nowhere that any send gate
consults, and remains fully eligible for the next upload.** Every send does carry
"Not for you? Just reply stop." ([opt-out-footer.ts](src/lib/composition/opt-out-footer.ts),
appended per CLAUDE.md at composition), so the reply route is the one being advertised.
That reduces how often path 2 is the only record, but it does not close it: Instantly's
own unsubscribe mechanism and any list-unsubscribe header are outside the reply
classifier's reach.

Whether path 2 is currently *storing* anything at all is contingent on everything in
sections A and B — the endpoint shape, the param names, the string-vs-integer filter,
and the pagination nesting, none of which is verified.

---

## E. SCHEDULING — every statement below is UNVERIFIED

**UNVERIFIED.** Everything in this section is read from migration files in the repo.
A migration file is a record of intent, not evidence that a job exists in the live
database, that it was ever applied, that it still has the schedule shown, or that it
has not been rescheduled by hand since. Neither migration carries the
`-- Status: APPLIED (verified live YYYY-MM-DD)` marker that CLAUDE.md requires
(`grep -n "Status:"` on both files returns nothing). I did not query `cron.job`.

### E1. What the migrations CLAIM

**Job `instantly-poll`** — [20260428_instantly_polling.sql:204-217](supabase/migrations/20260428_instantly_polling.sql#L204):

```sql
SELECT cron.schedule(
  'instantly-poll',
  '*/15 * * * *',
  $$
  SELECT
      net.http_post(
      url     := current_setting('app.polling_endpoint_url', true),
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'Authorization', 'Bearer ' || current_setting('app.cron_secret', true)
                 ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
```

- Job name: `instantly-poll` — **UNVERIFIED**
- Schedule: `*/15 * * * *` — **UNVERIFIED**
- Token in the committed SQL: read via `current_setting('app.cron_secret', true)`, **not** hardcoded — **UNVERIFIED**

**Job `process-replies`** — [20260429_reply_handling.sql:155-168](supabase/migrations/20260429_reply_handling.sql#L155):
same structure, name `process-replies`, schedule `*/5 * * * *`, URL from
`current_setting('app.process_replies_endpoint_url', true)`, token from
`current_setting('app.cron_secret', true)`, 55s timeout. **UNVERIFIED.**

### The hardcoded-token question, which is where the migrations undercut themselves

Both files carry a header stating that the `current_setting()` form **does not work**
on this Supabase tier, and instructing a manual reschedule with the secret inline.
[20260428_instantly_polling.sql:11-31](supabase/migrations/20260428_instantly_polling.sql#L11):

```
--   SUPABASE HOBBY LIMITATION (discovered 2026-04-29):
--   ALTER DATABASE postgres SET "app.*" requires superuser / supabase_admin role.
...
--   WORKING PATTERN ON HOBBY TIER:
--   After applying this migration, immediately reschedule the cron job with the URL
--   and CRON_SECRET hardcoded directly in the cron.schedule() command:
--
--     SELECT cron.unschedule('instantly-poll');
--     SELECT cron.schedule(
--       'instantly-poll', '*/15 * * * *',
--       $cmd$
--       SELECT net.http_post(
--         url     := 'https://margenticos-platform.vercel.app/api/cron/instantly-poll',
--         headers := '{"Content-Type":"application/json","Authorization":"Bearer <CRON_SECRET>"}'::jsonb,
```

with the rationale at [20260428_instantly_polling.sql:42-43](supabase/migrations/20260428_instantly_polling.sql#L42):
"The migration file intentionally uses current_setting() to avoid committing the secret
to git — reschedule manually after applying."
[20260429_reply_handling.sql:15-28](supabase/migrations/20260429_reply_handling.sql#L15)
says the same for `process-replies`.

So the committed SQL is clean, and the committed SQL is documented as non-functional.
**Whether the live jobs carry a hardcoded Bearer token in `cron.job.command` is
UNVERIFIED, and the repo's own instructions say they should.** No later migration
re-schedules either job (`grep` across `supabase/migrations/` for `instantly-poll` and
`process-replies` returns only the two originals plus monitor views and comments).

What would answer all of E1: `SELECT jobname, schedule, command FROM cron.job WHERE jobname IN ('instantly-poll','process-replies');`
run against the live database — with the caveat that the returned `command` will contain
the secret in plaintext if it was hardcoded, so it must not be pasted anywhere.

---

## F. DISPATCH MODE

### F1. `shouldUseMockDispatch` and every caller

Defined at [constants.ts:48-50](src/lib/integrations/handlers/instantly/constants.ts#L48):

```ts
export function shouldUseMockDispatch(isActive: boolean): boolean {
  return !isActive && !process.env.INSTANTLY_API_BASE_URL
}
```

It reads **no DB flag itself**. It is a pure function of its argument and one env var.
The DB read is upstream, in `getInstantlyApiActive`
([auth.ts:42-62](src/lib/integrations/handlers/instantly/auth.ts#L42)):

```ts
if (process.env.INSTANTLY_API_ACTIVE !== undefined) {
  return process.env.INSTANTLY_API_ACTIVE === 'true'
}
...
const { data } = await supabase
  .from('integrations_registry')
  .select('is_active')
  .eq('capability', 'instantly_api_active')
  .eq('tool_name', 'instantly')
  .maybeSingle()

return data?.is_active ?? false
```

**The flag is `integrations_registry.is_active` on the single row where
`capability = 'instantly_api_active'` and `tool_name = 'instantly'`.** That query has
no `organisation_id` predicate. There is one row for the entire system. **The
mock/real decision is global, not per-organisation, and is made at a different layer
from anything that knows which client it is acting for.**

Every caller (`grep` result, production code only):

| File:line | Call site |
|---|---|
| [polling/instantly.ts:197](src/lib/integrations/polling/instantly.ts#L197), [216](src/lib/integrations/polling/instantly.ts#L216) | `fetchOutboundEmailBody` guard + dispatch |
| [polling/instantly.ts:330](src/lib/integrations/polling/instantly.ts#L330), [336](src/lib/integrations/polling/instantly.ts#L336) | `instantlyGet` guard + dispatch |
| [polling/instantly.ts:385](src/lib/integrations/polling/instantly.ts#L385), [390](src/lib/integrations/polling/instantly.ts#L390) | **`instantlyPost` — the bounce/unsub path** |
| [campaign-analytics.ts:44](src/lib/integrations/handlers/instantly/campaign-analytics.ts#L44), [49](src/lib/integrations/handlers/instantly/campaign-analytics.ts#L49) | `fetchCampaignStats` |
| [reply-actions.ts:38](src/lib/integrations/handlers/instantly/reply-actions.ts#L38), [43](src/lib/integrations/handlers/instantly/reply-actions.ts#L43) | `suppressLead` |
| [reply-actions.ts:95](src/lib/integrations/handlers/instantly/reply-actions.ts#L95), [100](src/lib/integrations/handlers/instantly/reply-actions.ts#L100) | `sendThreadReply` |
| [orderMailboxes.ts:54](src/lib/integrations/handlers/instantly/orderMailboxes.ts#L54), [74](src/lib/integrations/handlers/instantly/orderMailboxes.ts#L74) | DFY mailbox order |
| [uploadLeads.ts:41](src/lib/integrations/handlers/instantly/uploadLeads.ts#L41), [61](src/lib/integrations/handlers/instantly/uploadLeads.ts#L61) | **`uploadLeads` — the send path** |
| [validateCampaign.ts:30](src/lib/integrations/handlers/instantly/validateCampaign.ts#L30), [35](src/lib/integrations/handlers/instantly/validateCampaign.ts#L35) | campaign validation |
| [syncSequenceShell.ts:150](src/lib/integrations/handlers/instantly/syncSequenceShell.ts#L150), [198](src/lib/integrations/handlers/instantly/syncSequenceShell.ts#L198) | sequence shell sync |
| [process-reply.ts:126](src/lib/reply-handling/process-reply.ts#L126), [132](src/lib/reply-handling/process-reply.ts#L132) | `resolveInstantlyLeadId` |

Every one follows the same two-step shape: a guard that throws `InstantlyFlagError`
when the flag is off *and* the base URL still points at production, then a branch
choosing mock or real fetch.

### F2. The DRY RUN TEST org, per possible flag value

No database was queried. What the code does with each value, on the send path
(`handleUploadLeads` → `uploadLeads`, [actions.ts:691](src/app/dashboard/operator/clients/[id]/actions.ts#L691)
→ [uploadLeads.ts:35-75](src/lib/integrations/handlers/instantly/uploadLeads.ts#L35)):

| `is_active` | `INSTANTLY_API_BASE_URL` | Code path | Real email possible? |
|---|---|---|---|
| `true` | unset | `shouldUseMockDispatch` → false; real `fetch` to `https://api.instantly.ai/api/v2/leads/add` ([uploadLeads.ts:65](src/lib/integrations/handlers/instantly/uploadLeads.ts#L65)) | **YES** |
| `true` | set | real `fetch` to that URL ([constants.ts:30](src/lib/integrations/handlers/instantly/constants.ts#L30)) | Yes, if it is Instantly |
| `false` / row missing | unset | `shouldUseMockDispatch` → true → `mockLeadsAdd` ([uploadLeads.ts:61-62](src/lib/integrations/handlers/instantly/uploadLeads.ts#L61)); zero network calls | **No** |
| `false` | set to `api.instantly.ai` | guard fires, `InstantlyFlagError` thrown ([uploadLeads.ts:41-43](src/lib/integrations/handlers/instantly/uploadLeads.ts#L41)) | No — hard fail |
| `false` | set to a non-Instantly host | guard's `baseUrl.includes('api.instantly.ai')` is false → real `fetch` to that host | No |

**The organisation is not an input to any row of that table.** `uploadLeads` receives
`organisationId` ([uploadLeads.ts:30](src/lib/integrations/handlers/instantly/uploadLeads.ts#L30))
and uses it only for `getInstantlyApiKey(organisationId)`
([uploadLeads.ts:35](src/lib/integrations/handlers/instantly/uploadLeads.ts#L35)) —
which itself **ignores the parameter** and returns the one global key
([auth.ts:11-38](src/lib/integrations/handlers/instantly/auth.ts#L11), signature
`_organisationId`). Nothing named `dry_run`, `test_mode`, or equivalent exists on
`organisations` ([grep for `dry.?run` across `src/` returns only test files and script
constants](docs/audits/bounce-path-2026-08-21.md)).

So, answering directly: **if `instantly_api_active` is true, a real email can leave the
system for the DRY RUN TEST org exactly as readily as for any paying client.** The only
thing standing between that org and a live send is whether it has approved, tiered,
non-suppressed prospects and a synced campaign shell
([actions.ts:262-278](src/app/dashboard/operator/clients/[id]/actions.ts#L262)) — and
`handleUploadLeads` contains **no `archived_at` gate at all**, unlike the poller
([instantly.ts:589](src/lib/integrations/polling/instantly.ts#L589)) and unlike the
reply processor ([process-reply.ts:313-319](src/lib/reply-handling/process-reply.ts#L313)).
Being archived stops that org from being polled. It does not stop it from being sent to.

---

## Defects found

Ordered by whether the defect causes a bounce to be **missed silently**. Everything
above the line is a silent-miss mechanism; below it, defects that are loud, harmless
today, or non-bounce.

### Silent misses — a bounce disappears with no error, no log, no counter

**1. Bounce and unsubscribe status constants are inverted against the API enum.**
[instantly.ts:49-50](src/lib/integrations/polling/instantly.ts#L49). Code says
BOUNCED `'-2'` / UNSUBSCRIBED `'-1'`; ground truth is `-1 Bounced` / `-2 Unsubscribed`.
Every real bounce is stored as `lead_unsubscribed` and every real unsubscribe as
`email_bounced`. Nothing detects the swap because nothing reads the returned lead's
status (defect 2). Any bounce metric built on `signals` would be counting the wrong
population.

**2. No local verification of the returned lead's status — the classification is 100%
delegated to a request filter.** [instantly.ts:647-666](src/lib/integrations/polling/instantly.ts#L647)
reads only `l.id`; `l.status` is never inspected. This is the root cause that lets
defect 1, defect 3, and defect 4 all fail invisibly, and it is also what would turn an
ignored filter into mass false positives: if `/leads/list` does not honour `status`,
every lead in the campaign is written as `email_bounced`.

**3. The `status` filter is sent as a JSON string where the schema types it as an
integer.** [instantly.ts:49-50](src/lib/integrations/polling/instantly.ts#L49) →
[instantly.ts:625](src/lib/integrations/polling/instantly.ts#L625) →
[instantly.ts:400](src/lib/integrations/polling/instantly.ts#L400). Wire body is
`{"status":"-2",...}`. If the server rejects it: 400 → non-fatal `break` → run still
reports success (defect 6). If the server ignores it: see defect 2.
[instantly.test.ts:37-46](src/lib/integrations/polling/instantly.test.ts#L37) actively
locks the string type in, on an unsourced premise.

**4. Pagination cursor is read from a nested `pagination.next_starting_after`.**
[instantly.ts:315-317](src/lib/integrations/polling/instantly.ts#L315). If the real
shape is top-level, the loop breaks after page one and **every bounced lead past the
first 100 in a campaign is invisible** — roughly 5,000 sent emails at a 2% bounce rate.
Silent: no log distinguishes "cursor absent" from "last page".

**5. A 200 response whose payload shape the parser does not recognise reads as zero
bounces, forever.** [instantly.ts:311-314](src/lib/integrations/polling/instantly.ts#L311)
returns `[]` for anything that is neither a bare array nor has `items`, and
[instantly.ts:645](src/lib/integrations/polling/instantly.ts#L645) treats `[]` as end
of results. Indistinguishable from a genuinely clean campaign.

**6. Per-campaign HTTP failures still stamp the polling cursor as a clean success.**
[instantly.ts:633-643](src/lib/integrations/polling/instantly.ts#L633) logs and
`break`s; [instantly.ts:678](src/lib/integrations/polling/instantly.ts#L678) then runs
`setCursorSuccess`, which writes `error_count: 0, last_error: null`
([instantly.ts:134-135](src/lib/integrations/polling/instantly.ts#L134)). A run where
every campaign 401'd looks, in `polling_cursors`, exactly like a run that found nothing.
No `Sentry.captureException` on this path either — contrast
[instantly.ts:296-299](src/lib/integrations/polling/instantly.ts#L296).

**7. The Sentry cron check-in and the HTTP response are hardcoded to success.**
[route.ts:194](src/app/api/cron/instantly-poll/route.ts#L194) sends `status: 'ok'` and
[route.ts:196](src/app/api/cron/instantly-poll/route.ts#L196) returns `{ ok: true }`,
both regardless of `totalErrors` computed at
[route.ts:171](src/app/api/cron/instantly-poll/route.ts#L171). Only
`cron_heartbeats.ok` reflects errors ([route.ts:182](src/app/api/cron/instantly-poll/route.ts#L182)),
and `mon_002` ([20260807T000000_create_monitor_tables.sql:133-147](supabase/migrations/20260807T000000_create_monitor_tables.sql#L133))
grades primarily on run freshness. A poller that runs punctually and finds nothing is
green on every instrument.

**8. No request timeout on the polling fetches.**
[instantly.ts:394-401](src/lib/integrations/polling/instantly.ts#L394) and
[instantly.ts:347-352](src/lib/integrations/polling/instantly.ts#L347) pass no
`AbortSignal`; the route exports no `maxDuration`. A hung connection stalls the run
until the platform kills it, and a killed run never reaches the heartbeat insert at
[route.ts:183](src/app/api/cron/instantly-poll/route.ts#L183) — so it leaves no failure
record, only a gap.

**9. The idempotency index omits `signal_type`, so a lead that both bounces and
unsubscribes yields one row, not two.**
[20260428_instantly_polling.sql:85-87](supabase/migrations/20260428_instantly_polling.sql#L85)
keys on `(organisation_id, source, external_event_id)`; both polls use the lead UUID
([instantly.ts:664](src/lib/integrations/polling/instantly.ts#L664)). The second write
returns 23505 and is counted as `skipped`
([instantly.ts:291](src/lib/integrations/polling/instantly.ts#L291)), indistinguishable
from an ordinary duplicate. Bounces run first ([route.ts:96](src/app/api/cron/instantly-poll/route.ts#L96)),
so the later signal loses.

**10. The test suite validates constants and re-implemented expressions, never the
polling function.** [instantly.test.ts](src/lib/integrations/polling/instantly.test.ts)
(all 173 lines). [instantly.test.ts:60](src/lib/integrations/polling/instantly.test.ts#L60)
documents a mechanism — `if (lead.status === INSTANTLY_LEAD_STATUS_BOUNCED)` — that does
not exist in [instantly.ts](src/lib/integrations/polling/instantly.ts). Green tests here
are evidence of nothing about the retrieval path, which is why defects 1-6 shipped.

### Not silent, but the bounce still has no effect

**11. `email_bounced` and `lead_unsubscribed` signals are written and read by no gate.**
Enumerated in D2: `processReplies` filters to `reply_received`
([process-reply.ts:795](src/lib/reply-handling/process-reply.ts#L795)) and no other
consumer of `signals` matches these types. The send gate reads `prospects.suppressed`
([actions.ts:277](src/app/dashboard/operator/clients/[id]/actions.ts#L277),
[actions.ts:617](src/app/dashboard/operator/clients/[id]/actions.ts#L617)), which this
path never writes. Rows accumulate at `processed = false` permanently. **This is the
same state `icp_fit` is in.** Intended wiring is specified and unbuilt:
[docs/BACKLOG.md:652-654](docs/BACKLOG.md#L652).

**12. Instantly-side unsubscribes never reach any suppression gate — a compliance gap,
not just a deliverability one.** D3, path 2. Someone who uses Instantly's unsubscribe
link rather than replying "stop" produces a `lead_unsubscribed` signal that nothing
reads, and stays fully eligible for the next upload. Reply-based opt-out
([process-reply.ts:571-581](src/lib/reply-handling/process-reply.ts#L571)) is the only
route that actually suppresses, and it is the only route the footer advertises
([opt-out-footer.ts](src/lib/composition/opt-out-footer.ts)) — which narrows the
exposure without closing it.

**13. Bounce signals are stored with `prospect_id = null`.**
[instantly.ts:661](src/lib/integrations/polling/instantly.ts#L661), on the promise that
linkage is "a downstream signal processing concern"
([instantly.ts:511](src/lib/integrations/polling/instantly.ts#L511)). No downstream
processing exists (defect 11), so the link is never made and back-filling later means
re-parsing `raw_data` blobs.

**14. `TIER1_BENCHMARKS.bounceRate` is defined and never evaluated.**
[tier1-benchmarks.ts:55-62](src/lib/benchmarks/tier1-benchmarks.ts#L55);
[BenchmarksView.tsx:35-49](src/components/dashboard/benchmarks/BenchmarksView.tsx#L35)
consumes `replyRate`, `meetingBookingRate`, `positiveReplyRate` only. The sole
bounce-rate warning anywhere is a passive banner at
[CampaignMetricsPanel.tsx:79-85](src/components/dashboard/operator/CampaignMetricsPanel.tsx#L79),
driven by the *analytics* path, on the operator page, with no notification. No
auto-pause exists (BACKLOG defers it: [docs/BACKLOG.md:658-659](docs/BACKLOG.md#L658)).

**15. `handleUploadLeads` has no archived-organisation gate.**
[actions.ts:219-278](src/app/dashboard/operator/clients/[id]/actions.ts#L219). The
poller has one ([instantly.ts:589](src/lib/integrations/polling/instantly.ts#L589)) and
the reply processor has one ([process-reply.ts:313-319](src/lib/reply-handling/process-reply.ts#L313)).
Consequence for the DRY RUN TEST org: archiving removes it from polling but not from
sending, so with `instantly_api_active = true` it can emit real email while being
invisible to bounce and reply collection. Not a bounce defect on its own; it is what
makes defects 1-11 worst for exactly the org meant to be safe.

### Cosmetic

**16. The signals log has no label for the types the poller writes.**
[SignalsLogView.tsx:29](src/components/dashboard/operator/SignalsLogView.tsx#L29) maps
`email_bounce` (singular); the poller writes `email_bounced`
([route.ts:101](src/app/api/cron/instantly-poll/route.ts#L101)). `lead_unsubscribed` has
no entry either. The fallback at
[SignalsLogView.tsx:44](src/components/dashboard/operator/SignalsLogView.tsx#L44)
(`map[type] ?? type`) renders the raw string. Display only.

**17. The polling module's header comment documents a different endpoint from the one
it calls.** [instantly.ts:8-9](src/lib/integrations/polling/instantly.ts#L8) says
`GET /api/v2/lead/list?status=...`; the code does `POST /leads/list`
([instantly.ts:394](src/lib/integrations/polling/instantly.ts#L394),
[instantly.ts:631](src/lib/integrations/polling/instantly.ts#L631)). Anyone verifying
against the comment verifies the wrong call — which is a plausible route by which
defects 3 and 4 went unexamined.

---

## Open items this audit could not close

| Question | What would answer it |
|---|---|
| Does `POST /api/v2/leads/list` accept a `status` body key, and is `campaign` the right key name? | The request-body schema for that operation in the Instantly V2 OpenAPI spec, or one live call |
| Is `next_starting_after` top-level or nested under `pagination`? | Same |
| Is a string `"-2"` coerced, rejected, or ignored on the `status` filter? | Same |
| Is DRY RUN TEST currently archived? | `SELECT archived_at FROM organisations WHERE id = 'a2b621fc-4c9d-43d9-9af4-1253ff49d12d'` |
| Do the two pg_cron jobs exist live, on those schedules, with hardcoded tokens? | `SELECT jobname, schedule, command FROM cron.job WHERE jobname IN ('instantly-poll','process-replies')` — the `command` will contain the secret in plaintext if hardcoded; do not paste the result anywhere |
| Current value of `integrations_registry.is_active` for `instantly_api_active` | Deliberately not queried, per the audit brief |

No code was changed. No bug found here was fixed.

---

# Addendum — 2026-08-21, later the same day

Added after the instrumentation fix (`231351d`) and the detection fix (`fcb2f94`)
went live. Both findings below were surfaced by live evidence that the original
audit could not obtain, and **neither has been fixed.** Investigated only.

Three of the "Open items this audit could not close" above are now closed by that
evidence, and are answered inline where relevant.

---

## Addendum finding 1 — the pagination cursor is never read, on any resource

**Status: CONFIRMED LIVE.** This was audit defect 4, filed as UNVERIFIED. It is now
verified and it is real.

### Location

[src/lib/integrations/polling/instantly.ts:315-317](src/lib/integrations/polling/instantly.ts#L315),
inside `parseInstantlyResponse`:

```ts
const nextCursor: string | null =
  ((json as Record<string, unknown>)?.pagination as Record<string, unknown>)
    ?.next_starting_after as string | null ?? null
```

Consumed at [instantly.ts:673-674](src/lib/integrations/polling/instantly.ts#L673)
(lead status) and [instantly.ts:531](src/lib/integrations/polling/instantly.ts#L531)
(replies).

### Evidence

A live `POST /leads/list` against campaign `cf695496-dba1-4bcb-beae-1b6ca28209d6`
returned, verbatim at the end of the body:

```json
"items":[ ...15 lead objects... ],"next_starting_after":"01a02236-a59e-70a9-852c-6531cdf35fc5"
```

`next_starting_after` is a **top-level key, a sibling of `items`.** There is no
`pagination` object in the response at all. The parser reads
`json.pagination.next_starting_after`, a path that does not exist, so the optional
chain short-circuits and `nextCursor` is `null` on every response.

Corroborated by every production log line since per-page logging was added in
`231351d`. Across all three resources and every run:

```json
{"resource":"replies","page":1,"http_status":200,"requested":100,"returned":0,"cursor_returned":false}
{"resource":"leads_bounced","page":1,"http_status":200,"requested":100,"returned":0,"cursor_returned":false}
{"resource":"leads_unsubscribed","page":1,"http_status":200,"requested":100,"returned":0,"cursor_returned":false}
```

`cursor_returned` has never once been true.

This closes the open item "Is `next_starting_after` top-level or nested under
`pagination`?" — **top-level.**

### Impact and threshold

Both loops break on `if (!nextCursor) break`, so **every resource is capped at one
page of 100 items per run.** The 50-page ceilings
([instantly.ts:448](src/lib/integrations/polling/instantly.ts#L448),
[instantly.ts:618](src/lib/integrations/polling/instantly.ts#L618)) are unreachable
and always have been.

The break is silent. Nothing distinguishes "no cursor because this is the last page"
from "no cursor because we are reading the wrong key". A run that saw 1 of 40 pages
reports `ok: true` with `errors: 0`.

Thresholds, per resource:

| Resource | Invisible beyond | In real terms |
|---|---|---|
| `leads_bounced` | 100 bounced leads per campaign per run | ~5,000 sent at a 2% bounce rate; ~1,000 sent at a domain-damaging 10% |
| `leads_unsubscribed` | 100 unsubscribed leads per campaign per run | same arithmetic |
| `replies` | 100 replies per run (15-minute window) | unlikely to bind at current volume |

**Zero impact today.** The only live campaign holds 15 leads, so one page covers
everything and the cap has never been reached.

**This must be fixed before the 500-prospect batch.** At 500 prospects a single
campaign can exceed 100 in any of these categories, and the failure mode is the worst
one in this system: correct-looking green output with most of the data never fetched.
The fix is confined to `parseInstantlyResponse` and should read the top-level key,
with the nested path kept only as a fallback if a different endpoint ever uses it.

---

## Addendum finding 2 — campaign stats have never been written, for two unrelated reasons

**Status: CONFIRMED LIVE. Two independent defects, not one.**

`campaigns.campaign_stats_updated_at` is `NULL` for every row with a non-null
`external_id`. Live SQL:

```
external_id                                status   sent_count   campaign_stats_updated_at
b1234567-mock-4000-a000-staging000001      active   0            null
mock-campaign-1785956498252                active   0            null
cf695496-dba1-4bcb-beae-1b6ca28209d6       draft    0            null
```

### The evidence that separates the two causes

Production log line from the poll run, which is what rules out the single-cause
explanations:

```json
"campaign_stats":{"updated":0,"skipped":2,"errors":0}
```

- `errors: 0` proves `fetchCampaignStats` did **not** throw. The analytics call
  succeeds. The `response was not an array` warning at
  [campaign-analytics.ts:82](src/lib/integrations/handlers/instantly/campaign-analytics.ts#L82)
  never fires, so the response parses as an array.
- `skipped: 2` proves the loop iterated exactly **two** campaigns and
  `statsMap.get(external_id)` returned `undefined` for both
  ([route.ts:139-143](src/app/api/cron/instantly-poll/route.ts#L139)).
- Two, not three. The third campaign never reached the loop.

So the code is behaving exactly as written. The data is wrong on both sides of it.

### Problem A — `cf695496` is excluded before the lookup

**Location:** [src/app/api/cron/instantly-poll/route.ts:132-135](src/app/api/cron/instantly-poll/route.ts#L132)

```ts
.from('campaigns')
.select('id, external_id')
.eq('status', 'active')
.not('external_id', 'is', null)
```

Our local `campaigns.status` for `cf695496` is `'draft'`. Instantly reports the same
campaign as Active and sending. It is filtered out before the analytics map is
consulted.

**Evidence that the data is there and only the filter is in the way** — live
`GET /campaigns/analytics` for that campaign:

```json
{"campaign_name":"Margentic - send 1 (15 prospects)",
 "campaign_id":"cf695496-dba1-4bcb-beae-1b6ca28209d6","campaign_status":1,
 "leads_count":15,"contacted_count":15,"emails_sent_count":15,
 "reply_count":0,"bounced_count":0,"unsubscribed_count":0}
```

The row exists and carries the exact field names the handler maps at
[campaign-analytics.ts:91-93](src/lib/integrations/handlers/instantly/campaign-analytics.ts#L91).
`statsMap` contains it. Our code simply never asks for it.

**Impact.** `campaigns.bounced_count` is the only bounce number that reaches a human,
via the operator panel at
[CampaignMetricsPanel.tsx:33,79-85](src/components/dashboard/operator/CampaignMetricsPanel.tsx#L33).
And the symptom is worse than a wrong number: `hasData` is derived as `sentCount > 0`
([campaign-metrics.ts:60](src/lib/metrics/campaign-metrics.ts#L60)), so with
`sent_count = 0` the panel renders its empty placeholder
([CampaignMetricsPanel.tsx:20](src/components/dashboard/operator/CampaignMetricsPanel.tsx#L20)).
There is no campaign metrics panel at all for the only campaign that is sending.

**Threshold: already breached.** 15 leads uploaded, 15 sent.

**Do not resolve this with a manual `UPDATE campaigns SET status = 'active'`.** That
would populate the counters and make the symptom disappear while leaving the actual
defect in place: **nothing in the codebase writes `campaigns.status` when a campaign
goes live in Instantly.** The row was created `draft` and no code path has ever moved
it. A manual update fixes one row once, and the next campaign reproduces the bug
silently. The real question to answer first is which component owns that transition
and why it does not exist.

### Problem B — the two mock campaigns pass the filter and miss the lookup

**Location:** the same loop, at
[route.ts:139-143](src/app/api/cron/instantly-poll/route.ts#L139).

`b1234567-mock-4000-a000-staging000001` and `mock-campaign-1785956498252` have
`status = 'active'`, so they pass the filter in Problem A and reach the map lookup.
Their `external_id` values are not real Instantly campaign UUIDs, so the analytics
response contains no row for them, `statsMap.get()` returns `undefined`, and each
increments `skipped`. That is the `skipped: 2`.

**Impact.** Cosmetic today. These are stale test rows sitting in a production table.
They consume two iterations of the loop, contribute a misleading `skipped` count that
looks like a real miss, and would confuse anyone debugging Problem A by making the
skip counter non-zero for an unrelated reason.

**Threshold:** they become harmful the moment any code treats `skipped > 0` as a
signal, or any operator view enumerates campaigns by `status = 'active'`.

### Why both matter together

Neither defect explains the whole observation. Problem A alone would leave
`skipped: 2` unexplained. Problem B alone would leave `cf695496` unexplained. Their
union is why **no campaign has ever had stats written**, and why the audit's one
"working" bounce path (section D2 above) has in fact never produced a number.

---

## Open items from the original audit that are now closed

| Original open item | Answer | Evidence |
|---|---|---|
| Does `POST /leads/list` accept a `status` body key, and is `campaign` the right key? | **Yes to both, and the status filter is honoured.** | An unfiltered call scoped only by `campaign` returns all 15 leads, each carrying `"status": 1`. The poller's filtered call returns 0. Were `status` ignored, those same 15 rows would come back and the read-back check added in `fcb2f94` would reject all 15. It reported zero mismatches and `error_count` 0. |
| Is `next_starting_after` top-level or nested? | **Top-level.** | Addendum finding 1. |
| Is a string `"-2"` coerced, rejected, or ignored? | Still **CANNOT DETERMINE**, and now moot. | Both the old string filter and the new numeric filter returned 0 rows, which is the true answer either way — Instantly's own analytics reports `bounced_count: 0, unsubscribed_count: 0`. The string form is gone as of `fcb2f94`. |

Section B1's claim that "no field is read, and no value is compared" is **no longer
true as of `fcb2f94`**. `verifyLeadStatus` now reads the returned lead's `status` and
requires a strict numeric match before any signal is written. The rest of section B1,
including the description of how the inversion arose, stands as the historical record.

Sections C, D and E are unchanged. In particular **D2 still holds**: `email_bounced`
and `lead_unsubscribed` signals are written and read by no gate. Detection is now
correct; nothing consumes it.

No code was changed by this addendum.

---

# Addendum 2 — D2 is closed (2026-08-21)

Detection now feeds a gate. `email_bounced` and `lead_unsubscribed` signals are no
longer written and read by nothing.

## What changed

**A new table, `suppressed_emails`.** Global, keyed on a normalised email address,
separate from `prospects.suppressed`.
Migration: `supabase/migrations/20260821172500_create_suppressed_emails.sql`,
applied and verified live on 2026-08-21.

**The poller writes to it.** In `pollInstantlyLeadStatus`, immediately after the
signal write, every verified bounced or unsubscribed lead's address is recorded via
`recordSuppression()`. This runs when the signal was written AND when it was skipped
by the idempotency index, deliberately: a full-scan resource re-returns every bounced
lead on every poll, so "skipped" is the normal case on every run after the first, and
it is also what covers any signal written before this wiring existed.

**The send path reads it.** `findBlockedProspects()` in
`src/lib/suppression/send-gate.ts` is the one function that decides whether a prospect
may be sent to. It is called at both points in `handleUploadLeads`:

| Call site | Purpose | Consequence of removing it |
|---|---|---|
| `actions.ts`, before the claim | **Cost.** The final gate runs after composition, so without this we pay to compose four emails per dead address. | Money, not correctness. |
| `actions.ts`, final safety check | **Correctness.** Last checkpoint before the Instantly upload. | A suppressed address could be sent to. |

The pre-filter is a separate read placed immediately before the compare-and-set claim,
NOT inside it. An async lookup cannot go inside a CAS, and wrapping the pair in a
transaction to make it atomic would widen the very race the CAS exists to narrow. The
pre-filter's only effect is to remove ids from the claim, never to add any, so it can
never make a send less safe than it would be without it. If a suppression lands between
the pre-filter and the claim, the final gate catches it.

## The two decisions, named

**`prospects.suppressed` is a second independent gate, not derived from this table.**
It already carries four meanings that have nothing to do with deliverability: client
rejection, research disqualification, opt-out reply, and sourcing dedupe block.
Deriving it would destroy all four. Both gates are checked in one function, at one
place, so there is still exactly one chokepoint for the decision.

**`source_org_id` is `ON DELETE SET NULL`, not `CASCADE`.** Every other
organisation-referencing table here cascades. A global suppression list must not:
deleting a client would resurrect their bounced addresses as sendable. The suppression
outlives the organisation; only the provenance goes null.

## Scope, stated as limits

- **Future uploads only.** Nothing here stops an in-flight Instantly sequence.
  Instantly halts a bounced lead itself, which is where the bounce came from.
- **Service role only.** RLS enabled with zero policies, matching
  `integration_credentials`. Not even operators get a read policy. `anon` and
  `authenticated` are additionally revoked at the grant level. There is no
  client-facing surface and there must never be one.
- **No backfill.** Confirmed with live SQL before starting: zero `email_bounced` and
  zero `lead_unsubscribed` rows exist in `signals`. There was nothing to migrate.
- **`INSTANTLY_LEAD_STATUS_VERIFIED` is still `false`.** Wiring a gate to detection
  does not earn that flag. It flips only after a real bounce travels this path end to
  end.

## Correction to the pre-build survey

The working note for this build said three `prospects.suppressed` rows were true.
There are **six**, three per organisation, and none is a bounce or an unsubscribe:

| Org | Rows | `suppression_reason` | Written by |
|---|---|---|---|
| `74243c62` (old MargenticOS, archived) | 3 | `staging-test-artifact` | **Nothing in this repository.** Not in `src/`, `supabase/`, `docs/`, or any commit. All three share one timestamp to the microsecond: a single hand-written `UPDATE` on 2026-06-04, unrecorded. |
| `a2b621fc` (DRY RUN TEST, archived) | 3 | `dedupe-test: ...` | `src/lib/sourcing/test-dedupe.ts`, lines 64, 73 and 82. |

Harmless — both orgs are archived and both reason strings name themselves as test
artifacts — but the first set is an unaccounted-for direct write to a compliance
column, and it is recorded here rather than left to be rediscovered.

## Follow-up, logged not built

**Check `suppressed_emails` at sourcing, not just at send.** `dedupe-verdict.ts`
already treats a match against a suppressed prospect as a hard sourcing block
(`suppressed_match`). Consulting the global list there too would stop a known-dead
address ever being sourced, enriched or researched. That is further upstream than the
pre-filter added here and saves considerably more: enrichment and research spend, not
just composition spend. Deliberately out of scope for this build, which wired the send
gate only. Tracked in `docs/BACKLOG.md`.
