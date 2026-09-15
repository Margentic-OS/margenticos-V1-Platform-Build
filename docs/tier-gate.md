# The tier gate

What this does, in one line: it stops a prospect that tiering REJECTED from being verified,
researched, approved or sent. Verification and approve-all still let a prospect tiering has
not REACHED yet keep moving; research and sending do not, and the split is about price.

## The problem it fixes

`sourced_tier` was computed, stored and shown on the dashboard, and read by nothing that
decided what happened to a prospect next. Measured on the live organisation on 2026-09-01:

- 16 prospects had been rejected by tiering, 15 of them unsuppressed
- verification quota had been spent on all of them
- research money had been spent on 10
- 9 of those carry finished personalisation copy that can never be used

Research is the most expensive step in the pipeline, roughly 60 times what composition costs
per prospect. So the tier verdict was, in practice, advisory.

## The three states, and why one column is not enough

| `sourced_tier` | `tiering_reason` | means |
|---|---|---|
| set | set | tiering ran and the prospect QUALIFIED |
| NULL | set | tiering ran and REJECTED the prospect |
| NULL | NULL | tiering HAS NOT RUN yet |

The middle and bottom rows hold the same value in `sourced_tier` and mean opposite things.
A gate written as "sourced_tier IS NOT NULL" reads a waiting prospect as a rejected one; a
gate written as "sourced_tier IS NULL" reads a rejected one as waiting. `tiering_reason` is
what separates them, because tiering writes a reason on every result including the passes.

Checked live across every organisation before relying on it: no row carries a tier without a
reason, and every never-tiered row carries both as NULL.

## Where it is applied

One module, `src/lib/sourcing/tier-verdict.ts`, and **eight call sites in eight files**.

COUNTED 2026-09-15, not asserted:

    grep -rn "excludeTierRejected\|requireTierPresent" src --include='*.ts' \
      | grep -v "__tests__\|/tier-verdict.ts" \
      | grep -E "excludeTierRejected[<(]|requireTierPresent[<(]"

The bracket alternation `[<(]` matters: `send-gate.ts` calls `requireTierPresent<Q>(...)`, and a
pattern anchored on `(` silently misses it. That happened while writing this line.

This section previously said "five call sites" and listed six rows. Both numbers were stale,
and the table was missing the two cron PICKERS — which is the pair this module says must never
be separated from their selectors.

| Consumer | Where | Which rule |
|---|---|---|
| Verification, first pass — row selector | `src/lib/sourcing/verification-trigger.ts` | refuse rejected |
| Verification, first pass — **org picker** | `src/app/api/cron/verify-pending/route.ts` | refuse rejected |
| Verification, second pass — row selector | `src/lib/sourcing/second-pass-trigger.ts` | refuse rejected |
| Verification, second pass — **org picker** | `src/app/api/cron/verify-catch-all/route.ts` | refuse rejected |
| Client approve-all | `src/app/api/dashboard/client/prospects/approve-all/route.ts` | refuse rejected |
| Research, queue path | `src/lib/queue/enqueue/research.ts` | **require a positive tier** |
| Research, inline path | `src/lib/operator/research-batch-entry.ts` | **require a positive tier** |
| Send | `src/lib/sourcing/send-gate.ts` | require a positive tier |

**The two picker rows are not padding.** Each verification sweep runs one organisation per
invocation: a first query picks the organisation, a second picks rows inside it. Gating only the
selector converts a money bug into a starvation bug, because the picker keeps nominating an
organisation the selector refuses everything from. That shipped on 2026-09-01 and ran for
roughly 290 firings writing successful heartbeats. A maintainer who treated the old six-row
table as the inventory and edited only the two named verification files would reproduce it.

The send gate is stricter on purpose. Sending is the irreversible end of the pipeline, and
"we have not decided about this prospect yet" is not a licence to email them.

**Research joined it on 2026-09-15, for a different reason: price, measured.**

The original split said everything upstream of sending should use the looser rule because it
spends money, "which is recoverable in a way a sent email is not". That holds for
verification, where a probe is cheap and quota-bound and making it wait on tiering would
starve it. It does not hold for research, which costs about $0.21 a prospect.

Measured from `agent_runs` on the live organisation, 2026-09-14:

```
13:57  the ICP was revised (headcount ceiling 20 -> 30)
17:17  2 prospects had their sources fetched         PAID
18:24  the same 2 were synthesised and written       PAID
19:14  tiering ran and rejected both, not_decision_maker
```

Research was bought roughly two hours before the verdict existed. **The gate did not fail.**
The verdict was absent, and the looser rule admits an absent verdict deliberately.

The mechanism is the `persist-icp-filter-spec.ts` thaw described in the next section: it
clears `tiering_reason` so the new rules get applied, which turns "rejected" into "not yet
tiered" until the next tiering run reaches the row. There is no standalone tiering cron —
tiering runs only inside `verify-pending` — so that window is real time. On 2026-09-14 it was
5 hours 17 minutes and cost about $0.42 on two prospects.

**The cost of the change, stated:** a prospect whose tiering genuinely has not run yet is now
skipped by research rather than researched. The next enqueue picks it up once tiering has
reached it, so the effect is latency, not exclusion. The two research call sites must always
move together, or the CLI and the queue research different sets.

`src/lib/sourcing/send-gate.ts` also collapses the send predicate itself. Its seven filters
used to be written out by hand in three places: the suppression pre-filter, the claim, and
the operator's "ready to send" count. Three copies that agreed only because nobody had
edited one of them yet.

## Why the tier verdict is NOT stored in email_send_eligible

`email_send_eligible` means one thing and only one thing: THIS ADDRESS IS DELIVERABLE.

The tempting shortcut is to AND the tier verdict into it at verification time so every
consumer keeps one flat read. It goes stale. `persist-icp-filter-spec.ts` clears
`tiering_reason` on an organisation's rejected rows when a new ICP specification is saved, so
tiering runs on them again under the new rules. A tier verdict frozen into the boolean would
not be recomputed by that, because nothing re-runs verification, and the row would sit
permanently ineligible after later qualifying.

So there is no backfill migration alongside this change. The 11 rows holding
`email_send_eligible = true` while disqualified are holding a TRUE statement about their
addresses. Every consumer refuses them on the tier verdict instead, freshly, each time.

## What to check if it breaks

**Symptom: a prospect that should be verified is being skipped.**
Read its two tier columns. `tiering_reason` set with `sourced_tier` NULL means tiering
rejected it, and the gate is working. Both NULL means it is waiting for tiering, and the
gate is NOT what is holding it: look at `tiering-trigger.ts`, which selects on both columns
being NULL.

**Symptom: a prospect that should be RESEARCHED is being skipped, and both columns are NULL.**
That is the gate working as of 2026-09-15. Research requires a positive tier now. Run tiering
and the prospect becomes eligible. If it stays untiered, the question is why tiering has not
reached it, not why research refused it. Most often this follows an ICP revision, which clears
the verdict on every rejected row in the organisation and logs the re-queue count at `warn`.

**Symptom: a prospect that should be sendable is not.**
The send gate needs a POSITIVE tier, not merely the absence of a rejection. A prospect
tiering has not reached is correctly refused there until it is tiered.

**Never gate on a reason VALUE.** The rule is the presence of a rejection, never what the
rejection said. The live data already contains a legacy reason string that
`tier-classification.ts` no longer writes and does not list in `REMOVAL_REASONS`; a gate
keyed on known values would silently re-admit it.

## Tests

`src/lib/sourcing/__tests__/tier-verdict.test.ts` proves the MODULE. It does not prove the
wiring, and says so: a shared predicate that no consumer calls would pass every assertion in
it. Each call site has its own test that drives the real code path, and each was mutation-checked
by deleting the predicate from that specific query and confirming that test goes red.
