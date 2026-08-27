# Discovery: per-domain sending health

**Date:** 2026-08-27
**Type:** read-only discovery. No code written, no migration created, nothing committed.
**Question:** the ramp stop condition is "bounce rate above 2% on any single sending
domain." There is no way to see that anywhere in the product today. Can it be built, and
from what?

**Answer in one line:** yes, and more cheaply than expected. Instantly hands us bounces
broken down per mailbox per day, from a single endpoint we have never called.

---

## Terms used in this document

- **Sending domain** — one of *our* five domains that outbound email is sent *from*
  (getmargenticos.com, gomargenticos.com, inboxmargenticos.com, mailmargenticos.com,
  trymargenticos.com). Not the recipient's domain. This distinction is the whole of
  question 3.
- **Mailbox / account** — one email address on one of those domains. Instantly calls these
  "accounts". There are ten, two per domain. Mailbox addresses are redacted throughout as
  `x@domain.com` because this repo is public.
- **Bounce** — an email that could not be delivered and came back. High bounce rates
  damage a sending domain's reputation, which is why the ramp stops on them.
- **Warmup** — automated mail Instantly sends between its own users' mailboxes to build
  sending reputation. It is not campaign mail and must not be counted as campaign mail.
- **Monitor / MON-NNN** — an automated check. Each one is a database view named `mon_NNN`
  that returns OK or PROBLEM, read every 15 minutes by `/api/cron/monitor-sweep`.
- **Signal** — a row in our `signals` table recording something that happened in an
  external tool (a reply, a bounce, an unsubscribe).

---

## CORRECTION, 2026-08-27 (added during the build session)

**The claim below that merging this branch "would silently delete MON-021 and MON-022" is
wrong, and this correction is left in place rather than the paragraph quietly edited.**

Checked properly before acting on it: the merge-base is `7b77f53`, whose `monitors.ts`
ends at MON-020. `main` **added** MON-021 and MON-022 afterwards, in `46580b1`. The
branch's single commit `9977bf8` never touched `monitors.ts` at all. So git had nothing to
delete: a merge keeps main's version, and it did. `monitors.ts` merged clean with both
codes present, verified against `monitor_checks` live.

The branch was **stale, not destructive**. The original paragraph inferred a deletion from
a `git diff main -- <file>` output, which shows what the branch LACKS relative to main and
says nothing about which side changed. That is the mistake, and it is worth naming: a diff
direction was read as a causal claim.

Everything else in this report was re-checked during the build and held.

---

## Read this first: the checked-out branch is stale

Not part of the brief, but it changes what "the codebase" means and would have made this
report wrong if I had read only the working tree.

The session started on branch `sourcing-filter`. The tree was clean, so I proceeded. But:

```
$ git log --oneline main ^sourcing-filter | wc -l
10
$ git log --oneline sourcing-filter ^main
9977bf8 feat: synthesis_batches, the two tables the batch wait has to survive
```

`main` is **ten commits ahead**. This branch has one commit, and it is an earlier, smaller
version of work `main` already carries in fuller form.

Two consequences:

1. **That one commit has never been pushed.** `git status` reports "ahead of
   'origin/sourcing-filter' by 1 commit". The standing rule in CLAUDE.md is to push after
   every commit. This phase forbids pushes, so it is left alone and flagged here.

2. **Merging this branch as-is would silently delete two live monitors.** The branch's
   `src/app/api/cron/monitor-sweep/monitors.ts` stops at MON-020. `main`'s version includes
   MON-021 and MON-022:

   ```
   $ git diff main -- src/app/api/cron/monitor-sweep/monitors.ts
   -  ['MON-021', 'mon_021'],
   -  ['MON-022', 'mon_022'],
   ```

   Both views exist in the live database and both have written events (2026-08-26 21:30 and
   21:45 UTC). Merging the branch's version would recreate exactly the MON-019 failure the
   registry was rewritten to make impossible: a monitor that exists, looks registered, and
   is never read. The `monitor-sweep-pairs.test.ts` guard on `main` catches this, so it
   would fail the test suite rather than ship — the guard works. Worth knowing before
   anyone merges.

Everything below was checked against `main` where the branch differs, because `main` is
what production runs. The Instantly integration files and polling code are byte-identical
on both branches, so those findings hold either way.

---

## Question 1 — what we already have

### Is there an Instantly client wrapper?

**No.** There is no shared HTTP client. Each handler builds its own `fetch` call.

| File | What it calls |
|---|---|
| [campaign-analytics.ts:149](src/lib/integrations/handlers/instantly/campaign-analytics.ts#L149) | `GET /campaigns/analytics` |
| [campaign-sending-status.ts](src/lib/integrations/handlers/instantly/campaign-sending-status.ts) | `GET /campaigns/{id}/sending-status` |
| [validateCampaign.ts](src/lib/integrations/handlers/instantly/validateCampaign.ts) | `GET /campaigns/{id}` |
| [uploadLeads.ts](src/lib/integrations/handlers/instantly/uploadLeads.ts) | `POST /leads/add` |
| [orderMailboxes.ts](src/lib/integrations/handlers/instantly/orderMailboxes.ts) | `POST /dfy-email-account-orders` |
| [reply-actions.ts](src/lib/integrations/handlers/instantly/reply-actions.ts) | `PATCH /leads/{uuid}`, `POST /emails/reply` |
| [polling/instantly.ts:521,578](src/lib/integrations/polling/instantly.ts#L521) | `instantlyGet` / `instantlyPost` helpers, used for `/emails` and `/leads/list` |

What *is* shared: [constants.ts](src/lib/integrations/handlers/instantly/constants.ts) (base
URL, mock-vs-real dispatch) and
[auth.ts](src/lib/integrations/handlers/instantly/auth.ts) (API key from
`integration_credentials`, active flag from `integrations_registry`). A new call would
reuse those two and write its own fetch, matching every existing handler.

### Does anything already fetch accounts or per-account analytics?

**No. Nothing in the codebase has ever called an Instantly `/accounts` endpoint.**

```
$ grep -rn "'/accounts|\"/accounts|accounts/analytics|warmup" src/ --include="*.ts" --include="*.tsx" | grep -v "\.test\.ts"
```

Returns only `warmup_started_at` / `warmup_completed_at` on the `organisations` table and
the UI that displays them. Those are **a date an operator types into a form**, not data
from Instantly. See
[WarmupControlPanel.tsx:93](src/app/dashboard/operator/clients/[id]/WarmupControlPanel.tsx#L93):
"Setting this date shows the warmup progress bar and launch date on the client dashboard."

So the mailbox-level half of Instantly is completely untouched by our code.

### Does our database hold any record of our sending domains or mailboxes?

**No.** Queried rather than inferred:

```sql
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (column_name ILIKE '%mailbox%' OR column_name ILIKE '%sending%'
    OR column_name ILIKE '%sender%'  OR column_name ILIKE '%domain%'
    OR column_name ILIKE '%from_email%' OR column_name ILIKE '%email_account%'
    OR column_name ILIKE '%bounce%');
```

Result — four columns, across the whole database:

| table | column | type |
|---|---|---|
| campaigns | bounced_count | integer |
| campaigns | sending_state | text |
| campaigns | sending_status_checked_at | timestamptz |
| campaigns | sending_status_raw | text |

There is no mailbox table, no sending-domain table, and no column anywhere that names one
of our five domains. The full table list (37 tables) contains nothing resembling one.

**The five domains and ten mailboxes exist only inside Instantly.** Our database does not
know they exist. This is the single biggest structural fact in this report: any per-domain
view has to read from somewhere, and today there is nowhere to read from.

Related, from BACKLOG: ADR-017 specified a `sourced_tier` column on prospects governing
"research path, composition template, and **sending domain**". The BACKLOG entry records
plainly: *"The column was never added."*

---

## Question 2 — what Instantly actually returns

Four endpoints, called live against the production workspace on 2026-08-27. Values below
are real; mailbox local-parts are redacted.

### Summary table

| Endpoint | Bounce count? | Scope | Date range | Sends included |
|---|---|---|---|---|
| `GET /accounts` | **No** | per account | none accepted | none — no send counts at all |
| `GET /accounts/analytics/daily` | **YES** | **per account, per day** | max 31 days; `emails` filter effectively mandatory | campaign only |
| `GET /campaigns/analytics/daily` | **No** | per campaign, per day | max 31 days | campaign only |
| `POST /accounts/warmup-analytics` | **No** | per account, per day | fixed trailing 7 days, not selectable | warmup only |

### 2a. `GET /api/v2/accounts` — the mailbox inventory

Ten accounts, two per domain. One field per account that matters, plus the response shape:

```json
{ "email": "x@getmargenticos.com",
  "warmup_status": 1, "status": 1, "provider_code": 2,
  "daily_limit": 30, "setup_pending": false,
  "stat_warmup_score": 100,
  "timestamp_warmup_start": "2026-06-22T21:59:52.219Z",
  "organization": "24309665-…", "added_by": "b012e5ff-…" }
```

Confirmed exactly ten, not "at least ten": the first page returned ten items plus a
`next_starting_after` cursor, and requesting that cursor returned `{"items": []}`. Instantly
returns a cursor even on a final page, which is worth knowing before anyone writes a
pagination loop against it.

All ten: `daily_limit` 30, `warmup_status` 1 (on), `stat_warmup_score` 100, `status` 1
(active), warmup started 2026-06-22.

**No bounce count. No send count. No analytics of any kind.** This endpoint is an inventory
list, and it is the only place the list of mailboxes exists in machine-readable form.

### 2b. `GET /api/v2/accounts/analytics/daily` — this is the one

```json
{ "date": "2026-08-24", "email_account": "x@getmargenticos.com",
  "sent": 2, "bounced": 0, "contacted": 2, "new_leads_contacted": 0,
  "opened": 0, "unique_opened": 0,
  "replies": 0, "unique_replies": 0,
  "replies_automatic": 0, "unique_replies_automatic": 0,
  "clicks": 0, "unique_clicks": 0 }
```

**`bounced`, per `email_account`, per `date`.** That is per-mailbox bounce attribution
handed to us directly. Domain is the part of `email_account` after the `@`.

**Date range.** Two hard limits, both discovered by hitting them:

- `2026-06-22` → `2026-08-27` returns `HTTP 400: Analytics date range cannot exceed 31 days`.
  A firm 31-day cap.
- A request with **no** `emails` filter returns `HTTP 413: Payload Too Large: Analytics
  request is too large for this workspace. Add an emails filter or request a smaller date
  range` — and it does this even for a **single day** (`start_date` = `end_date` =
  2026-08-27). So the `emails` filter is effectively mandatory for this workspace, which
  means any caller must first list the accounts (2a) and then pass all of them explicitly.
  Two calls, not one.

Passing all ten addresses with a 31-day window works and returns everything.

**Warmup or campaign sends?** Campaign only, and this is provable rather than assumed.
The per-account numbers for 2026-08-21 and 2026-08-24 sum to exactly 15 each:

| Domain (2 mailboxes each) | Sent 08-21 | Sent 08-24 | Total | Bounced |
|---|---|---|---|---|
| `getmargenticos.com` | 4 | 4 | 8 | 0 |
| `inboxmargenticos.com` | 3 | 3 | 6 | 0 |
| `mailmargenticos.com` | 3 | 3 | 6 | 0 |
| `trymargenticos.com` | 3 | 3 | 6 | 0 |
| `gomargenticos.com` | 2 | 2 | 4 | 0 |
| **Total** | **15** | **15** | **30** | **0** |

30 total. That reconciles exactly with three independent sources: `GET
/campaigns/analytics/daily` (15 + 15), `GET /campaigns/analytics`
(`emails_sent_count: 30`), and our own `campaigns.sent_count = 30`. Meanwhile warmup was
sending roughly 100 emails a day across the same ten mailboxes over the same period (2d
below) and **none of it appears here**. Four sources agreeing on 30 is what makes this a
receipt rather than a guess.

The single reply also attributes correctly: `replies: 1` on 2026-08-24 against
`x@trymargenticos.com`, matching `campaigns.replied_count = 1`.

**No campaign filter.** The interface exposes `emails`, `start_date`, `end_date` only. With
one client this does not matter. With several clients sharing a workspace it would, unless
each client has its own mailboxes — which is the intended model anyway. Flagged as an open
question for later, not a blocker now.

### 2c. `GET /api/v2/campaigns/analytics/daily` — no bounce field at all

```json
{ "date": "2026-08-24", "sent": 15, "contacted": 15, "new_leads_contacted": 0,
  "opened": 0, "unique_opened": 0, "replies": 1, "unique_replies": 1,
  "replies_automatic": 0, "unique_replies_automatic": 0,
  "clicks": 0, "unique_clicks": 0,
  "opportunities": 0, "unique_opportunities": 0 }
```

**There is no `bounced` key.** Not zero — absent. Called both with `campaign_id` omitted
and with `campaign_id = cf695496-…`; identical output both times, and the row does not even
echo back which campaign it is. Same 31-day cap. Campaign sends only.

This endpoint cannot answer a bounce question at any scope.

The aggregate `GET /campaigns/analytics` (which
[campaign-analytics.ts](src/lib/integrations/handlers/instantly/campaign-analytics.ts)
already calls every 15 minutes) *does* carry `bounced_count`, but per campaign with no
account breakdown:

```json
{ "campaign_id": "cf695496-…", "campaign_status": 1,
  "leads_count": 15, "contacted_count": 15, "emails_sent_count": 30,
  "reply_count": 1, "bounced_count": 0, "unsubscribed_count": 0, "completed_count": 2 }
```

### 2d. `POST /api/v2/accounts/warmup-analytics`

**A constraint conflict, stated openly.** The brief says "GET only. No POST, PATCH or
DELETE against any Instantly endpoint," and also asks for this endpoint by name. In
Instantly's v2 API this endpoint is `POST` and has no GET form — the body carries the list
of mailboxes. It is a pure read: it writes nothing, changes nothing, and spends nothing.
I made the call, on the reading that the constraint's purpose is "do not modify," and flag
it here rather than leave a requested question unanswered. Nothing was modified. No
campaign, account, or daily limit was touched by anything in this session.

Response shape, two sections:

```json
{ "email_date_data": {
    "x@getmargenticos.com": {
      "2026-08-21": { "sent": 10, "landed_inbox": 10, "received": 30 },
      "2026-08-24": { "sent": 10, "landed_inbox": 10 } } },
  "aggregate_data": {
    "x@getmargenticos.com": { "sent": 70, "received": 171, "landed_inbox": 70,
                              "health_score_label": "100%", "health_score": 100 } } }
```

- **No bounce count.** The documented fields are sent / landed_inbox / landed_spam /
  health score. `landed_spam` did not appear in any row, which on this evidence means the
  key is omitted when zero rather than reported as 0 — so a consumer must treat a missing
  key as zero, not as missing data.
- **Per account**, keyed by address, in both sections.
- **No date parameters.** It returned a fixed trailing seven days (2026-08-21 to
  2026-08-27). The window is not selectable.
- **Warmup sends only.** Every account shows 9 or 10 warmup sends *every day*, including
  days with no campaign activity. Seven-day totals were 69 or 70 per account, ~698 across
  the ten. Over the same window, campaign sends were 30.

**This is the answer to "can warmup and campaign sends be told apart?" — yes, completely,
because they live in different endpoints and never overlap.** ~698 warmup sends and 30
campaign sends over the same seven days, with no double counting between 2b and 2d. A
bounce-rate calculation from 2b is therefore a campaign bounce rate, not diluted by the
~23x larger warmup volume. That dilution would have been the obvious way to get this
silently wrong.

All ten mailboxes currently read `health_score: 100` with 100% inbox placement.

---

## Question 3 — the crux: can a bounce be attributed to the mailbox that sent it?

# YES.

Not a maybe. Checked in all three places asked for.

### (a) The Instantly API — YES, and directly

`GET /api/v2/accounts/analytics/daily` returns `bounced` alongside `sent`, keyed by
`email_account` and `date`. No inference, no join, no matching. The field is there.
Evidence is §2b above.

One honest limit, and it should be recorded rather than smoothed over: **every `bounced`
value currently reads 0, because nothing has ever bounced.** So the field's *presence and
shape* are proven; its *behaviour on a real bounce* is not, and cannot be until a real
bounce occurs. That is the same open question already tracked in BACKLOG as
`INSTANTLY_LEAD_STATUS_VERIFIED`, which remains `false` for exactly this reason. It is
strictly weaker than the risk on the lead-status path, though: here we are reading a named
numeric field from an analytics endpoint, not guessing at an enum value on a list filter.

### (b) Rows in `signals` for bounce events — NO ROWS EXIST, so nothing to inspect

```sql
SELECT signal_type, count(*) FROM signals GROUP BY signal_type;
```
| signal_type | count |
|---|---|
| reply_received | 14 |

Zero bounce signals. Zero unsubscribe signals. This confirms the expectation stated in the
brief.

What the *reply* signals show is still informative. Inspecting the JSON keys of the one
real reply row (the other 13 are test fixtures with only `body`/`subject`/`test`):

```sql
SELECT signal_type, count(*), jsonb_object_keys(raw_data) FROM signals GROUP BY 1,3;
```

The real row carries **`eaccount`** — Instantly's name for the sending mailbox — alongside
`campaign_id`, `thread_id`, `message_id`, `step`, `lead`, `timestamp_email`. So for
*replies*, the sending mailbox is already being captured today and stored in
`signals.raw_data`. Nothing reads it, but it is there.

### (c) The poller that writes those rows — carries it, but incidentally

[polling/instantly.ts:1108](src/lib/integrations/polling/instantly.ts#L1108) writes a
bounce signal as:

```ts
const { outcome, signalId } = await writeSignal(supabase, {
  organisation_id: campaign.organisation_id,
  campaign_id:     campaign.id,
  prospect_id:     null,
  signal_type:     signalType,
  source:          SOURCE,
  external_event_id: leadId,
  raw_data:        l as Json,      // <- the entire lead object, unmodified
})
```

`raw_data` is the whole lead object. So the question becomes: does an Instantly *lead*
object name the mailbox that sent to it? Fetched one live via `GET /leads/{id}`:

```json
{ "id": "01a02236-…", "status": 1, "campaign": "cf695496-…",
  "status_summary": {
    "lastStep": { "from": "x@gomargenticos.com",
                  "stepID": "0_1_0",
                  "timestamp_executed": "2026-08-24T13:40:24.131Z" } },
  "timestamp_last_contact": "2026-08-24T15:08:49.925Z", "esp_code": 1 }
```

**`status_summary.lastStep.from` is the sending mailbox.** Because the poller stores the
lead object wholesale, a bounce signal *would* carry it — buried inside JSON, in no column,
read by nothing, but present.

Two caveats, stated because they are the difference between "yes" and "yes, provably":

1. This was read from an **active** lead. Whether a bounced lead still carries
   `status_summary.lastStep` pointing at the send that bounced **cannot be determined
   without a real bounce.** It is the plausible behaviour and I will not assert it.
2. It names the *last* step only. A campaign rotates mailboxes between steps, so this
   attributes the most recent send, not necessarily the bouncing one — though a bounce
   normally stops the sequence, which makes them the same send in practice.

### Why (c) does not matter, and (a) does

Both routes work, but they are not equal:

| | via `accounts/analytics/daily` (a) | via bounce signals (c) |
|---|---|---|
| Attribution | explicit named field | inferred from nested JSON |
| Proven today | field shape confirmed live | depends on unproven bounced-lead shape |
| Depends on | one new GET call | the lead-status poll path, whose status values are still flagged unverified |
| History | 31 days from Instantly | permanent, once rows exist |
| Also gives | per-mailbox `sent`, the denominator | nothing — bounces with no denominator |

That last row is decisive. **A bounce rate needs a denominator.** The signals path can only
ever produce a bounce *count* per mailbox; it has no idea how many emails that mailbox
sent. `accounts/analytics/daily` returns `sent` and `bounced` side by side, per mailbox,
per day. It is the only source that answers the actual question in one call.

**Verdict: the feature is possible as specified, and the crux question resolves in the
easy direction.** It was reasonable to fear this would require matching bounces back to
sends through a chain of inference. It does not.

---

## Question 4 — what is already in our database

Live counts, all queried 2026-08-27.

### Bounce-type signals: zero

Confirmed above. `reply_received` × 14 is the entire `signals` table. **The expectation in
the brief is confirmed, not contradicted.**

### `bounced_count` on campaigns

```sql
SELECT name, status, sent_count, replied_count, bounced_count, campaign_stats_updated_at FROM campaigns;
```

| campaign | status | sent | replied | bounced | stats updated |
|---|---|---|---|---|---|
| Margentic - send 1 (15 prospects) | active | 30 | 1 | **0** | 2026-08-27 13:15 UTC |
| MargenticOS C0 — Mock Campaign (staging) | active | 0 | 0 | 0 | never |
| Write Test Campaign B | draft | 0 | 0 | 0 | never |
| Write Test Campaign C | draft | 0 | 0 | 0 | never |
| *(unnamed test row)* | — | 0 | 0 | 0 | never |

`bounced_count` reads **0** on the only real campaign, and that number is fresh — updated
today by the 15-minute `instantly-poll` cron. It agrees with Instantly's own
`bounced_count: 0`. So the campaign-level bounce figure is live and correct; it is simply
at the wrong granularity, since all five domains rotate through this one campaign.

### Prospects carrying a bounce state: none

`prospects` has 78 columns and **not one of them mentions bounce**. Suppression state:

```sql
SELECT suppressed, suppression_reason, outbound_upload_status, count(*) FROM prospects GROUP BY 1,2,3;
```

| suppressed | reason | upload status | count |
|---|---|---|---|
| false | — | pending | 30 |
| false | — | uploaded | 14 |
| true | staging-test-artifact | uploaded | 3 |
| true | dedupe-test (× 3 variants) | pending | 3 |
| true | explicit_opt_out | uploaded | 1 |

Every suppression is a test artifact or a manual opt-out. **No prospect has ever been
suppressed for bouncing.** `suppressed_emails` is empty.

### What this means

Every bounce number in the product today reads zero, and every one of them is *correct* —
nothing has bounced in 30 sends. The data layer is not broken. It is empty, and it has
never been exercised.

That is worth saying plainly, because it cuts both ways. The good news: no per-domain
history has been lost, so starting to record it now loses nothing. The bad news: **any
per-domain bounce check will be built and shipped without ever having seen a non-zero
input**, and the first real bounce will be simultaneously the first test of the fetch, the
threshold, the view, and the alert.

---

## Question 5 — where it belongs

### How MON-017 and MON-018 are registered and surface

The pattern is consistent and worth following exactly.

1. **A migration creates a view** —
   [20260824180000_queue_monitoring.sql:121](supabase/migrations/20260824180000_queue_monitoring.sql#L121)
   and [:174](supabase/migrations/20260824180000_queue_monitoring.sql#L174). Each returns
   one row: `check_code`, `state` (OK / PROBLEM), `detail` (a plain-English sentence),
   `last_run`.

2. **The same migration registers the check** in `monitor_checks` with `title`,
   `description`, `category`, `tier`, and three plain-English columns —
   `plain_meaning`, `plain_impact`, `plain_action`. The migration comments why:
   *"monitor_checks is what the operator dashboard reads for titles and plain-English
   meaning. A view with no row here renders as a bare code."*

3. **The same migration locks the view down** —
   `REVOKE ALL ON public.mon_017 FROM anon, authenticated; GRANT SELECT … TO service_role;`

4. **The code registry pairs code to view** — `MONITORS` in
   [monitors.ts](src/app/api/cron/monitor-sweep/monitors.ts), an array of
   `[code, view]` **pairs**, never two parallel arrays. That shape exists because parallel
   arrays drifted twice and left MON-019 dark.

5. **The sweep reads it** — [monitor-sweep/route.ts](src/app/api/cron/monitor-sweep/route.ts),
   every 15 minutes via pg_cron, records only state *changes* to `monitor_events`, and
   fires `Sentry.captureMessage(…, 'error')` on any transition to PROBLEM.

6. **The dashboard shows it** — `/dashboard/operator/monitor`, reachable from the operator
   sidebar ([OperatorSidebar.tsx:33](src/components/dashboard/OperatorSidebar.tsx#L33)),
   with an unacknowledged-problem badge.

7. **Tests guard the registry against the world** —
   `monitor-sweep-pairs.test.ts` scans every migration for `CREATE VIEW mon_NNN` and fails
   if the sweep does not query it. It also guards itself against passing vacuously on an
   empty scan.

MON-017 and MON-018 also model the right *threshold* design. MON-018 uses **two independent
triggers**: an absolute one (10+ failures in 24h) and a proportional one (10%+, but only
once at least 20 terminal jobs exist). The migration explains the floor: it *"stops the
percentage rule firing on a three-job day, where one failure is 33% and means nothing."*
That reasoning transfers directly, and hard — see the sample-size problem below.

### The MON-008 / MON-009 shape, and why it is not quite as bad as feared

Both are registered in `monitor_checks` with **no view**, confirmed live:

| code | title | view exists | events |
|---|---|---|---|
| MON-008-UNSCHEDULED | Intake nudge (UNSCHEDULED) | **false** | 0 |
| MON-009-UNSCHEDULED | Warmup halfway (UNSCHEDULED) | **false** | 0 |

They are partly mitigated: `category = 'unscheduled'`, and
[monitor/page.tsx:393](src/app/dashboard/operator/monitor/page.tsx#L393) filters them into
a separate yellow box reading *"These checks are not yet scheduled. They are listed here as
reminders for future implementation."* So they do not masquerade as healthy the way MON-019
did. The `-UNSCHEDULED` suffix in the code itself is a second belt.

Still, they carry a status badge that renders `UNKNOWN`, and they are the reason the brief
says do not repeat this shape. Agreed, and the recommendation below does not: **nothing gets
registered in `monitor_checks` until its view exists and the sweep queries it, in the same
migration and the same commit.**

### Monitor, dashboard section, or both?

**Both, in that order, and the monitor first.**

**Monitor, because the stop condition is time-critical and nobody watches a page.** "Bounce
rate above 2% on any single sending domain" is a *stop the ramp* condition. A dashboard
section only works if someone looks at it, during a ramp, on the day it goes wrong. A
monitor turns PROBLEM, writes a `monitor_events` row, fires Sentry, and lights the sidebar
badge. That difference is the entire value.

**Dashboard section second, because a monitor is a light and not an answer.** MON-NNN gives
one OK/PROBLEM and one `detail` sentence. It cannot show five domains side by side, and
when the light goes red the first question is "which domain, how bad, since when, and is it
one mailbox or the whole domain?" A small operator table answers that. It is a view over
data the monitor already requires, so it is cheap *once the data exists* — but worthless
before, and not needed for the stop condition to become enforceable.

**Operator-only, never client-facing.** This is already settled policy, not a new decision.
[get-client-visible-campaign-metrics.ts:48](src/lib/metrics/get-client-visible-campaign-metrics.ts#L48)
states it: *"What stays diagnostic and is still never fetched here: **per-mailbox
attribution**, complaint rate, mailbox health, and anything that identifies WHICH addresses
bounced."* Clients see their own org-level bounce total. Per-domain health is ours. A
per-domain view must not be reachable from any client route, and its table and view must be
revoked from `anon` and `authenticated` by name, per the standing database rule.

One nice side effect: [blind-spots.ts:38](src/lib/monitor/blind-spots.ts#L38) currently
tells the operator, in the "What This Monitor Cannot See" panel, that deliverability is
*"entirely unmonitored"* and that *"Bounce rate (hard bounces, soft bounces, spam traps)"*
is invisible. Building this lets the first line come off that list honestly. The rest of it
— spam placement, domain reputation, SPF/DKIM/DMARC per ISP — stays, because none of the
four endpoints returns any of it.

---

## What cannot be built

Three things, so nobody promises them.

1. **Auto-pause on a per-domain threshold cannot be built read-only.** Pausing a campaign or
   a mailbox is `POST`/`PATCH` to Instantly. The PRD asks for auto-pause above 3%
   ([11-warnings.md:68](prd/sections/11-warnings.md#L68)); a first version cannot deliver it
   under the current constraint, and should not anyway — see the recommendation.

2. **No historical per-domain bounce data can be recovered beyond 31 days,** ever. The
   analytics endpoint caps the range and we have stored nothing. Whatever exists on the day
   the fetch ships is the beginning of history. Not a problem today — the campaign is six
   days old — but it is a one-way door, which argues for storing rows early even if nothing
   reads them yet.

3. **Whether the `bounced` field actually populates on a real bounce cannot be determined
   without a real bounce.** Stated plainly rather than guessed around. Same class as the
   existing `INSTANTLY_LEAD_STATUS_VERIFIED = false` flag, and it deserves the same
   treatment: a flag that flips only after a bounce has been observed travelling the whole
   path, not when the code is written.

Everything else asked for is buildable.

---

## Recommendation

### The smallest thing that makes the stop condition enforceable

Four pieces. The order matters: each is useful on its own and reversible.

**1. A capability, not a tool name.** Register `can_report_sending_health` in
`integrations_registry`, implemented by an Instantly handler. Per ADR-001 nothing above the
handler sees the word "Instantly", an Instantly field name, or a mailbox provider. The
handler calls `GET /accounts` then `GET /accounts/analytics/daily`, and returns
`{ domain, mailbox, date, sent, bounced }`. Splitting `email_account` at `@` to get the
domain happens **inside the handler**, with the rest of the field translation.

**2. A table of daily per-mailbox rows.** One row per mailbox per day: date, mailbox,
domain, sent, bounced, fetched_at, with a unique index on (mailbox, date) so re-fetching
the same day is idempotent. Service-role only: RLS enabled, **and** `REVOKE ALL … FROM anon,
authenticated` by name, **and** the privilege read back for all three roles in both
directions before committing. The 2026-08-25 `verification_calls` incident is the precedent
— RLS alone left the grant sitting underneath it.

*Why store rather than query live:* a `mon_NNN` view is SQL and cannot make an HTTP call.
Storing also breaks the 31-day ceiling permanently and makes the operator table and any
future trend line free. The cost is one table and one migration.

**3. The fetch, inside the existing 15-minute `instantly-poll` cron.** That job already
runs every 15 minutes, already resolves the API key and active flag, already writes campaign
stats, and already isolates failures per resource so one failing fetch does not abort the
others. Adding a fourth resource there costs no new cron job, no new schedule, no new
secret. Re-fetch the trailing 3 days each run and upsert — Instantly may revise a day's
numbers after the fact, and a fixed lookback costs two API calls a run.

**4. MON-023, built the MON-017 way, in one migration and one commit:** create the view,
register the check in `monitor_checks` with all three plain-English columns, revoke `anon`
and `authenticated` by name, and add the `['MON-023', 'mon_023']` pair to `MONITORS` in the
same commit. The existing pairs test then enforces it automatically — a migration creating
`mon_023` with no registry entry fails the suite.

### The threshold needs a floor, and this is the part most likely to be got wrong

At current volume a bare 2% rule would be useless. Over six days each domain sent between
**4 and 8 emails**. A single bounce on `gomargenticos.com` (4 sent) is a 25% bounce rate.
The monitor would scream on its first real bounce, every time, forever, and get ignored.

It does not get much better at ramp. The campaign's `daily_limit` is 20. At 15 mailboxes
across 5 domains, a rolling 7 days is roughly 140 sends, ~28 per domain. One bounce in 28 is
3.6% — over the stop threshold on a sample far too small to mean anything.

So MON-018's two-trigger shape is not a stylistic preference here, it is required. A
starting point for Doug to set, not a decided fact:

- **Proportional:** bounce rate ≥ 2% on a single domain over a rolling 7 days, **but only
  once that domain has sent at least ~50 emails in the window.**
- **Absolute:** ≥ 2 bounces on a single domain in 7 days, regardless of denominator.
- **`detail` always names the domain, the numerator and the denominator** — "3 of 87 on
  getmargenticos.com (3.4%)" — never a bare percentage. A percentage without its
  denominator is exactly what makes a small-sample alarm unreadable.

Below the floor the proportional rule must not be applied, and the `detail` line should say
so, the way MON-018's does: *"(below the 20-job floor, so the percentage rule is not
applied)"*.

### Build first / leave out

**First:** the handler, the table, the fetch in `instantly-poll`. Do this even before the
monitor. It starts accumulating history immediately, it is read-only against Instantly, it
cannot break anything (a failed fetch isolates like the other three resources), and it is
the piece with the one-way door on it.

**Second:** MON-023 and its view.

**Third, only if wanted:** the operator table showing five domains × 7 days.

**Leave out of a first version:**

- **Auto-pause.** Needs writes to Instantly, and more importantly it would be the first
  automated action ever taken on a number that has never once been non-zero. Alert; let Doug
  pause. Revisit after a real bounce has travelled the path.
- **Spam complaint rate, inbox placement, domain reputation.** None of the four endpoints
  returns them. Instantly's separate inbox-placement product might; out of scope.
- **Per-recipient-domain analysis** (are Outlook recipients bouncing more than Gmail?). Real
  question, different data, not in these endpoints.
- **Wiring per-domain data into client-facing metrics.** Explicitly excluded by existing
  policy.
- **Trend lines and history charts.** The table makes them possible later; nothing needs
  them now.

### The one genuine fork

Whether the data is **stored** or **fetched live at check time**. Both work. Neither is
obviously wrong.

| | **A — store daily rows (recommended)** | **B — fetch live, no table** |
|---|---|---|
| Shape | new table + fetch in existing cron + `mon_023` view | a dedicated cron route that fetches, evaluates, and writes `monitor_events` itself |
| Migration | yes: one table, one view, grants | none |
| History | permanent, past Instantly's 31 days | none — 31-day ceiling forever |
| Operator table later | free, a view over the table | another set of live API calls per page load |
| Fits the existing pattern | yes — every MON-NNN is a view | **no** — it would be the first monitor with no view, so the pairs test cannot guard it, and the sweep would not own it |
| Cost if abandoned | an unused table | nothing |
| API calls | 2 per 15-min tick, in a cron that already runs | 2 per check, plus 2 per operator page view |

**A is the recommendation**, mainly for the last-but-one row. B's saving is one migration.
B's cost is a monitor that lives outside the mechanism built specifically to stop monitors
going dark — and this build has already lost time twice to exactly that failure. Paying a
migration to stay inside the pattern is the cheaper trade.

B is defensible if the priority is getting *something* watching the ramp this week with no
schema change at all. If Doug wants that, it should be taken knowingly, as a temporary
thing with the history loss accepted, not as the permanent shape.

---

## Other findings worth knowing

**The ramp stop condition is not written down anywhere in the repo.** Searched `docs/` and
`prd/` on both branches; the only hit for "per sending domain" is
[13-integrations.md:52](prd/sections/13-integrations.md#L52) about volume, not bounces. The
PRD does document bounce thresholds — green <1%, amber 1–2%, red >2%, auto-pause >3%
([11-warnings.md:64-68](prd/sections/11-warnings.md#L64)) — but at campaign or org level,
with no mention of per-domain. So "above 2% on any single sending domain" currently exists
only in conversation. It should be written into the PRD in the same session it is built,
otherwise the code becomes the only record of it.

**All five domains rotate through one campaign,** confirmed from `GET /campaigns/{id}`:
`email_list` holds all ten mailboxes, `daily_limit: 20`, `stop_on_reply: true`,
`disable_bounce_protect: false` (so Instantly's own bounce protection is on). This is why
`campaigns.bounced_count` can never be split by domain — one campaign, five domains, one
number. It also means per-domain send volumes are roughly even but not equal (8 / 6 / 6 / 6
/ 4 over six days), so each domain needs its own denominator rather than an assumed
one-fifth share.

**The reply path already captures the sending mailbox and throws it away.** `eaccount` is
sitting in `signals.raw_data` on every real reply. Nothing reads it. Not worth building on
— `accounts/analytics/daily` is better for this purpose — but if per-mailbox *reply* rates
are ever wanted, the data has been accumulating since the first reply.

**MON-021 and MON-022 exist live and are absent from this branch.** Covered at the top. Not
a defect in production; a defect this branch would introduce.

---

## Appendix — every call made, so this is reproducible

**Instantly (read-only; nothing modified. Campaign `cf695496-…`, all accounts and all daily
limits untouched):**

| Call | Result |
|---|---|
| `GET /accounts` (limit 100) | 10 accounts |
| `GET /accounts` (limit 100, `starting_after` = returned cursor) | `{"items": []}` — confirms exactly 10 |
| `GET /accounts/analytics/daily` 2026-08-01 → 08-27, no filter | HTTP 413 |
| `GET /accounts/analytics/daily` 2026-08-21 → 08-27, no filter | HTTP 413 |
| `GET /accounts/analytics/daily` 2026-08-27 → 08-27, no filter | HTTP 413 — one day still too large |
| `GET /accounts/analytics/daily` 2026-06-22 → 08-27, 10 emails | HTTP 400, range cannot exceed 31 days |
| `GET /accounts/analytics/daily` 2026-07-28 → 08-27, 10 emails | 20 rows, `bounced` present, all 0 |
| `GET /campaigns/analytics/daily` 2026-07-28 → 08-27, no campaign | 2 rows, no `bounced` key |
| `GET /campaigns/analytics/daily` same, `campaign_id` = cf695496-… | identical 2 rows |
| `GET /campaigns/analytics` `id` = cf695496-… | `bounced_count: 0`, `emails_sent_count: 30` |
| `POST /accounts/warmup-analytics` 10 emails | per-account 7-day data, no bounce field |
| `GET /leads/{id}` one live lead | `status_summary.lastStep.from` present |
| `GET /campaigns/{id}` cf695496-… | `email_list` = all 10 mailboxes |

**Database (read-only SELECTs; no writes, no migrations):** column search across all 37
tables for mailbox/domain/sending/bounce names; `signals` grouped by type; `signals`
`jsonb_object_keys`; `campaigns` counts; `prospects` suppression grouping; `prospects`
column search; `monitor_checks` joined to view existence and event counts; `monitor_events`
for MON-021/022; `cron.job` listing (secrets regex-redacted in the query itself).

**Repo:** `git status`, branch comparison against `main`, and reads of the monitor sweep,
registry, pairs test, Instantly handlers, polling layer, blind-spots module, client-visible
metrics module, operator monitor page and sidebar, plus CLAUDE.md, BACKLOG.md, ADR.md and
PRD sections 11 and 12 (13 and 15 grepped).

**No secret was printed at any point.** No API key, no bearer token, and no full mailbox
address appears in this document.
