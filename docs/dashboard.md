# dashboard.md — Dashboard Reference
# Partial. Update as each view is built.
# Cover: all views, what each shows, why, what to check if a view breaks.
# The spec is in /prd/sections/12-dashboard.md. Design tokens in /docs/design.md.

> **2026-09-03: the strategy document page changed.** The Approve button, the pending
> state and the operator "Proceed without client approval" link are gone. In their place:
> a line saying which version is live and when it changed, a View previous panel listing
> every version with the note that produced it, and, for operators only, Restore this
> version and a stale notice with a regenerate action beside it. See ADR-047.
>
> Restore is operator-only on purpose: it rewrites the copy every future email is composed
> from. On messaging the panel states plainly that it affects emails composed from that
> point on and does not rewrite emails already generated.

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

#### Sourcing runs list (added 2026-09-02)

Underneath the cards, one line per sourcing run, newest first, newest already open.

**Why a list and not "the latest batch".** The first instinct was to default to the most
recent batch, because the operator's question is almost always "how did the thing I just
did go". Measurement changed the answer: on 2026-08-10 FOUR runs happened inside three
minutes, writing 25, 2, 1 and 1 prospects. "The latest batch" would have silently picked
one of those four and shown 1, which is the same lie by omission as the all-time sum, only
smaller. The list makes the real shape visible instead of choosing for the reader.

**Every line names its scope and its date.** A number is never shown here without the run
and the day it belongs to. A default that is not visibly a filter is precisely the defect
this screen change was made to fix.

**More than one run can be open at once**, so two batches can be compared. An accordion
would keep the screen shorter and make the second most useful thing on it impossible.

**The funnel, per run.** Added, approved, enriched, kept by tiering, email verified, can be
emailed, researched, has an opening line. Each stage shows what was lost from the stage
above it and why, using the same reason glosses the cards use.

**Three things it deliberately makes visible:**

1. **Prospects belonging to no recorded run** get their own group. They are counted in the
   cards, so hiding them would make the cards and the lines disagree with no explanation.
2. **A reconciliation sentence** at the bottom: so many in the runs above, plus so many
   from no recorded run, equals the client total. It is computed and displayed rather than
   assumed, because a silent disagreement between a card and a batch line is the exact
   failure this was built to prevent.
3. **A run whose prospects no longer exist** still gets a line, reading "wrote 25, none
   still here". Three runs are in that state. This is currently the ONLY place in the
   product where a prospect deletion is visible at all. See BACKLOG.

**Where the numbers come from.** All of them come from countRow in
src/lib/operator/sourcing-metrics.ts, the same function that produces the cards, walked
over the same rows from the same read. A batch line and the card above it cannot mean
different things by "tier 1", because there is only one place either is decided.

**What to check if it breaks.** If a run is missing, check sourcing_runs for that
organisation. If the reconciliation sentence does not add up, the per-run stage counts are
bounded by STATUS_ROW_LIMIT and the screen says so separately when that ceiling is reached.

### Operator quality review — /dashboard/operator/sourcing-review/review

What it shows: the enriched prospects grouped into tier 1, 2 and 3, AND, since 2026-08-27,
the prospects tiering removed, counted by reason.

**Why the removal counts are here.** The three tier sections are survivors. Until this was
added the screen fetched only rows with a non-null `sourced_tier`, so an operator looking at
twelve tier-1 rows had no way to tell whether the batch was twelve prospects or two hundred,
and no way at all to see that forty-seven went out on `industry_not_consulting`. A filter
that removes most of a batch looked identical to a batch that was simply small.

**How removed is distinguished from not-yet-tiered.** Both have `sourced_tier` NULL.
`tiering_reason` is the discriminator: `classifyTier` writes one on every path, survivors
included, and nothing else in the codebase sets that column. The review page counts rows
where `sourced_tier IS NULL AND tiering_reason IS NOT NULL`.

**Counts, not a list.** The removed prospects are aggregated by reason server-side and only
the counts are sent to the browser. The count is what says whether the filter is behaving. A
long list of rejects is not what this screen is for.

**The Review quality link is reachable when everything was removed.** It used to appear only
when at least one prospect reached a tier, which hid this screen in exactly the case where
its breakdown is the only thing explaining where the batch went. When nothing survived, the
link reads "See why all were removed" and the screen leads with a red panel saying so,
rather than the old "No enriched prospects yet", which reads as "nothing has run".

**The count is stable between runs, and a spec change can empty it.** Since ADR-037
tiering skips prospects that already carry a reason, so these rows are decided once rather
than re-decided on every run. Storing a new ICP filter spec clears the reason for the
organisation's removed prospects and puts them back in the queue, so the removed count
drops to zero and then refills as the next tiering runs re-decide them. That is expected,
not a bug, and the re-queue logs at `warn` with the count at the moment it happens.

What to check if it breaks:
- The reason codes are the raw `tiering_reason` values. `REMOVAL_REASON_LABELS` in
  `Gate2TieredReview.tsx` glosses them into English; a reason with no gloss still renders,
  under its raw code, on purpose. A row showing a bare code means the classifier has a
  reason the label map has not caught up with, which is worth seeing rather than hiding.
- The same counts are logged at `warn` by `logClassificationStats`, with flat keys such as
  `removed_industry_not_consulting`. Screen and log disagreeing means one of them is reading
  a stale batch.

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
| Contacted | `campaigns.contacted_count`, filled from the provider's `new_leads_contacted_count` | NOT `sent_count`, which counts emails: a four-step sequence sends up to four to one person. Also NOT the provider's own `contacted_count`, despite the matching name. See the warning below |
| Delivered | `sent_count` minus `bounced_count` | "Sent" is what we handed the tool. Delivered is what landed |
| Replies | `campaigns.replied_count` | Instantly's count, the same number the reply rate is built from |
| Reply rate | `replied_count` ÷ **`contacted_count`** | PEOPLE, not emails. A four-step sequence sends up to four emails to one person, so the send denominator counted the same person up to four times. Live: 2 of 60 emails reads 3.3%, 2 of 24 people reads 8.3%, and the published range is measured the second way |
| Interested | `reply_handling_actions` rows whose `classified_intent` is in the client-visible set | NOT `signals.signal_type = 'positive_reply'`, which nothing has ever written. See below |
| Meetings held | `meetings.meeting_status = 'held'` | Booked is shown separately in the footnote. A meeting counts as held only after somebody confirms it happened |

**The one that already went wrong: "prospects contacted" showed 52 for 24 people.**

`campaigns.contacted_count` used to be filled from the provider's field of the same name,
on the strength of its documentation, which describes it as "Number of leads for whom the
sequence has started". Read live on 2026-09-03, that field returned **52 for a campaign
with 24 leads and 60 emails sent**. More people contacted than exist, rendered to a client
as "52 prospects contacted". It overstated reach by more than double and halved the
apparent reply rate.

It is not simply an email counter either. The same campaign was captured on 2026-08-24
reporting `contacted_count` 15 against `leads_count` 15 and `emails_sent_count` 30, where
it matched the people count exactly. The field agreed with people for weeks and then
stopped, which is why nobody caught it by looking.

The column is now filled from `new_leads_contacted_count`, checked on the same day against
two things that are not documentation: a `FILTER_VAL_CONTACTED` lead listing returning
exactly 24 distinct leads, and per-step analytics showing 24 / 23 / 13 sends, whose first
step is everyone with at least one send.

**If this number ever looks wrong again, do not read the API docs to settle it.** Count the
leads. `mapContactedCount` in `campaign-analytics.ts` refuses any value above
`leads_count`, and the poller leaves the column at its last good value rather than writing
one that cannot be people, so a repeat of this shows up as a stale number and a warning
log, not a confident wrong one.

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

### Operator replies — /dashboard/operator/clients/[id]/replies

**What it is for.** The client replies page exists to filter negative replies OUT. That
left no surface anywhere showing them IN, so an opt-out or a hostile reply was invisible
inside our own product to the person running it.

The scale of it, checked against the live database rather than estimated: 12 classified
replies exist, but 11 are DRY RUN and test-fixture rows. Exactly one sits in a real
organisation, MargenticOS, and its intent is `opt_out`. The only reply the real org has
ever received was therefore visible nowhere in the product.

The route already existed and **nothing linked to it**, the same fault the client replies
page had. It now has an operator sidebar entry that follows the selected client, so it is
reachable without typing an organisation UUID into the URL bar.

**It does not go through the client chokepoint, on purpose.** `getClientVisibleReplies`
exists to enforce the intent filter at one place; this view exists to bypass exactly that
filter. Adding a flag to the chokepoint would put the switch that disables the filter
inside the function whose whole job is applying it. So there are two functions in two
files, and no shared switch:

| | client | operator |
|---|---|---|
| function | `getClientVisibleReplies` | `getOperatorRepliesForOrg` |
| file | `get-client-visible-replies.ts` | `get-operator-replies.ts` |
| intents | 5, filtered in SQL | all 8, no filter |
| reply body | verbatim | verbatim |
| drafts shown | `status = 'sent'` only | every status, including `pending` |
| intent label leaves the file | never | yes, that is the point |

`get-operator-replies.unit.test.ts` is the mirror of the client unit test: where that one
asserts the intent filter is PRESENT, this one asserts it is ABSENT, so a future tidy-up
that routes this through the chokepoint fails a test instead of quietly hiding half the
replies again.

**The context panel is often empty, and that is the data, not a bug.**
`signals.original_outbound_body` is populated on 2 of 14 signals and only 3 `reply_drafts`
rows exist at all, so most cards have no "what we sent them" and no drafted reply to show.
The "Show context" control is hidden entirely when a reply has neither. Note that
`original_outbound_body` lives on `signals`, NOT on `reply_drafts`.

**Grouped by intent, with counts.** Positive intents first, the ones that end a
conversation last, and a summary line carrying the total plus how many are hidden from the
client. Grouping and counting are deterministic code per ADR-018. Read-only: no approve,
reject or send from this page.

**Service-role read, though RLS would have allowed a session read.** Operator policies do
exist on all three tables (`operators_read_reply_handling_actions`,
`operators_full_access_signals`, `operators_full_access_reply_drafts`), so an operator
session client can read them today. It still builds its own service-role client, because
RLS returns zero rows without an error and a page whose failure mode is "you have had no
replies" must not depend on three policies staying correct. ADR-027 two-client pattern:
the session client proves the operator role in the route, the service client reads.

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
| Bounce rate | 400 emails | standard error of a proportion under 1 point at a 4% rate needs n ≈ 384; at a 1% rate, under half a point needs n ≈ 396 |
| Reply rate, opt-out rate | 400 people | same algebra, different unit. n is a count of people, and the formula assumes n INDEPENDENT trials: four emails to one person are one person deciding once, not four chances |
| Meeting booking rate | 1,500 people | derived separately, NOT copied from the reply gate. Meetings run near 0.9%, and half a point apart at that rate needs 0.0025 = sqrt(0.009 × 0.991 / n) → n ≈ 1,427. At 400 people the expected meeting count is about 3.6, and a rate off 3.6 events moves by a third of itself when the next one lands |
| Positive reply share | 25 replies | denominator is replies and the proportion sits near half, where the error is widest: a 10-point standard error needs n = 25 |

**EVERY RATE STATES ITS UNIT, AND THE UNIT DRIVES THE ARITHMETIC.** This is the fix for
the worst defect this page has produced, and it is worth reading before changing any rate
here.

On 2026-09-02 the reply rate moved from emails sent to people contacted. That is the
better statistic and it stands. What the change missed is that the 3 to 6% range it was
rendered beside came from the Instantly report, which defines its metric as "percentage of
all replies received (including follow-up responses) divided by TOTAL EMAILS SENT". Per
email. So the page divided by people and compared the answer against a range built by
dividing by emails, and the code comments in both files asserted the opposite. Half a
comparison moved.

Fixed on 2026-09-03 by moving the RANGE, not by reverting the rate. `replyRate` now cites
Smartlead's State of Cold Email 2026 (850M+ emails, median 0.74% of contacts, top 10%
2.63%+) and ReplyLead's August 2026 analysis (115 campaigns, 242,669 unique leads, median
2.12% per contacted lead, interquartile 1.39% to 3.00%). Both state a per-contact
denominator in their own words. The range spans them at 0.7 to 3%; the two medians differ
threefold, which is a real disagreement between populations rather than something to
average away.

**The structural guard.** Every entry in `tier1-benchmarks.ts` declares a `unit`, and
`BenchmarksView` derives its denominator from it through `denominatorFor()`. A card cannot
say "people contacted" while dividing by emails: changing the unit changes the arithmetic,
and there is no second place to update. Both halves of the comparison print their unit,
ours on the counts line ("160 replies from 2,000 people contacted") and the published
range on its own ("0.7–3% of people contacted"), because a reader who can see only one of
the two units cannot tell whether they match. That was the state of this page for a day.

**The meeting booking rate has no industry range, deliberately.** It read 1 to 3%, cited
to the Instantly report, which publishes no meeting metric at all in any unit. The number
had no source. That is the SECOND citation to fail on this one card; Belkins was removed
before it for contradicting the same range. Four replacements were read and rejected: the
only one with a stated method (GROU, 0.35% median across 47 B2B clients) measures per
SEND, and the rest are unattributed vendor opinion, several of them attributing 1 to 3% to
the Instantly report that does not contain it. The card shows the rate alone and says on
its face that there is no range. In the type system this is a discriminated union member,
not an optional field, so removing a range without writing down why does not compile.

Bounce stays per email and must: deliverability is a property of a message, not of the
person it was addressed to, and the Google and Yahoo guidelines it is compared against are
stated per message too. The positive share is of replies and always was. **Opt-out moved
to people on 2026-09-08** and no longer stays with bounce; see the section below.

**THE OPT-OUT CARD COUNTS OUR OWN RECORDS, NOT THE PROVIDER'S. 2026-09-08.**

It read 0 for a client two people had written in to say stop. Both were classified
`opt_out`, both were suppressed, both had `reply_handling_actions` rows. The card was
dividing `campaigns.unsubscribed_count` by emails sent.

**The provider's number is blind to our opt-outs by construction, and always will be.** It
counts unsubscribe LINK CLICKS. Our opt-out footer is "Not for you? Just reply stop." There
is no link to click, on purpose. So a client running our copy as designed produces opt-outs
the sending tool cannot see. This is not a sync lag that closes; it is the two systems
counting different events.

The numerator is now `peopleOptedOutCount`: distinct prospects with
`classified_intent = 'opt_out'`, read from `reply_handling_actions` at the metrics
chokepoint. Same table, same helper and same shape as `peopleRepliedCount`, so the opt-out
count and the overview's reply count cannot drift apart.

Not read from `prospects.suppressed`, which is also true for operator stops and research
disqualifications and would have read 7 against 2 on the live org. Not read from
`prospects.suppression_reason = 'explicit_opt_out'` either, which narrows correctly but is
a materialised verdict written only where a prospect row resolved and the update succeeded.
The action row is written FIRST, before dispatch, and a person whose suppression write
failed still told us to stop.

**The unit moved with the numerator**, which is the half the 2026-09-02 defect got wrong. A
person opts out once and is suppressed from every remaining step, so the count is
de-duplicated people and the denominator is people contacted. Live: 2 from 69, about 2.9%,
where the provider said 0 from 117.

**`campaigns.unsubscribed_count` is no longer selected or returned at all.** A
client-facing metrics type carrying a field known to read 0 while people are opting out is
an invitation to render it again. `campaign-metrics-failure.test.ts` asserts the exact
select string, so putting the column back turns that registry red.

**The 0 to 1% range came off rather than being relabelled.** Every published opt-out figure
checked on 2026-09-08 counts link clicks per email sent: Omnisend, Listclean and Smartlead
all state 0.1 to 0.5% or "under 2%" per send. ReplyLead's August 2026 dataset holds 103
unsubscribes across 242,669 unique leads, which is 0.04% per contacted lead if computed
from their raw counts, but they do not publish it as a benchmark and it is link clicks too.
So no published figure counts what we count: both the numerator and the denominator differ.
The old citation also read "Aggregated B2B research", which names no study, the same
failure that removed the meeting range. The card now says there is no range and why.

**The positive reply share lost its range on 2026-09-21, for the third instance of the
same failure.** It was cited to "Aggregated B2B research" as well. Its lower bound, 40,
turned out to be our OWN operator alert threshold from `prd/sections/11-warnings.md`
printed back at the client as research; 65 has no source anywhere. Published figures for
this metric disagree by about 3x and none defines a positive reply the way our own
classification does, so none was substituted. No range on this page is now self-cited.

**What this makes visible, said plainly because it is uncomfortable.** The client's own
opt-out rate is roughly 2.9%, well above the 0 to 1% that used to be printed. The range
coming off is not what hides that: the count is on the card either way, and the old 0 was
the thing hiding it. Note the sample gate still withholds the RATE at 69 people, so what
renders today is "2 opted out from 69 people contacted" and "too early to report a rate".

**NO COPY ON A CLIENT SCREEN EXPLAINS OUR OWN PAST DECISIONS. 2026-09-08.**

The attribution notes carried a paragraph reading "The figure previously shown here cited a
report that does not measure meetings", and the meeting card's own absent-range note opened
with the same sentence. Both are deleted. **A client never saw the old figure**, so the
sentence reads as an apology for something that never happened to them, and it spends their
attention on our changelog instead of on what they are looking at.

The forward-looking half of each note stays, because that explains what is on screen now:
"No published range. We could not find a source that measures meetings booked per person
contacted." The reasoning lives in `sourceCitation`, which is a field on every benchmark
and **is never rendered** (`BenchmarkCard` reads `sourceLabel` only), and in the source
file comments.

`BenchmarksView.test.tsx` guards this with a sweep for "previously", "no longer", "used to",
"shown here" and "Removed 2026" over the rendered page, paired with a positive control that
proves the sweep can find a string that IS on the page. A `not.toContain` sweep that never
ran looks exactly like a clean page.

Audited on 2026-09-08 across `src/app/dashboard/(client)/` and every client-facing component
and copy module. Two instances existed, both on this page, both now gone. Everything else
matching that grep is a code comment, which is where this reasoning belongs.

**The ninety-days block is collapsed by default.** It was four paragraphs above the
cards, which is why nobody read it. It is now a disclosure with the lead line
("Cold outreach is slow before it is fast.") visible collapsed. The trade-off is named in
the code: this block is the answer to the question the sample gate creates, because at
current volume every rate card reads as a dash and the first client to see that will ask
why. If a client asks anyway, this default is the first thing to revisit.

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

### Company name, editable, with the intake spelling beside it (2026-09-03)

**Where.** Operator → Clients → a client → Client profile → Company name.

**What it does.** The name is editable in place, and if the client typed a different
spelling into intake, that spelling is shown underneath with a warning.

**Why it needed building.** The company name exists in two places written by two people
weeks apart. `organisations.name` is typed by the operator when the client is created. The
`company_name` intake response is typed by the client. Nothing compared them, and NEITHER
had an edit path, so a typo at client creation could only be fixed with a direct database
write.

That is not a cosmetic field. `organisations.name` is the **second line of the sign-off
block on every email**, read by the messaging agent's preflight and enforced there by a
validator that compares the last line of every body against it.

**What the operator sees, and why the wording matters.** Regenerating a messaging document
rewrites its copy and forces the sign-off to whatever `organisations.name` holds. For a
client whose two names differ, that can change the company name in copy they have already
approved. The notice says so, because that is the question an operator will have the moment
they see the two names disagree.

**Three states, not two.** No intake answer, an answer that matches, and an answer that
differs. An empty intake value must not render as "not answered": one live organisation is
in exactly that state.

**What it deliberately does not do.** It never changes anything on its own, and it does not
suggest which spelling is right. That is a question for the client.

**Refusals.** An empty name is refused rather than written, because the messaging agent
fails preflight without one and that failure would land days after the click that caused
it. A name over 120 characters is refused as a paste accident.

### Operator settings — /dashboard/operator/settings (rewritten 2026-09-10)

**What it shows.** One client's settings, read from the organisation record, plus the
platform's integration registry. It needs `?client=`, which the sidebar carries because the
Settings nav entry is marked `perClient`.

**What it showed before, and why that mattered.** Every value came from a hardcoded
`PLACEHOLDER_SETTINGS` literal. Measured against production on 2026-09-10 it claimed an
organisation name matching no record, a booking link belonging to nobody, four integrations
"Connected" when the registry had two rows reading connected and all four of those named
read disconnected, and a "last verified" date for each — against a table that **has no
`last_verified` column at all**, so that field had nowhere to have come from.

There was an amber banner saying the page was not wired to live data. It was true. It did
not help: a screen of invented values is read by whoever opens it, and a caveat is read
once. The lesson worth keeping is that **a warning is not a substitute for not lying**, and
an empty state naming what is missing is smaller and more useful than a plausible sample.

**No client selected is a state, not a gap.** This page deliberately does not use
`resolveViewingOrg`. That helper falls back to the caller's own `organisation_id`, and for
the operator account that points at an archived organisation, so falling back would render
one organisation's real settings under another organisation's heading. A client that was
requested but not found says so separately from one that was never picked, because a stale
bookmark and an empty selection need different fixes.

**The booking link is the only editable field, and that is a rule rather than a stage.** It
is the one value with all four of: a real typed column (`organisations.booking_url`), a
locked decision requiring it to differ per client (2026-07-28), something already reading it
live (`process-reply.ts` puts it in the reply a prospect receives), and no way to set it
outside SQL. Anything else earns an edit control by having all four.

Validated as an https URL and never as a vendor. The 2026-07-28 decision makes booking
*detection* tool-specific (Cal.com since 2026-09-11, ADR-056) but the link itself tool-agnostic, so a hostname check here
would be Rule Zero and would refuse the case that decision anticipates. Clearing the field
writes NULL, not an empty string: an empty string passes a truthiness check downstream and
would put a blank link into a prospect's reply.

**The integration pill reads `is_active`, not `connection_status`.** `is_active` is what
every registry lookup in the codebase actually filters on. `connection_status` is read in
exactly one place, `executeCapability`, which has an empty handler map and zero callers, so
it describes nothing that currently runs. It is therefore printed verbatim as a stored value
rather than translated into a verdict.

**Integrations are labelled platform-wide, because they are.** `integrations_registry` has
no organisation column, and presenting those rows under a "Per-client configuration"
heading was part of what this page got wrong. A per-client registry was considered and
refused on 2026-09-10: `getCapabilityRow` is a `rows.find()` over an unordered select,
cached process-globally for five minutes, so a second row per capability would serve one
client's configuration to another. Tracked in the Notion Backlog, gated Before scale.

**Both toggles were removed, not disabled.** Neither "LinkedIn post auto-approve" nor the
holding message had any implementation anywhere. The LinkedIn one was the worse of the two:
it displayed on from a literal while `organisations.linkedin_channel_enabled` is false on
every row. The holding message also described the 15h/48h/72h chain that ADR-019 explicitly
superseded.

**What to check if it breaks.** An empty per-client section means no `?client=` reached the
page — check the sidebar's `perClient` flag on the Settings entry. "That client could not be
found" against a real client means the row is not readable, which is an RLS question:
`operators_full_access_organisations` is what lets an operator read another organisation.

**What it still does not do.** Every other per-client value on the organisation record is
read-only here, and changing it is a database change. That gap is a Notion Backlog row.

### Operator meetings — /dashboard/operator/meetings (2026-09-12, funnel added 2026-09-14)

The only screen where held or no-show can be recorded by hand, and the only place the reason
a meeting became billable is visible. Cross-organisation: it takes no client parameter.
Linked in the operator sidebar as **Meetings**; `operator-page-reachability.test.tsx` fails if
it ever stops being.

Four blocks, in the order a person needs them.

**Speed to booking, and the drop-off** (the funnel panel). Two measurements that are only
honest together, computed by `computeBookingFunnel` in `src/lib/meetings/booking-funnel.ts`:

- **Time to booking**, per booking and as a median with **n stated**. Measured from
  `reply_handling_actions.link_sent_at`, never from `updated_at`: see the note on that column
  in data-model.md, because the difference only ever flatters.
- **Sent a link, never booked**, oldest first, counted only once the link is more than
  `MINIMUM_AGE_HOURS` (24) old, which the panel prints. Someone linked this morning has not
  dropped off, they are still deciding.

**WHY ONE PANEL AND NOT TWO CARDS.** A median over people who booked counts only successes,
so it can only look good, and it IMPROVES AS CONVERSION FALLS: if only the fastest bookers
still convert, the median drops and reads as a win. The never-booked list is the denominator
that makes it meaningful, so both come from one computation over one read and neither can be
rendered alone.

**Three counts are rendered even at zero**, which is the point of them:

| Count | Why it must never be absent |
|---|---|
| Asked to book and the send failed | The never-booked list counts links we actually sent, so it drops these people. They asked and got nothing: the most expensive rows here, invisible on the screen built to find them |
| Bookings with no prospect attached | Cannot be joined to a link send, so they would leave the sample without trace while the person who booked still looked like a drop-off |
| Bookings quarantined to no client | The same story from the other side, read from `unattributed_bookings` |

A negative interval, where a booking predates the link it is attributed to, is rendered as a
**fault** in red: no minutes, excluded from the median, and counted. Clamping it to zero would
pull the median down, which is the flattering direction, and the disorder would never be seen.

**Tier 1 only, and the panel says so.** Only the automatic reply path writes `link_sent_at`.
An operator-approved draft can carry a booking link and records no fact about whether it did,
so those are excluded. No draft has ever reached `sent`, so the population is complete today
and stops being complete the moment one does.

Then the three outcome sections: **due to bill unconfirmed** (within 7 days of the deadline,
never-asked flagged), **awaiting an outcome**, and **decided**, each billable meeting showing
its `billable_basis` in words. Two buttons per undecided row, posting to
`/api/meetings/confirm`; the screen repeats that route's own `recorded` field rather than
assuming success from an HTTP 200.

**What to check if it breaks.**
- Numbers all zero: a failed read is returned as an *error* and the panel says so instead of
  rendering zeros, because a zero on a drop-off screen reads as "nobody dropped off". If you
  see zeros rather than a message, they are real.
- Everything reads "Unknown client": the page collects organisation and prospect ids from the
  funnel rows as well as the meetings, because never-booked prospects have no meeting at all.
- Median present but n = 1: that is one observation, and the panel labels it as such.

### Lead upload — how many of these have never been researched (2026-09-17)

**What it does.** On the operator client detail page, under the "Pending leads ready to
upload" number, a plain sentence appears when some of those prospects have never been
researched:

    18 of these 21 have never been researched. They will send your standard opening
    line, not one written for each person.
    You can still upload them. Research them first only if you want a personalised opening.

The same fact rides on the button: `Upload 21 pending leads (18 with your standard opener)`.

**When the count is zero the panel says nothing at all.** No empty state, no zero badge.
A reassuring "0 unresearched" is one more thing to read, and a corner of the screen that
is usually empty teaches an operator to stop looking at it.

**Why it exists.** An upload of 21 prospects went out where 18 had never been researched.
All 18 shipped the client's authored opener, which is a legitimate email to send, and
nothing on the screen said so. The operator read "21 pending", which was correct, and which
carried no consequence.

**It is visibility, not a gate.** Nothing blocks, disables or shrinks the upload. The button
stays pressable at any count, including when every prospect is unresearched, because an
unresearched send is sometimes the correct send. There is a test asserting exactly that.

**What connects to what.** `src/lib/operator/unresearched-send-gate.ts`. It holds two query
builders and the two sentences. `unresearchedSendGateCountQuery` calls `sendGateCountQuery`
and adds one clause to what comes back, so the two numbers the operator compares ("18 of
these 21") are one population measured twice rather than two predicates that agree until
somebody edits one.

**The research clause is deliberately NOT in `applySendGate`.** Putting it there would
narrow the claim itself: the upload would quietly take fewer prospects than the operator
asked for, and the operator's own count would shrink to match, with nothing on screen
explaining the difference. `src/lib/sourcing/send-gate.ts` decides who CAN be sent; this
module only describes them. A test asserts the gate's predicate byte-for-byte against a
frozen literal, so moving a research condition into it fails loudly.

**"Never researched" means `research_ran_at IS NULL`**, the same definition
`src/lib/operator/sourcing-metrics.ts` already uses, so the two cannot disagree about the
word. It is NARROWER than "will ship the authored opener": composition ships that opener
whenever `personalisation_trigger` is empty, which also covers prospects that WERE
researched and whose writer then stopped. Those are already listed individually in
`WriterStoppedPanel` with synthesis's own note, so counting them here would make two panels
disagree about the same prospect.

**What to check if it breaks.** Both counts fail loud through `requireCount`, so a refused
read throws rather than rendering as "everything has been researched", which is the
reassuring direction and the one an operator cannot check. If the sentence never appears,
confirm `research_ran_at` is actually null for the prospects in question before suspecting
the component: the research agent stamps it on every run.

## View inventory (to be built)
- Empty state view (months 1–2 default)
- Client pipeline view (post-unlock)
- Operator view
- Strategy document view
- Approvals view

## Phased unlock reminder
Pipeline view locked until: 2 months elapsed OR 5 meetings booked (whichever first).
Controlled by organisations.pipeline_unlocked field.

---

## Generation status: what the screen says while a document is being made

Added 2026-09-07, after the dashboard spent two days telling an operator that a suggestion
was being prepared for a run that had already failed.

### What connects to what

`/api/suggestions/regenerate` returns **202 on acceptance** and runs the agent in `after()`,
so the response says nothing about whether a document was produced. Two controls call it:

- `RegenerateButton` — operator only, on an existing document
- `NotYetGeneratedState` — client-reachable, when no document exists yet

Both then poll `/api/generation-status`, which reports the most recent run for that
organisation and document type as an **outcome**:

| outcome | meaning |
|---|---|
| `generating` | a run is in flight and started within the last 10 minutes |
| `succeeded` | the most recent run completed |
| `failed` | the most recent run failed |
| `stalled` | the run says running but started outside the window, so nothing is coming |
| `none` | no run has ever been recorded |

`error_message` is returned to **operators only**. A client cannot act on "Claude returned
content that is not valid JSON" and it names our internals.

### Two things that look like details and are not

**Polling is anchored to the button press.** The status route answers with the LATEST run,
which on a document page is usually a previous, completed one. Without comparing
`started_at` against the moment the button was pressed, both controls would report the
previous regeneration's success as this one's, instantly, and be wrong in the most
convincing way available.

**Both call `router.refresh()` on success.** The page is a server component with no
revalidate. Without that call a SUCCESSFUL run also looks like a hang, because the finished
document never appears until a manual reload.

Polling stops after six minutes and reports `stalled`. Observed runs take 85 to 120 seconds
and the agent's own guard is 240s, so reaching the ceiling means no verdict is coming.

### What to check if the screen hangs again

1. `agent_runs` for that organisation and `<doc_type>-generation`: what is the latest row's
   `status` and `error_message`?
2. Hit `/api/generation-status?client_id=…&document_type=…` directly. If it says `failed`
   and the screen does not, the bug is in the component. If it says `generating` for a run
   that is long dead, the freshness window or the reaper is the problem.
3. MON-030, in case the operator alert about the failure also failed to send. See
   `docs/transactional-email.md`.

### Why the old version could not work

The route returned `{ isGenerating }` and nothing else, computed from `status='running'`
alone. A boolean that collapses "still working", "finished", "failed" and "never started"
into one bit gets read as the happy case every time, and it was:

    if (!isGenerating) {
      // Generation completed — clear polling and remain in generating state
    }

A failed run also stops being in flight. See ADR-050 for the wider pattern.

---

## What is moving: stage progress on the pipeline review screen

*Added 2026-09-17, after an operator-to-client walkthrough.*

### What this does

Three long-running steps now report where they have got to, on the operator's pipeline
review screen: **email verification**, **enrichment**, and **research**. Before this, each
one showed a spinner and then a tick, and nothing in between.

### Why it was worth building

The three problems were different and had the same cause.

**Verification had never appeared anywhere in the product.** A cron sweep has verified
addresses since 2026-08-25 and no screen had ever named it. A prospect waiting its turn
behind another client and a prospect nothing would ever touch looked identical: both were
simply absent from everything downstream.

**Refreshing the page erased the progress.** The state lived inside the button that started
the step, so reloading during a step that takes a quarter of an hour showed the screen as it
looks before the step starts. Nothing was wrong, and the screen said nothing was happening.

**Research has a fifteen-minute window with no job in it at all.** This is the one that cost
real time. On the batch path, research runs as two jobs: one fetches the sources, then the
synthesis goes to the model as a batch at half price, then a second job collects the
results. The first job finishes and marks itself done. The second job *does not exist yet*.
Measured on production on 2026-09-17: phase one ended at 19:48:31 and phase two was created
at 20:03:03. For fourteen and a half minutes, 62 prospects were mid-flight with no queue row
anywhere, and the only marker anything reads is written at the very end. An operator
watching that concludes it has stalled, because every other stage announces itself through
the queue and this one cannot.

### How it works

`src/lib/operator/pipeline-progress.ts` reads the progress out of the database: the job
queue, the batch tables, and the columns the sweeps write. It travels on the same polled
payload as the counts, which is what makes it survive a reload and reach a second operator's
screen.

The fifteen-minute window is counted from `synthesis_batch_entries`, because that is the
only place it exists while it is happening.

### The front of that window was still dark, and it is the part an operator meets first

*Corrected 2026-09-22.*

The count above found entries **through their open batch**, and an entry does not have a
batch until the sweep submits it. Phase one writes it in `pending_submission` with a null
`batch_id`; `synthesis-batch-sweep`, every five minutes at three past, gathers those rows
into a batch and sends it.

So for the minutes between phase one finishing and the next firing, every research count on
the screen read zero, the stage read `idle`, and **the whole panel rendered nothing**. The
screen was indistinguishable from one where research had never been started, while a hundred
prospects sat with their sources bought and paid for. The research button still offered to
research the same prospects, because a prospect is only marked researched at the very end.

Measured on production 2026-09-21, for a run of 108:

| time (UTC) | what happened |
| --- | --- |
| 18:05:27 | 109 `research_sources` jobs created |
| 18:06:17 | phase one done for 107, entries written with **no batch** |
| 18:08:01 | first batch created and submitted, 100 entries |
| 18:13:01 | second batch, the 7 that did not fit `MAX_ENTRIES_PER_BATCH` |
| 18:16:01 | provider finished the first batch |
| 18:18:04 | results collected, `research_collect` jobs created |
| 18:29:35 | last opening line written |

The screen now names a fourth research stage, **"Sources done, waiting to be sent to the
model"**, counted by entry **state alone** with no batch filter, which is the only way to see
an entry that has no batch. It also catches an entry requeued from a batch that aged out:
that returns to `pending_submission` and keeps the old `batch_id`, while the batch itself is
`expired` and therefore not open.

It says two things, because a count with nothing beside it still reads as a stall: what has
finished, and **when the next send is**. The time comes from `cron_schedule_registry` and is
omitted rather than guessed when the schedule cannot be read.

The open-batch count now asks for the provider states only, so the two halves of the wait are
disjoint and nothing is counted twice.

### Could the wait itself be shorter?

Yes, partly, and **nothing here has been changed**. Measured against the run above, the 11
minutes 47 seconds between phase one finishing and phase two starting is four separate
things:

| part | measured | what it is |
| --- | --- | --- |
| waiting to be sent | 1m 44s (up to 5m) | the sweep's five-minute period |
| the provider | 7m 58s | the Batch API doing the work |
| waiting to be collected | 2m 03s | the sweep's five-minute period again |
| the 7 that did not fit | a further 5m | `MAX_ENTRIES_PER_BATCH = 100` |

- **The two sweep waits** shrink by shortening the period. They are also *deliberate* on the
  submit side: five minutes is chosen so a client's prospects join one batch and share one
  cached prompt prefix. Firing on each prospect would spend that saving.
- **The provider's eight minutes are not ours**, and they are what is being bought. The Batch
  API is the 50% discount (ADR-033). Removing this wait means the synchronous API at double
  the synthesis cost.
- **The batch cap is the cheapest win.** A run of 108 needs two firings before everything has
  even been sent. Raising `MAX_ENTRIES_PER_BATCH` above the run size would put them in one
  batch and remove five minutes for the remainder, with no effect on price.

None of this is a defect. It is a discount bought with latency, and what was wrong was that
the latency was invisible.

### What to check if it looks wrong

1. **"Waiting for the model" and the number never moves.** Look at `synthesis_batches` for
   that organisation: `state`, `submitted_at`, `last_polled_at`. The sweep that collects
   results is `synthesis-batch-sweep` in `cron_heartbeats`.
2. **Verification says nothing is waiting but prospects have no verdict.** The count uses the
   sweep's own filter (`selectPendingVerification`), so if it reads zero the sweep also sees
   zero. Likely causes: the prospects are not `enriched`, tiering rejected them, or they have
   used all three attempts.
3. **"Checker last ran" is old.** That is platform-wide, not per client. If it is genuinely
   stale, `verify-pending` has stopped, and MON-002 should have said so.

### One decision worth knowing about

**The verification filter has one definition, not two.** It used to be written inline inside
the sweep and nowhere else, so putting a count on the screen would have meant writing the
same condition a second time. It now lives in `src/lib/sourcing/pending-verification.ts` and
both the sweep and the screen apply it. This is the same discipline as `sourcing-metrics.ts`:
if a screen and an action can disagree about what they mean, eventually they will.

---

## Progress an operator can act on

*Added 2026-09-21.*

### The gap this closes

The panel above says **"Waiting to be checked: 38"**. An operator reading that cannot tell a
queue that drains in ten minutes from one that drains tomorrow, and the two call for
completely different decisions. The same number sat there for the whole of a wait with
nothing saying whether anything was coming.

### Verification: when it next runs, and when it finishes

Two new lines, both from the same polled payload:

| Line | Where it comes from |
|---|---|
| **Next check runs** | `cron_schedule_registry`, parsed by `cron-interval.ts` |
| **Estimated to finish** | this client's backlog, the cron period, and the configured per-minute pace |

The estimate is **not** `waiting / rate`. That is the answer if the sweep ran continuously,
and it does not: it works for a budget and then waits for the next firing. A backlog of 200
at 27 a minute is not 7.4 minutes, it is two runs and the gap between them.

**The assumption is printed next to the number.** The sweep takes one organisation per
invocation, oldest backlog first, so the estimate assumes this client is served each run.
That is exact when only this client has work and optimistic when others do. The caption says
so, because a number an operator plans around must not read as stronger than it is.

**Either line is omitted rather than guessed.** If the schedule or the provider pace cannot
be read, the estimate is null and the line does not render. A confident "about 12 minutes"
built on a default nobody chose is worse than a blank line, because it gets trusted.

### Enrichment: how many more presses

Enrichment is **pressed, not scheduled**, so "when does it next run" has no answer for it on
the inline path. The equivalent fact is how many more presses, and it has never been on the
screen.

**One press enriches at most `ENRICHMENT_PER_PRESS_LIMIT` (100) and then stops, however many
are waiting.** That has always been true. Nothing said so, so an operator who pressed with
240 waiting watched the count fall to 140 and had no way to tell whether that was the design,
a partial failure, or a spend cap they had hit. It is the design, and the screen now says it
**before** the press:

> Enriching runs 100 at a time. Pressing once will enrich 100 and leave 140 waiting, so you
> will need to press it again — 3 presses in total to clear them all.

A client whose whole backlog fits in one press gains no warning, because for them there is
nothing to warn about.

The ceiling is **one constant**, exported from `enrichment-trigger.ts`. It was the literal
`100` written twice, in the route and as the trigger's default parameter. The screen renders
the same constant the route enforces, so what it promises and what the button does cannot
drift apart.

A **"Next queue run"** line appears only while the queue actually holds enrichment jobs. On
the inline path the work happens inside the press itself, and naming a scheduled run would be
wrong.

### What to check if it looks wrong

1. **No "Next check runs" line at all.** `cron_schedule_registry` has no row for
   `verify-pending`, or its `schedule` is not a plain minute interval. `cron-interval.ts`
   deliberately refuses anything with an hour or day field rather than guessing.
2. **The finish estimate looks far too optimistic.** Check whether more than one client has a
   verification backlog. The estimate assumes this one is served every run, and the error is
   bounded by how many clients hold work at once.
3. **"Presses needed" disagrees with what a press actually does.** Both read
   `ENRICHMENT_PER_PRESS_LIMIT`. If they disagree, something has reintroduced a second copy
   of the number.

---

## Counts on the operator screens now say what they cover

*Added 2026-09-17.*

Every actionable count on the pipeline screen was an all-time total across every sourcing
run the client had ever had, and none of them said so. On the live organisation they spanned
five runs and each read as one batch.

Each control now splits its number: how many came from the most recent run, and how many
carried over. The wording lives in one place, `src/lib/operator/run-split.ts`, so six
controls cannot each invent their own. **It says nothing when a count does not span more than
one run**, deliberately: annotating a single-batch client would bury the cases that matter.

**The run is named by its day AND its clock time.** *Corrected 2026-09-22.* A date alone
stops identifying a run the moment two happen on one day, which is the ordinary case: the
live database holds three runs on 2026-09-21 for one client, at 15:38, 15:42 and 15:48 UTC.
All three were "the run on 21 Sep 2026", so a prospect from the first was reported as carried
over from an earlier run with nothing to show that the earlier run was twelve minutes before
this one. The clock is rendered in UTC and says so, because the date half always was and a
local-time clock beside it could name a different day. A date that carries no clock keeps the
old date-only wording rather than gaining "at 00:00 UTC", which would assert a run time
nothing recorded.

### The publish button was counting the wrong population

It read "Check 190 and publish for the client" where 190 was every prospect that had ever
reached a tier. On the live organisation, 49 of those had never been shown to the client.

**Nothing was ever over-published.** The publish action has always filtered on
`tier_published_at IS NULL`, so pressing it published only the new ones. The *label* was
counting a different population from the one the click would touch. Both now apply the same
filter, from `src/lib/sourcing/publishable.ts`.

### No provider status codes anywhere

The screen used to read "12 prospects failed email verification, 12 on HTTP 429". Both
halves were wrong. A 429 is the provider asking us to slow down: the sweep waits, retries,
and the address verifies normally, so calling it a failure described a dead prospect where
there was a queued one. And a status code is a thing to look up rather than a thing to read.

The status is now classified server-side into a kind, and **never enters the payload the
browser polls**, so no future screen can render a code by reaching for a field that was
there.

---

## The client review screen

*Updated 2026-09-17.*

### The auto-approval date was anchored to the wrong event

The banner read **"Auto-approved on 15 Aug 2026 if no action taken"** during a walkthrough on
17 September. The date was five weeks in the past.

Read from production that day: tier 1's earliest `tier_published_at` is
`2026-08-11 21:59:36+00`, and the data layer anchors on `tier_published_at ASC LIMIT 1` —
the first time *anything* in that tier was ever published. Four days later is 15 August.
Every batch published since inherits that same deadline, and it can never move again,
because a tier's earliest publish date only gets older.

**The promise could not have been kept anyway.** The write that performs automatic approval
is skipped when the tier is locked, and a tier is locked as soon as any prospect in it has
been uploaded to the sending tool. All three tiers are locked (121, 36 and 3 rows), and have
been since sending started.

`src/lib/dashboard/auto-approval-notice.ts` now decides what to say, and its contract is
narrow: **a date is shown only when it is in the future and automatic approval can actually
happen.** Every other case states the true position with no date in it.

**The write itself is untouched.** Whether and when prospects are auto-approved is exactly
what it was. The anchoring fault inside that write is a separate change, on the Notion
Backlog.

### Prospects who cannot be emailed are explained, not hidden

A prospect on the list who cannot currently be emailed had no Remove control and no
explanation, which reads as a broken button rather than as a state.

They are **not** excluded from the client's view, and that is a decision already on the
record rather than one taken here: the roster is a permanent record of who is being
contacted (Decisions Log 2026-09-07), and filtering on current sendability would erase the
evidence that we mailed someone before a rule changed. Two such prospects exist on the live
organisation.

The row now says "Not being contacted". It names no verification verdict, no country, no
operator action and no vendor: those are operator-facing facts and none of them is the
client's to act on.

### Smaller things on the same screen

- **Job titles are aligned.** They were ragged because the actions column changed width with
  how many icons a prospect had, and the two flexible columns absorbed the difference. The
  titles themselves are untouched: they are the prospect's own data.
- **Approve appears at the top as well as the foot of the list**, from one function, so the
  two cannot disagree about the count or the confirm step.
- **The tab counts say what they count** and how they relate to the headline number.

---

## Two operator screens that could not show what they held

*Added 2026-09-22.*

### The opening line an operator could not read

The quality-and-publish screen (`Gate2TieredReview`) carries a column for the first line the
prospect will read. The cell had `max-w-[320px]`: **a ceiling with no floor**. It is the
eleventh column of eleven in an auto-laid-out table, so the browser gives the longest text
column whatever the other ten leave behind, and a ceiling does nothing about that. What
reached the screen was a few words per line down a narrow ribbon.

Measured on the live `prospects` table 2026-09-22: 222 stored openings, 143 to 341
characters, average 245. These are paragraphs, not phrases.

The column now has a **minimum width** instead, on a block *inside* the cell rather than on
the `td`: `min-width` on a table cell under auto layout is a hint the engine may disregard,
which is how a width silently stops applying, whereas a block child's minimum is a real
contribution. The header needs nothing, because a column is as wide as its widest cell. The
table already sits in an `overflow-x-auto` wrapper, so the cost is sideways scrolling on a
narrow window rather than an unreadable column on every window.

**Why wider and not click-to-expand.** This is a bulk review screen: the operator reads every
row before publishing, twenty at a time and 108 in the run that prompted this. An expander
charges a click per prospect for the thing they came to do, and a row-at-a-time reveal cannot
be scanned down the column to spot four openings that say the same thing. The hover tooltip
is kept for the rare opening that still runs long.

### The FAQ answer boxes were a quarter the size of an answer

On the operator FAQ screen, both the **Add FAQ** answer box and the **Edit answer** box were
fixed at three and four rows with resizing turned off, so there was no way to see the rest of
what you were writing.

Measured on the live `faqs` table 2026-09-22: 12 answers, 146 to 451 characters, average 275,
and **every one of them contains a line break**. These are multi-paragraph answers being
written through a slot that fits three lines.

Both now use `AutoGrowTextarea`, which grows with its content **in CSS, with no JavaScript**.
The usual approach measures `scrollHeight` in an effect and assigns `element.style.height`,
which writes an inline style the code rules forbid, costs a layout read on every keystroke,
and jumps visibly on first paint before the effect runs. Instead the wrapper is a one-cell
grid holding the textarea and an invisible copy of the same text in the same cell: the copy
wraps, so the grid row is as tall as the text needs, and the textarea is stretched to match.
Font and line height are set once on the wrapper and inherited by both; the border is on the
wrapper, outside both, so it cannot count towards one and not the other.

The growth is **capped**. Growing without limit pushes Save and Cancel off the bottom of the
screen on a long paste, which is a worse failure than scrolling: the operator can no longer
finish the edit at all. Past the cap the wrapper scrolls.

The **question** stays a single line, at a larger size. `question_canonical` is one question
and the extraction and merge paths both compare it as a single string.

### What to check if either looks wrong

1. **The opening line column is narrow again.** Something has put a `max-w-*` back on the cell,
   or moved the `min-w-*` from the block onto the `td`, where the engine may ignore it.
2. **An answer box stopped growing.** The invisible copy is what makes it tall. If it has been
   removed, or its padding and font no longer match the textarea's, the box is sized for
   something other than what is in it.
