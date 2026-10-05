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

## Regional campaigns — one client, a campaign per time zone (2026-10-05)

**What it does.** A client can run several cold-email campaigns for the same segment, each
covering a set of countries and sending in that region's working hours. At upload each
prospect goes to the campaign whose `campaigns.region_countries` names its country, and
otherwise to the campaign with no region (the catch-all, which also takes unknown country).
Router: `src/lib/outbound/campaign-routing.ts`. Called from `handleUploadLeads`.

MargenticOS runs two: **US and everywhere else** (America/Detroit, 08:00 to 18:00, 75 a day)
and **UK/IE** (GB and IE, Europe/London 08:00 to 18:00, 15 a day). Both on the same six
mailboxes, so the per-mailbox load is the total of the two.

**What does not change per campaign.** Reply polling is one workspace-wide stream attributed
by each email's campaign id; the bounce and unsubscribe scan walks every registered campaign;
provider suppression is by address across the whole workspace; MON-013, MON-029 and MON-031
enumerate campaigns or replies, not "the" campaign. The weekly watch reads every active
campaign of the client together (limits summed, mailboxes counted once).

**The schedule lives on the provider, not in our table.** The upload panel reads each
campaign's window, daily limit and mailbox count live (`campaign-send-settings.ts` handler).
The provider accepts only its own list of ~100 time zones and Europe/London is not on it;
`Europe/Isle_of_Man` is (an IANA link to London: same GMT/BST and change dates), so a UK
window is stored as Isle_of_Man and shown as London.

**A regional campaign switches itself on with its first leads (2026-10-05).** It is created
paused. The first upload that gives it leads activates it (`src/lib/outbound/regional-activation.ts`,
called at the end of `handleUploadLeads`) and re-splits the daily limits so the client total
stays at `organisations.outbound_daily_cap`: each regional campaign gets its
`campaigns.daily_limit_share`, the catch-all gets the cap minus the shares of the live regional
campaigns (derived, never stored). MargenticOS: cap 90, UK/IE share 15, so US carries 90 until
UK/IE has leads and 75 after. Limits that go down are written before limits that go up, the
activation comes last, and every write is read back from the provider; if a limit write fails
nothing is activated. A campaign is auto-activated ONCE (`auto_activated_at`): if an operator
pauses it afterwards, no upload switches it back on. No cap configured means the campaign is
left paused and the refusal is logged. Every activation, limit change, refusal and failure is
in `campaign_automation_log` and listed on the upload panel under "Automatic campaign changes".

**Adding a regional campaign, in this order.**
1. Create it on the provider, paused, copying the existing campaign's settings.
2. Merge and deploy any routing code first. Code that predates regions treats two campaigns
   in a segment as ambiguous and marks EVERY pending prospect failed on the next upload.
3. Register it (Campaign registration panel), then set `region_name`, `region_countries` and
   `daily_limit_share` on its row, give the catch-all its `region_name`, and set the client's
   `organisations.outbound_daily_cap`. Leave the new campaign paused: the first upload with
   leads for it switches it on.
4. Sync its sequence shell (upload panel). Until it has a shell of the right step count the
   upload refuses it and reports `no_shell`; the other campaign's batch still goes.

**If it breaks.**
- Prospects failed with "routing is ambiguous": two campaigns in one segment are catch-alls,
  or a country is named twice. Fix the rows; the router refuses every prospect until then.
- "no campaign for XX and no catch-all": a segment has only regional campaigns.
- A UK prospect went to the US campaign: check `prospects.country` holds `GB` (ISO-2). "UK"
  is translated to GB by `toIso2CountryCode`.
- Panel row says "Send window could not be read": the provider read failed; the upload is
  unaffected, only the display.
- A regional campaign got leads but is still paused: read "Automatic campaign changes" on the
  upload panel (or `campaign_automation_log`). A refusal names the missing config; a failure
  names the provider call. Fix, then activate it by hand or let the next upload with leads for
  it try again only if `auto_activated_at` is still NULL.

## Campaign stats and status — where the dashboard numbers come from

The same cron that polls replies also refreshes each campaign's counters and its status,
in one `GET /campaigns/analytics` call that returns every campaign in the workspace.

**Instantly owns campaign status. We copy it, we never author it.** Before 2026-08-23
nothing wrote `campaigns.status` at all: the creation insert hardcoded `draft` and no code
path ever moved it. The refresh then filtered on `status = 'active'`, which is the trap
worth remembering, because it looked reasonable and was self-defeating. The filter gated
the loop on the column the loop was responsible for maintaining, so a campaign stuck at
`draft` was excluded from the very process that would have corrected it. It could never
recover, no matter how many times the cron ran. The filter is gone. The scope is now
`external_id IS NOT NULL`, which means "this campaign exists in Instantly" and is exactly
the set the analytics response can answer for.

**The status values.** Instantly uses a closed enum of eight integers, verified against
`components.schemas.def-1` in https://developer.instantly.ai/api-reference/openapi.json.
Our column allows four. The mapping:

| Instantly | Meaning | Stored as |
|---|---|---|
| 0 | Draft | `draft` |
| 1 | Active | `active` |
| 2 | Paused | `paused` |
| 3 | Completed | `completed` |
| 4 | Running Subsequences | `active` — still working, so not `completed` |
| -1 | Accounts Unhealthy | `paused` |
| -2 | Bounce Protect | `paused` |
| -99 | Account Suspended | `paused` |

Two things to know about that table. First, do not re-derive it from the Instantly MCP
tool description, which lists only 0 to 3 and would silently lose four states. Second,
the last three rows lose information that matters: an account suspension looks exactly
like a deliberate pause once stored. The route logs a warning naming the real state
whenever one occurs, so check the logs before concluding someone paused a campaign.

**Status is intent, not live sending.** A campaign at status 1 may still be sending
nothing, because of a schedule window, a daily limit, or an error. Instantly carries that
separately in `not_sending_status`, and the richer answer is
`GET /campaigns/{id}/sending-status`, where `healthy` is the only unobstructed value.
Neither is used here. Do not read `status = 'active'` as "mail is going out right now".

**An unrecognised status is never guessed.** If Instantly sends a value outside its own
enum, the status column is left alone and a warning names the raw value. The counters are
still written, because they are still trustworthy. Writing a guess into a column the
dashboard renders is worse than writing nothing.

**A campaign with no analytics row is a failure, not a skip.** If a row's `external_id`
does not come back in the analytics response, that means our table points at a campaign
that does not exist in Instantly. Since 2026-08-23 this is logged with the `external_id`
named, counted in `campaign_stats.missingAnalytics`, and — this is the part that changed —
counted toward the run's `ok`. It used to be a silent skip, which is how two mock rows sat
in the table for months while the run reported clean.

*If the cron is red and the detail names a mock external_id, that is this check working.*
Fix the data: delete the row, NULL its `external_id`, or point it at a real campaign. See
BACKLOG.md.

**Do NOT expect MON-002 to turn red with it.** Checked against the live view definition on
2026-08-23: `mon_002.state` is derived from `max(ran_at)` staleness alone, so it reports
PROBLEM only when the cron stops running entirely. A cron that runs every 15 minutes and
fails every time reads `state = OK`. The failure is visible in the row's `detail` string
and in `cron_heartbeats.ok`, not in the state. Check `cron_heartbeats` directly, or Sentry,
when you want to know whether runs are succeeding rather than merely happening.

---

## Campaign sending health — the column that decides whether a client sees "live"

`campaigns.status` answers **what somebody intended this campaign to do**. It is a copy of
Instantly's `campaign_status` and nothing more. `campaigns.sending_state` answers **whether
mail is actually leaving right now**. They are different questions with different answers,
and the client dashboard prints the word "live" off the second one only.

That is not a stylistic preference. A campaign sitting at `status = 'active'` can be
sending precisely nothing: outside its schedule window, out of leads, at its daily cap, or
with every sending account already at its own cap. Reading `status` and calling it live
would replace one lie with a better-dressed one.

**The source.** `GET /api/v2/campaigns/{id}/sending-status`, one call per campaign because
Instantly offers no bulk form of it. It runs on the same 15-minute poll, immediately after
the workspace-wide analytics call, and only for campaigns that analytics call resolved — a
row pointing at a deleted campaign fails once in the analytics pass rather than twice.

**The enum, verified 2026-08-24** against
`paths./api/v2/campaigns/{id}/sending-status.get` → response 200 →
`properties.diagnostics.properties.status` in
https://developer.instantly.ai/api-reference/openapi.json. A closed enum of **eighteen**
strings, of which `healthy` is the only one that means mail is going out.

| Instantly | Stored `sending_state` | What it means for the client |
|---|---|---|
| `healthy` | `sending` | Mail is going out |
| `campaign_draft` | `draft` | Never started |
| `campaign_paused` | `paused` | Deliberately stopped |
| `campaign_completed` | `completed` | Finished its sequence |
| `out_of_schedule` | `waiting` | Intends to send, nothing to send this instant |
| `waiting_for_leads` | `waiting` | " |
| `follow_up_delay_not_met` | `waiting` | " |
| `waiting_for_esp_match` | `waiting` | " |
| `campaign_running_subsequences` | `waiting` | " |
| `daily_limit_met` | `limit_reached` | Cap hit for today, resumes on its own |
| `account_daily_limit_met` | `limit_reached` | " |
| `new_lead_limit_met` | `limit_reached` | " |
| `domain_limit_reached` | `limit_reached` | " |
| `campaign_bounce_protect` | `blocked` | Stopped by Instantly. Needs a human |
| `campaign_accounts_unhealthy` | `blocked` | " |
| `campaign_account_suspended` | `blocked` | " |
| `all_accounts_unhealthy` | `blocked` | " |
| `no_accounts_available` | `blocked` | " |

**This is NOT `not_sending_status`, and confusing the two costs thirteen values.** The
campaign object (`components.schemas.def-1`) carries its own `not_sending_status`, a
five-value **numeric** enum verified in the same pass: `1` out of schedule, `2` waiting for
leads, `3` daily limit met, `4` all accounts at daily limit, `99` error. Anyone who reads
the endpoint response and maps it through that five-code vocabulary loses every
campaign-state code and every account-health code. The endpoint is strictly richer, so
`not_sending_status` is not fetched at all. As always: do not re-derive either enum from
the Instantly MCP tool description.

**`campaign_running_subsequences` lands in `waiting` while `campaign_status = 4` maps to
`active`.** That looks like a contradiction and is not: intent is active, health is not
healthy. This endpoint settles the judgement call BACKLOG.md flagged against status 4,
because it lists the code among the reasons a campaign is not sending and treats `healthy`
as the sole unobstructed value.

**Three columns, and what each one is for.**

- `sending_state` — ours, seven canonical values, `CHECK`-constrained. Nothing above the
  integrations layer sees an Instantly string.
- `sending_status_raw` — Instantly's code, deliberately **unconstrained**. Constraining it
  would put a vendor's closed enum in two places, so the day they add a nineteenth value
  the write fails and takes the campaign's counters down with it in the same statement.
  Diagnostics only: when `sending_state` says `waiting`, this says whether that is a
  schedule window or an ESP match. Never rendered to a client.
- `sending_status_checked_at` — when Instantly last **answered**, not when it last answered
  healthily. Stamped even when Instantly reports no data, because "we asked at 15:15 and
  Instantly had nothing to say" is a different fact from "we have not asked since Tuesday".
  Any surface that prints "live" must check this for staleness first.

**What happens when the call fails.** The counters still get written — they came from the
analytics call and are still good — and all three sending columns are left out of the
update entirely, so the previous reading keeps its old `sending_status_checked_at`.
Staleness there is the signal that the value cannot be trusted; refreshing the timestamp
while failing to refresh the state would erase it. The failure is counted in
`campaign_stats.sendingErrors`, counts toward the run's `ok`, and is named in the heartbeat
detail.

**An unrecognised code is never guessed.** A string outside the enum clears
`sending_state` to NULL, keeps the raw code, and logs a warning. NULL means "not
established" and must render as "not reported", never as "not sending" and certainly never
as "live".

---

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

## Booking detection — Cal.com (`can_book_meeting`)

Added 2026-09-11. Full reasoning in ADR-056. Replaces the Calendly route, which never recorded a meeting.

**What it does.** When someone books through a booking link we sent, Cal.com notifies
`POST /api/webhooks/cal-com`. The route checks the signature, works out which client the booking
belongs to and which prospect booked, and records a meeting.

**Where the pieces are.**
- Registry row: `can_book_meeting` / `cal_com`, handler `src/lib/integrations/handlers/cal-com`.
  The old `calendly` row stays until the post-merge migration removes it. Nothing reads this
  capability through the registry today.
- Route: `src/app/api/webhooks/cal-com/route.ts`
- Cal.com-specific code: `src/lib/integrations/handlers/cal-com/webhook.ts` (signature, payload)
- Vendor-neutral recording: `src/lib/meetings/record-booking-event.ts`
- The link we send: `src/lib/meetings/booking-link.ts` adds `prospect_ref`

**The five triggers it handles** (extended 2026-09-12, ADR-057). Everything else Cal.com can
send is acknowledged with a 200 and ignored, by name, in the response.

| Trigger | What it does | What it must never do |
|---|---|---|
| `BOOKING_CREATED` | Records the meeting, with its scheduled end and its calendar billing deadline | |
| `BOOKING_RESCHEDULED` | Moves the meeting onto the new booking id, updates both times, recomputes the deadline, and restarts the asking | Overturn a decision already made |
| `BOOKING_CANCELLED` | Cancels a meeting that is still booked | Overturn a decision already made |
| `MEETING_ENDED` | Stamps `outcome_requested_at`, which is how the platform learns to ASK a person | Set held, billable or a locked decision. It fires at the scheduled end time whether or not anybody attended |
| `BOOKING_NO_SHOW_UPDATED` | Records a no-show when an attendee carries `noShow: true`, as `held_confirmed_by = 'host'` | Bill anything (a no-show never is), or apply when a host UNMARKS someone, which fires the same trigger with `noShow: false` |

`AFTER_HOSTS_CAL_VIDEO_NO_SHOW` and `AFTER_GUESTS_CAL_VIDEO_NO_SHOW` are deliberately NOT
handled. They fire only for bookings on Cal's own video product, and every client seat uses the
client's own Google Meet, Teams or Zoom, so they would never fire for a client meeting.
`MEETING_ENDED` carries a FLAT payload: the booking's fields at the top of `payload`, not a
nested booking object. `BOOKING_NO_SHOW_UPDATED` names the booking `bookingUid`, not `uid`.

**Setup it depends on, none of which code can do:**
- `CALCOM_WEBHOOK_SECRET` set in Vercel, identical to the secret typed into Cal.com's webhook settings
- the webhook subscribed to the five triggers in the table above, and no others
- a HIDDEN booking question on the event type, identifier exactly `prospect_ref`
- `organisations.booking_host_ref` set to the email of the Cal.com account that hosts the booking
- `JWT_SECRET` set in Vercel, at least 32 characters, for the confirmation links. There is no
  fallback: without it nothing is signed and nothing is accepted, so no client can confirm a
  meeting and the backstop will not bill those meetings either (Backlog, Live risk)
- **a webhook scope that actually covers the client seat.** A user-level webhook covers only
  that user's own event types, excluding team-managed ones, so the current webhook on Doug's
  user will not fire for a client seat's personal event type. Before the first client seat,
  either one webhook per client user, or each client's campaign event type set up as a TEAM
  event type with one organisation-level webhook over all of them (Backlog, before first client)

**What to check if it breaks.**
- Every refusal names its reason, in the response (`reason`) and in a Sentry issue titled
  `cal-com webhook refused: <reason>`, which describes our secret by presence and length only:
  - `secret_not_configured` (500): `CALCOM_WEBHOOK_SECRET` is not set on the deployment that
    answered. Set it for that environment in Vercel and redeploy.
  - `signature_missing` or `signature_malformed` (401): Cal.com sent no real signature. Its
    webhook almost certainly has no secret set.
  - `signature_mismatch` (401): both sides have a secret and they differ. If `secret_length` and
    `secret_trimmed_length` differ, the Vercel value has a stray space or newline.
- Bookings land in `unattributed_bookings` and the operator gets "a calendar that belongs to no
  client": `booking_host_ref` is not set, or is not the address Cal.com reports as the organiser.
- Meetings arrive with `prospect_match = 'none'` for real prospects: the hidden question is
  missing, or is not named exactly `prospect_ref`, and the prospect booked with a different email.
- Nothing arrives at all: check the webhook's delivery log in Cal.com's settings first. The free
  tier's webhook support for a solo account was unverified when this was built.
