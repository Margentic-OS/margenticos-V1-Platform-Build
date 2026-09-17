# The weekly watch

## What this does

One report, asked for once a week, that answers a single question: **is it safe to advance
the sending ramp by one rung?**

    npm run weekly-watch

It reads six things and refuses to guess at any of them.

## The six sources

| # | Source | Read from | Why it is on the list |
|---|--------|-----------|----------------------|
| 1 | Warmup `landed_spam` per mailbox | sending tool | The canary. Warmup mail lands in spam before prospect mail does, so this is the earliest warning available and it costs nothing. |
| 2 | Per-domain bounces, last 7 days | `sending_mailbox_daily_stats` | Both triggers: 3 bounces in the window at any volume, and >2% once a domain clears 50 sends. |
| 3 | Account status for every campaign sender | sending tool | A disconnected or paused mailbox silently reduces throughput and concentrates volume on the rest. |
| 4 | Current daily limit and ramp rung | sending tool | Where we are on the ladder, and what the limit implies per mailbox and per domain. |
| 5 | Lead count against the plan cap | sending tool | The cap is reached before the domains are, at the planned volumes. |
| 6 | Prospects pending upload | `prospects` | Sourcing, not deliverability, is the first thing that stalls a ramp. |

## The rule this is built around

**A source that could not be read must never render as a number.**

Every figure here exists to answer "is it safe to advance". A zero is the most reassuring
answer any of them can give: zero spam, zero bounces, zero inactive accounts. So a failed
read that defaults to zero does not merely lose information, it manufactures the exact
reading the operator is hoping for, and advances a ramp on the strength of it.

There is therefore no default anywhere in the module. A source returns `Reading<T>`: either
`ok` with a value, or `unknown` with the reason. There is no third case and no fallback,
and the `unknown` branch carries no `value` field at all, so there is nothing for a caller
to reach for by accident.

## Verdicts and exit codes

| Verdict | Exit | Meaning |
|---------|------|---------|
| `ADVANCE` | 0 | All six read, all clear. Safe to advance one rung. |
| `HOLD` | 1 | All six read; something says wait. The concerns are listed. |
| `INCOMPLETE` | 2 | One or more could not be read. **Not a clean report.** |

`INCOMPLETE` exits 2 rather than 0 deliberately, so neither a human skimming nor a wrapper
checking an exit code can mistake "we could not read the canary" for "the canary was clean".

An unreadable source outranks a concern: we are not judging numbers we do not have. The
concern list is still printed, so nothing is swallowed by the verdict.

## The ramp ladder

`25 → 40 → 55 → 75 → 95 → 120`, one rung per week, agreed 2026-09-17.

The week is not caution, it is measurement. `SENDING_HEALTH_WINDOW_DAYS` is 7, so a rung
held for less than a week never gets a clean reading: the monitor's window straddles two
volumes and the rate it computes describes neither.

A limit that is not a rung is reported as **off-ladder** rather than rounded to the nearest
one, because a hand-set limit is information.

## What to check if it breaks

- **Everything reads UNKNOWN.** Usually the API key or the Supabase service key. The script
  refuses to start rather than emitting an empty report, and says so.
- **Three sources UNKNOWN with the same reason.** The campaign is the spine: it supplies
  both the daily limit and the sender list, so warmup, accounts and ramp all cascade from
  it. The reason names the campaign failure.
- **Bounces UNKNOWN saying "stale".** The 15-minute cron that writes
  `sending_mailbox_daily_stats` has stopped. A bounce count from a table that stopped
  updating reads as "no bounces" while meaning nothing, which is why it is refused.
- **Lead cap UNKNOWN naming a different plan.** The 1,000 limit is pinned in
  `thresholds.ts` because the V2 REST API exposes no billing endpoint (four candidate paths
  probed 2026-09-17, all 404). It is guarded by the plan id, which IS read live. A plan
  change means re-measure, not carry on.

## Tool agnosticism

Nothing in `src/lib/weekly-watch/` names a vendor. The collectors depend on the
`WatchProvider` interface; endpoint paths, auth headers, the pagination quirk and the
omitted-when-zero `landed_spam` field live behind it in
`src/lib/integrations/handlers/instantly/weekly-watch.ts`. Swapping the sending tool is a
new implementation of that interface (ADR-001).
