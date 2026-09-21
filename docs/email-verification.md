# Email verification

**What this does:** decides whether a prospect's email address is real enough to send to, and
records that decision so the send gate can read it quickly.

Written 2026-08-25 when the second pass was built. Plain English throughout: assume the
reader is not a developer.

---

## The short version

There are **two passes**, and they do different jobs.

**Pass one** runs on every address. It is free (100 a day) and cheap to repeat. It gives one
of five answers: Valid, Invalid, Unknown, Catch All, Grey-listed.

**Pass two** runs only on the addresses pass one could not confirm, and it **costs money**
($8 per 1,000). It exists for one specific case: catch-all domains.

A **catch-all domain** accepts email for every address, real or invented. So an ordinary
probe cannot tell `jane@firm.com` from `nonsense@firm.com`: the server says yes to both.
Pass one reporting "Catch All" is therefore honest, not a failure. It is telling you it
cannot know.

Pass two uses a different method (asking the mail provider directly, for Google and Microsoft
hosted domains) rather than a better probe.

**It has now run for real.** On 2026-08-26 it processed the whole live backlog in one firing:
11 addresses, 10 recovered, 1 still unusable, 0 failures, 11 paid calls costing $0.088. On
the catch-alls alone that is 9 of 10, or 90%. Send-eligible prospects went from 13 to 23.

**Still treat that as a best case, not a forecast.** Small numbers, one client, and every
domain on Google or Microsoft, which is exactly where this vendor claims to be strongest.

**And the vendor does not always give the same answer twice.** One address came back "risky"
in the trial run and "deliverable" 28 hours later. Same address, same vendor. So these
percentages carry the vendor's own inconsistency on top of ordinary small-sample noise.

---

## Why the second pass is worth paying for

Not to save money. To unlock prospects that are otherwise unmailable.

Sending best practice caps catch-all addresses at roughly 2-5% of a campaign, because they
bounce far more often. With 8 catch-alls carrying finished, already-paid-for copy, mailing
them inside a 5% cap needs a batch of 160 prospects. There were 13 send-eligible prospects
in total.

So the cap makes the whole catch-all bucket unsendable at this volume. The only route to
those 8 is to resolve them **out** of the bucket. Once an address is confirmed deliverable it
is an ordinary address and the cap does not apply to it.

---

## Where the answer lives

| Column on `prospects` | Holds |
|---|---|
| `independent_email_status` | Pass one's answer, in the vendor's own words |
| `second_pass_status` | Pass two's answer, in its vendor's own words |
| `second_pass_score` | 0-100 confidence. **Recorded, never used to decide anything** |
| `second_pass_accept_all` | Whether pass two agrees the domain is catch-all |
| `email_send_eligible` | **The single answer the send gate reads** |

Both passes store the vendor's literal words rather than a tidied-up version, because
"vendor two said deliverable on a domain vendor one called catch-all" is the fact that
justifies mailing the address. A tidied version cannot express that.

### One rule decides eligibility

`email_send_eligible` is written by **two** functions, not one, and it is worth knowing which
is which because the difference has already cost something.

- `resolveSendEligibility` in `src/lib/sourcing/send-eligibility-resolver.ts` — the **second
  pass**. It applies the full disagreement rule below.
- `firstPassSendEligibility` in `src/lib/sourcing/send-eligibility-rules.ts` — the **first
  pass**, called from `recordVerificationResult` in `verification-trigger.ts`.

**Corrected 2026-09-07.** This page, and the resolver's own header comment, both used to say
the column was "written by exactly one function". That was never true. The first pass wrote it
from an expression spelled out inline, and the first pass is the one that actually runs on a
re-verification. Believing the single-writer claim is how three hand-held prospects came
within one verification run of being silently marked send-eligible again. The inline
expression is now a named function so it can at least be tested; unifying the two is a
separate change, because the resolver's two-pass rule would change the verdict for rows that
are not held.

This matters because that column is **materialised**: it is worked out once, at verification
time, and simply read later. With two passes writing it, the obvious mistake is for its value
to depend on which pass ran last. One function is what prevents that.

The rule, in plain English:

- Pass one says the mailbox is good → **send-eligible**.
- Pass one says the mailbox is **dead** → not eligible, and pass two cannot overturn it. A
  confirmed dead mailbox is information, not a failure to decide, so we do not even spend a
  paid call on it.
- Pass one could not confirm, pass two says deliverable → **send-eligible**. This is the
  entire point of the build.
- Pass one could not confirm, pass two also could not → not eligible. Nothing was gained.
- **Country exclusion sits on top of all of it and can only ever remove eligibility.**
- **An operator hold sits on top of even that.** `prospects.send_hold_at` is checked before
  the country rule and before either verdict. A held prospect is never send-eligible, no
  matter what any verifier says, and a re-verification cannot clear it. Only an operator
  can.

### An operator hold, and why it is not the ineligible-reason column

Added 2026-09-07. Three prospects were sitting at `email_send_eligible = false` with no reason
recorded, no override and **no code path holding them**: someone had run an `UPDATE` by hand.
Because the column is recomputed from scratch at every verification, the next re-verification
of any of them would have worked out "deliverable, country not excluded, therefore eligible"
and written exactly that, with nothing logging a reversal.

Three columns record a hold: `send_hold_at`, `send_hold_by`, `send_hold_reason`. A CHECK
constraint refuses a timestamp without a reason, because **a row held for no stated reason is
indistinguishable from a bug** — which is precisely what those three rows looked like.

`send_hold_by` is allowed to be null, and on the three backfilled rows it is. The hold was
real, the operator was not recorded, and a guess would be worse than an admission.

The reason could not go in `email_send_ineligible_reason` without a change, because two
readers treated *any* non-null value there as meaning "excluded country":
`send-eligibility-policy.ts` (the research spend gate) and `prospect-status.ts` (the operator
screen). Both now match on the value. A hold reports as a hold; anything else still fails
closed exactly as before.

**The hold names no country and takes no legal position.** Whether Canada and Australia belong
on an exclusion list is an open decision in the Notion Backlog, and it was deliberately not
answered by making a manual edit durable.

**Applied a second time on 2026-09-17, to 11 prospects, through the same three columns.** Every
prospect then queued and passing the send gate whose address verdict was not a confirmed valid was
held: 9 read `Catch All` and 2 read `Unknown`. The gate went from 32 prospects to 21, and the 21
that remain all read first-pass `Valid`.

**These 11 were not slipping through. They were eligible because the system worked.** The
catch-all re-verification cron had already run on every one of them, and the second-pass vendor
resolved all 11 to `deliverable` on 14 and 15 September, scoring 90 on nine of them and 90 and 100
on the two that had read `Unknown`. `resolveSendEligibility` then promoted them correctly, exactly
as designed. So this hold is an operator overriding a paid second opinion, not a gate catching a
leak, and it is worth being explicit about that because the two look identical from the row alone:
`email_send_eligible = false` either way. Anyone releasing these should read it as a judgement that
a second-pass resolution of an initially uncertain address is not, on its own, enough to send on,
and that judgement is reversible without re-spending anything.

This was a data change and not a code change. `EXCLUDED_COUNTRIES`, the resolver and the gate were
all untouched, and no second mechanism was introduced: the write is the same shape the three
2026-08-29 rows already carry, `email_send_eligible = false` plus
`email_send_ineligible_reason = 'operator_hold'` plus the three `send_hold_*` columns. Unlike those
three it records `send_hold_by`, because here the operator who decided it was known at the time
rather than reconstructed afterwards.

Two consequences, both worth knowing before anybody releases them:

- **The research spend gate now refuses them.** `send-eligibility-policy.ts` reads the hold as
  `operator_hold` and declines to spend research money on an address nothing is going to email.
  Releasing one means clearing the hold *first* and re-verifying second, in that order.
- **`suppressed` was deliberately not written.** A hold is not a suppression. That column already
  carries four unrelated per-organisation meanings and none of them is "the address could not be
  confirmed". All 11 were `outbound_upload_status = 'pending'`, so nothing had been uploaded for
  MON-026 to reconcile, which is the case the suppression write in `stop-prospect.ts` exists to
  cover. The result is that these rows are held and reversible rather than stopped and one-way.

To release: clear `send_hold_at`, `send_hold_by` and `send_hold_reason` together, since the CHECK
constraint refuses a timestamp without a reason, then re-verify. The resolver recomputes
eligibility from the evidence, and a cleared hold does not come back.

### Why the score is ignored

Pass two returns a 0-100 score. In the sample, the eight good addresses all scored 90 and the
two bad ones scored 75 and 15. That looks like an obvious cut-off around 80.

It is not used, on purpose. Ten results on one day cannot support a numeric threshold: the
entire range between 75 and 90 has never been observed. The vendor's own verdict word is what
decides. The score is stored so a threshold can be worked out later from real data.

---

## The paid-call ledger

Every paid call writes a row to `verification_calls` **before the call is made**.

Before, not after, and that ordering is the whole point. A row written afterwards cannot
record a call that spent money and then failed, and that is exactly the call a budget needs to
count. The daily cap (200 calls, about $1.60) is counted from this table, so failures count
against it too.

The free first pass does not have this, and its own code says so: it counts verdicts, so a
probe that used up quota and then failed is invisible. That is tolerable when the calls are
free and not when they are billed.

---

## What to check if it breaks

**Nothing is being verified at all.** Check the two scheduled jobs are alive on the operator
monitor page: **MON-019** (first pass, every 10 minutes) and **MON-020** (second pass, every
30 minutes). A scheduled job that stops running does not produce an error, it just goes quiet,
so these monitors are the only thing that will tell you.

**The second pass fails every time.** The most likely cause is not a bug: it is an empty
credit balance. The vendor returns a 402 when you are out of credits, and the handler labels
it plainly. Top up the pay-as-you-go balance.

**A prospect is stuck and never gets a second look.** Each address is tried at most twice.
After that `second_pass_attempt_count` has hit its cap and it is left alone deliberately,
because every retry costs money. `second_pass_error` holds the last failure message.

**A sweep says "verified 0" every time and never does anything.** Check whether the
organisation it nominates has any rows the trigger will actually accept. Both sweeps use two
queries: one picks the organisation, a second picks rows inside it. If those two ever
disagree about which prospects count, the picker keeps choosing an organisation the trigger
refuses everything from, no other organisation is ever reached, and the heartbeat reports
success throughout. That happened between 2026-09-01 and 2026-09-03 and is described below.

**Prospects are researched that should not be.** The research spend gate
(`checkResearchEligibility`) reads both passes. If it is skipping prospects you expect it to
research, the reason is reported in the operator's skip summary rather than hidden.

---

## Two things worth knowing that are not obvious

**The country rule was broken until 2026-08-25, and it had already let two prospects
through.** The enrichment step wrote the country as a name ("Germany") and the exclusion rule
matched a code ("DE"), so it never fired. Both halves were individually correct and
individually tested; nothing tested the join between them. Country is now stored as a
two-letter ISO code, and the rule also matches known spellings as a second layer. See
`src/lib/sourcing/country-code.ts`.

This is why populating country was a hard prerequisite for the second pass: re-verifying a
German catch-all would otherwise have returned it as send-eligible with the country rule never
consulted.

**Neither pass will spend anything on a prospect tiering has rejected, and this took two
attempts to get right.** Tiering decides whether a prospect is worth pursuing at all. A
prospect it rejected should never consume verification quota on the free pass or real money
on the paid one.

The gate reached the first pass's row selector on 2026-09-01 and did not reach the other
three places that decide who gets verified. The result was worse than doing nothing. Both
sweeps serve one organisation per run, choosing it with a separate query, and that query was
still counting rejected rows as work. So the picker nominated an organisation, the trigger
refused every row in it, and the sweep wrote a successful heartbeat. Roughly 290 times over
two days. No other organisation could have been served during that window.

Measured before the fix: 16 rejected prospects, 14 of which had been verified on the free
pass, and 6 of which had been billed on the paid pass. Those 6 were 6 of the 52 paid calls
ever made, and 5 came back as valid addresses that will never be emailed.

The rule is deliberately narrow. It refuses a prospect tiering **rejected**, and allows one
tiering has not looked at yet. Those are different states, and treating "not yet decided" as
"no" would make verification wait on tiering for no reason. Only the send gate, at the very
end of the pipeline, insists on a positive verdict.

Existing rows were left alone. The 16 already-verified prospects keep their verdicts, because
a verdict about an address is a true statement about that address whatever tiering later
decided, and re-verifying costs money to learn nothing.

**The daily limit on the first pass is config, not code, and it stopped describing the
account on 2026-09-01.** It was `const FREE_DAILY_LIMIT = 100` in the trigger, and 100 was
the first-pass validator's FREE TIER allowance. Pay-as-you-go credits were bought on
2026-09-01, so from that day the constant capped every sweep against a plan the account no
longer had.

The value now lives on the active `can_validate_email` row in `integrations_registry`, under
`config.daily_verification_limit`, and is read on every run. Changing it is an UPDATE on one
row with no deploy. The row is selected by capability and `is_active`, never by vendor name,
so swapping validator does not touch the code.

The constant survives as a fallback for when the row cannot be read, and it is deliberately
the small old number: verification resumes on the next sweep, an overrun does not. The log
line names its source, so a run that fell back and a run that read real config do not look
the same.

Two things worth knowing about the number that is in there now. Read live on 2026-09-21 it
is **10,000** (the doc said 10,500 until then, which was the figure at purchase). It is a
purchased BALANCE and not a per-day allowance, because a pay-as-you-go account has no daily
grant for it to mirror. If a tighter daily ceiling is wanted, that is a commercial decision
and it is one UPDATE.

---

## How fast it goes, and why that changed on 2026-09-21

**The provider's limit was never the constraint. Our own batch size was.**

Until 2026-09-21 a sweep took a fixed 40 addresses, slept a flat two seconds between them,
and stopped. Against the clock that is roughly eighty seconds of work inside a ten-minute
period: about **240 addresses an hour** against a documented allowance of 30 a minute, or
**1,800**. Two separate causes, and fixing either alone leaves most of the gap:

| | What it was | Why it cost throughput |
|---|---|---|
| Batch size | fixed 40 | Sized so 40 two-second sleeps fit a 300s route with room to spare. Everything after the eightieth second was idle. |
| Spacing | `sleep(2000)` after each probe | The real cycle was 2,000ms **plus the probe**. At a 600ms probe that is 23 a minute, not 30. The slower the provider, the further under the limit it drifted. |

Both are fixed. A run now **paces against slots at fixed absolute moments** and keeps going
until a **deadline** rather than until a fixed count.

### The three numbers that bound a run

A run probes the smallest of:

- **the caller's ceiling** (`DEFAULT_VERIFY_BATCH_SIZE`, now *derived* from the default
  window and the fallback pace rather than written down, so it cannot disagree with them),
- **the daily budget** still remaining, and
- **what fits before the deadline** at the paced interval.

The third is the new one and it is what makes a run use its window.

### The pace is config, and it already was

`config.rate_limit_per_minute` was seeded onto the `can_validate_email` registry row on
2026-09-04, and the seeding migration says so in as many words: *"seeded and read by nothing
today"*. It sat unread for seventeen days while `const RATE_LIMIT_PER_MINUTE = 30` in the
trigger governed the real pace. **A config value nothing reads is worse than no config value:
it reads as a knob, and turning it does nothing.** `getVerificationRateLimit` now reads it,
beside the daily limit, off the same row through the same shared read.

The sweep aims for `PACING_SAFETY_FRACTION` (0.9) of whatever that says: 27 a minute against
a limit of 30. A fraction rather than `limit - 1` because the headroom has to survive the
limit being raised, which is the reason it is configuration at all.

**MyEmailVerifier's single-validation limit is customisable on request.** Raising it is
therefore an `UPDATE` on that row and takes effect on the very next sweep, with no deploy.

### No catch-up burst

When a probe overruns its slot, the pacer resumes at the correct pace rather than firing the
missed slots back to back. An average of 27 a minute made of a quiet stretch and then nine
calls in one second is a rate-limit breach however good the average looks, because a
per-minute limit measures a window and not a mean. `Math.max(now, earliestNext)` in
`createPacer` is the line that guarantees it, and there is a test that walks a sliding
60-second window across an erratic run to prove it.

### The deadline comes from the cron period, not from a guess

Two overlapping sweeps would each pace at just under the limit and together spend it twice
over, with neither doing anything wrong on its own. So `runBudgetMs` takes the smaller of the
request cap (240s, leaving room for a 20s probe and the tail inside `maxDuration = 300`) and
**the gap to the next firing**, read from `cron_schedule_registry`.

That is what makes the pacing true *across* runs and not only within one, and it means moving
this job from every ten minutes to every five is a registry edit with **no code change**: the
budget shrinks to fit automatically.

### What it does now

At the live configuration on 2026-09-21 (`4-59/10`, 30 a minute):

| | Before | After |
|---|---|---|
| Per run | 40 | **108** |
| Per hour | ~240 | **~648** |
| In-run rate | ~23-30/min, dropping with provider latency | **~27/min, flat** |

**The residual gap to 1,800 an hour is DUTY CYCLE, not pace.** A run works for 240 seconds of
a 600-second period. Closing that needs a shorter cron period, which the code now supports
unchanged, and it is a deliberate decision rather than an oversight: at ~648 an hour the
**daily budget of 10,000 binds first** for any sustained load, so a shorter period only
changes how fast a *burst* clears, not how much gets done in a day.

The status string `free_tier_exhausted` is a historical name kept because the cron route and
its tests branch on the literal. It means the daily budget is used up, whatever tier the
account is on.

**Greylisted addresses are deliberately not sent to the paid pass.** Greylisting is a
temporary "try again later", and the free first pass already retries it. Paying a second
vendor to answer a question that is about to answer itself would be waste.

---

## Files

| File | Job |
|---|---|
| `src/lib/sourcing/verification-trigger.ts` | Pass one, the first sweep |
| `src/lib/sourcing/verification-limits.ts` | **The daily budget AND the per-minute pace, both read from config with constants as fallbacks** |
| `src/lib/sourcing/verification-pacing.ts` | **The pacer, the safety fraction, and the run budget** |
| `src/lib/sourcing/cron-interval.ts` | Parses a crontab minute interval, and refuses anything else |
| `src/lib/sourcing/cron-schedule.ts` | Reads a job's declared schedule from `cron_schedule_registry` |
| `src/lib/operator/stage-estimates.ts` | Finish estimates and the enrichment press plan for the operator screen |
| `src/lib/sourcing/tier-verdict.ts` | **The tier gate both passes apply, picker and selector** |
| `src/lib/sourcing/second-pass-trigger.ts` | Pass two, the paid sweep |
| `src/lib/sourcing/handlers/adapter-myemailverifier.ts` | Pass one vendor, owns its own words |
| `src/lib/sourcing/handlers/adapter-bouncer.ts` | Pass two vendor, owns its own words |
| `src/lib/sourcing/verification-verdict.ts` | Translates both vendors into one vocabulary |
| `src/lib/sourcing/send-eligibility-resolver.ts` | **The one rule that decides eligibility** |
| `src/lib/sourcing/send-eligibility-rules.ts` | Country exclusions |
| `src/lib/sourcing/country-code.ts` | Country names to ISO codes |
| `src/app/api/cron/verify-pending/route.ts` | Runs pass one every 10 minutes |
| `src/app/api/cron/verify-catch-all/route.ts` | Runs pass two every 30 minutes |

Each vendor's vocabulary lives with that vendor's file, and the shared translator holds only
the wiring. Adding a third vendor is a new handler plus one line in the registry, and no
shared file has to learn a new word.
