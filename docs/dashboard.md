# dashboard.md — Dashboard Reference
# Partial. Update as each view is built.
# Cover: all views, what each shows, why, what to check if a view breaks.
# The spec is in /prd/sections/12-dashboard.md. Design tokens in /docs/design.md.

## Views built

This section is incomplete. It records only the views documented so far, not every view that
exists.

### Operator pipeline review — /dashboard/operator/sourcing-review

What it shows: one card per active organisation with the prospect counts at each pipeline
stage, and the controls that move a client through it. Archived organisations are not
listed.

Controls on each card, in pipeline order:

| Control | What it does | Cost |
|---|---|---|
| Source prospects | Runs the sourcing orchestrator for that organisation. Batch size is typed in, capped at 500. | Apollo credits |
| Research N prospects | Researches prospects that have never been researched. Reuses findings already on file where they exist. | Anthropic API, plus four data sources for any prospect with nothing on file |
| Review pending | Links to the approval queue | none |
| Enrich and tier batch | Existing control, unchanged | Apollo credits |
| Review quality | Links to the tiered review | none |

Both new controls block on a single request and show the result when it finishes. There is
no progress bar, which matches the send path: the operator sees a working state, then one
structured result. A batch too large to finish in time is refused up front with an error
naming the real limit, so nothing is ever silently truncated.

The research control only ever offers the `unresearched` scope. Re-running a prospect that
already has a personalisation trigger rewrites that copy, or clears it when the judge holds,
so there is deliberately no dashboard control that asks for it. See agents.md, "The guard on
finished copy".

What to check if it breaks:
- The counts come from one query per organisation in `page.tsx`. `unresearched_count` counts
  prospects with `current_research_result_id` null and `suppressed` false, which is exactly
  what the research entry point selects. If the button count and the run disagree, those two
  definitions have drifted.
- A refusal renders as a red message under the button. It is the entry point's own error
  text and says why.
- `PipelineOverview` is a client component. It must not import from
  `src/lib/operator/sourcing-entry.ts`, which would pull the orchestrator, the Apollo
  handler and the service-role client into the browser bundle. The batch-size cap is passed
  down as a prop from the server page for that reason.

### Client overview — /dashboard

Two entirely different pages behind one route, chosen by whether a single email has gone
out. `metrics.hasData` is the switch, and it is true from the first send.

**Before anything is sent** the page is a promise: strategy is ready, warmup runs six
weeks, results appear once outreach begins. That is true at that point, so it stays.

**Once outreach has started** the promise is retired and the page reports. It leads with
how many PEOPLE have been contacted, carries a live sending pill, and shows five counts:
contacted, delivered, replies, interested, meetings held.

**Counts, never rates, on this page.** One reply from twenty-six emails is 3.8%, and a
percentage on a sample that size is noise dressed as a measurement. Rates live on
Benchmarks, behind a sample gate. There is a test asserting no `%` character appears
anywhere in the rendered overview.

**What each number actually is.**

| Shown | Source | Why not the obvious thing |
|---|---|---|
| Contacted | `campaigns.contacted_count` | NOT `sent_count`. That counts emails, and a four-step sequence sends up to four to one person. Live: 26 sent, 15 contacted |
| Delivered | `sent_count` minus `bounced_count` | "Sent" is what we handed the tool. Delivered is what landed |
| Replies | `campaigns.replied_count` | Instantly's count, the same number the reply rate is built from |
| Interested | `reply_handling_actions` rows whose `classified_intent` is in the client-visible set | NOT `signals.signal_type = 'positive_reply'`, which nothing has ever written. See below |
| Meetings held | `meetings.meeting_status = 'held'` | Booked is shown separately in the footnote. A meeting counts as held only after somebody confirms it happened |

**The positive-reply count read zero for structural reasons, not for want of replies.**
Both metrics functions counted `signals` rows with `signal_type = 'positive_reply'`. Nothing
in this system has ever written that value: the poller writes `reply_received`, and the
classifier writes its verdict to `reply_handling_actions.classified_intent`. Live check on
2026-08-24, every org: 14 signals, all `reply_received`, zero `positive_reply`. The fixture
in the test suite inserted the phantom value by hand, which is how a metric that could
never be non-zero passed its own test for months.

**Liveness never comes from `campaigns.status`.** It comes from `deriveCampaignLiveness`
in `src/lib/dashboard/campaign-liveness.ts`, reading `sending_state`, and it refuses to
say "Sending" on a reading older than an hour (four missed polls). "Not reported" is a
state a client is shown. A guess is not. The function is pure and deterministic, per
ADR-018: thresholds and a lookup table, no model.

**The setup checklist follows the emails, not the paperwork.** Both the sidebar steps and
the Campaign setup card mark complete once anything has sent, whatever
`deriveCampaignsStatus` says. That function reads shell sync and lead uploads, which can
still read `in_progress` for a campaign that has already sent, and it was telling a client
with a running sequence that their campaigns were not live yet.

**What to check if it breaks:**
- All five counts zero while Instantly shows activity: check `campaign_stats_updated_at` on
  `campaigns`. If it is stale the poll is not running. See integrations.md.
- "Interested" zero while the replies page shows cards: both read
  `reply_handling_actions` with the same intent list, imported from
  `get-client-visible-replies.ts`. If they disagree, someone has made a second copy of
  that list.
- Everything zero for a client but correct for an operator: RLS. See below.

### Client replies — /dashboard/replies

Nav entry added; the route had existed with nothing linking to it. Full detail of what the
card shows and what it must never show is in reply-handling.md, "What a client sees".

### Client benchmarks — /dashboard/benchmarks

**No targets. Ranges only.** The page used to render "Target ≥ 2%" under a meeting
booking rate we underwrite at roughly 0.9%, beside a status pill reading "On track" or
"Below target". A target on a client's dashboard is a promise, and that one committed us
in writing to missing it by half every time they opened the page. The thresholds are
DELETED from `tier1-benchmarks.ts`, not hidden, so there is nothing left to render one
from. Do not reinstate them there; an internal alerting threshold belongs in the operator
warnings engine.

What replaced the status pill is positional, not evaluative: "Within the industry range",
"Above", "Below". It says where the number sits, not whether it is good. For a bounce rate
"below" is excellent and for a reply rate it is not, and the client knows which of their
numbers they care about better than a colour does.

**Rates wait for a sample.** `src/lib/benchmarks/sample-gate.ts`, deterministic per
ADR-018. Until the denominator clears the minimum the card shows an em dash and "too early
to report a rate", with how far off it is. The counts are always shown, because those are
true from the first email; only the rate has to wait.

| Gate | Value | Derivation |
|---|---|---|
| Send-denominated rates (reply, meeting, bounce, opt-out) | 400 emails | standard error of a proportion under 1 point at a 4% rate needs n ≈ 384; at a 1% rate, under half a point needs n ≈ 396 |
| Positive reply share | 25 replies | denominator is replies and the proportion sits near half, where the error is widest: a 10-point standard error needs n = 25 |

The number this exists to stop showing: 1 reply from 26 emails renders as 3.8%, sits
neatly inside the published industry range, and looks exactly like a measurement. The next
reply takes it to 7.7%. A zero rate is withheld on the same rule, because 0% from 26
emails is equally noisy and reads as a far more alarming claim. Both thresholds are
rounded on purpose: they are a judgement about when a number stops being noise, and
writing 384 would imply a precision that is not there.

**Bounce rate and opt-out rate are now shown.** They are on the list of aggregates a
client is always shown and previously had no surface anywhere. This REVERSES the earlier
rule in `get-client-visible-campaign-metrics.ts` that `bounced_count` must never be
fetched or returned. The reversal is deliberate: hiding a client's own bounce rate
protects nothing and leaves them unable to tell a list-quality problem from a copy
problem. What is still protected is the distinction between a TOTAL and an ATTRIBUTION. A
client may see how many bounced. They may never see which addresses did, nor per-mailbox
health, nor complaint rate.

**The Belkins citation is removed.** The page cited Belkins's 2025 study beside a 1 to 3%
meeting booking range. Belkins's own published production figure is 0.16 meetings per
1,000 emails, which is 0.016%, roughly a hundredth of the bottom of the range they were
cited to support. Citing a source that contradicts the figure beside it is worse than
citing nothing. Do not re-add it. See BACKLOG.md: the question it leaves is about the
RANGE, not only the citation.

**A plain paragraph on the first ninety days** sits above the cards, with no numbers in
it. A target in prose is the same promise the cards no longer make.

### Strategy nav — collapsed only when there is nothing to do

`src/lib/dashboard/strategy-nav-state.ts`, deterministic. Three states:

- **all_approved** — collapses by default. The four documents are reference material once
  approved; a client reads them twice and then wants the space back.
- **blocking_upload** — NEVER collapsed. `assertStrategyApproved` blocks the lead upload
  until all four carry `client_approval_status = 'approved'`, so an unapproved document is
  the thing standing between the client and any outreach at all. Collapsing would hide the
  blocker behind a chevron and leave the client waiting on us while we wait on them. A
  MISSING document counts as unapproved, exactly as the upload gate treats it, so the
  worst version cannot happen: nothing on screen to click and the upload silently blocked.
- **pending_version** — expanded. A suggestion the client has not acted on. Nothing is
  blocked, but there is something to do.

Blocking outranks pending, so the client is told about the blocker first. The section also
force-expands on any `/dashboard/strategy` route and disables its own toggle there, so it
cannot collapse away the page the client is standing on.

### The RLS trap, which has now cost this build three times

**A client's session Supabase client returns ZERO ROWS, silently, on every table a client
cannot read.** No error. No exception. An empty array, which renders as a confident `0`.

Tables a client session cannot read at all: `prospects` (policy
`clients_read_own_prospects_denied`, `USING (false)`), `signals`, `reply_handling_actions`,
`reply_drafts` — all operator-only. Tables a client session CAN read: `campaigns`,
`meetings`, `organisations`, `intake_responses`, `strategy_documents`.

The rule: **any client-facing read of a protected table uses the server-side service-role
client.** That is ADR-027's two-client pattern. The session client authenticates the user
and resolves which organisation they may see; the service client performs the read.

`getClientVisibleCampaignMetrics` now **builds its own service-role client and takes an
organisation id only**. The caller cannot pass one in, so nobody can hand it a session
client by mistake. The two clients are the same TypeScript type, so nothing catches that
mistake at compile time and nothing raises at runtime, which is exactly why it kept
recurring.

The cost, stated plainly: org-scoping there has no RLS backstop any more. The
`.eq('organisation_id', orgId)` on every query IS the gate. Every query in that file must
carry it.

## View inventory (to be built)
- Empty state view (months 1–2 default)
- Client pipeline view (post-unlock)
- Operator view
- Strategy document view
- Approvals view

## Phased unlock reminder
Pipeline view locked until: 2 months elapsed OR 5 meetings booked (whichever first).
Controlled by organisations.pipeline_unlocked field.
