# The tier gate

What this does, in one line: it stops a prospect that tiering REJECTED from being verified,
researched, approved or sent, without stopping a prospect tiering simply has not reached yet.

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

One module, `src/lib/sourcing/tier-verdict.ts`, and five call sites.

| Consumer | Where | Which rule |
|---|---|---|
| Verification | `src/lib/sourcing/verification-trigger.ts` | refuse rejected |
| Research, queue path | `src/lib/queue/enqueue/research.ts` | refuse rejected |
| Research, inline path | `src/lib/operator/research-batch-entry.ts` | refuse rejected |
| Client approve-all | `src/app/api/dashboard/client/prospects/approve-all/route.ts` | refuse rejected |
| Send | `src/lib/sourcing/send-gate.ts` | require a positive tier |

The send gate is stricter on purpose. Sending is the irreversible end of the pipeline, and
"we have not decided about this prospect yet" is not a licence to email them. Everything
upstream of it spends money, which is recoverable in a way a sent email is not, so those
consumers let a waiting prospect keep moving.

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

**Symptom: a prospect that should be researched or verified is being skipped.**
Read its two tier columns. `tiering_reason` set with `sourced_tier` NULL means tiering
rejected it, and the gate is working. Both NULL means it is waiting for tiering, and the
gate is NOT what is holding it: look at `tiering-trigger.ts`, which selects on both columns
being NULL.

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
it. Each of the five call sites has its own test that drives the real code path, and each was
mutation-checked by deleting the predicate from that specific query and confirming that test
goes red.
