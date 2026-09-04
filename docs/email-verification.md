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

`email_send_eligible` is written by exactly one function,
`resolveSendEligibility` in `src/lib/sourcing/send-eligibility-resolver.ts`. Both passes call
it. Neither knows the rule.

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

**Greylisted addresses are deliberately not sent to the paid pass.** Greylisting is a
temporary "try again later", and the free first pass already retries it. Paying a second
vendor to answer a question that is about to answer itself would be waste.

---

## Files

| File | Job |
|---|---|
| `src/lib/sourcing/verification-trigger.ts` | Pass one, the free sweep |
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
