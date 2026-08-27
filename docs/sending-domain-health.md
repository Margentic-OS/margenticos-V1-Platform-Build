# Sending domain health (MON-023)

**Built 2026-08-27.** What it does, what it connects to, what to check when it breaks, and
why the odd-looking decisions were made.

---

## What this is, in plain English

We send cold email from five domains of our own: `getmargenticos.com`, `gomargenticos.com`,
`inboxmargenticos.com`, `mailmargenticos.com` and `trymargenticos.com`. There are ten
mailboxes across them today, going to fifteen.

When an email cannot be delivered it **bounces**. Bounces damage the reputation of the
domain they were sent from, and once a domain's reputation drops, its mail starts landing
in spam folders instead of inboxes. That takes weeks to recover from.

The ramp stop condition is "bounce rate above 2% on any single sending domain". Before this
was built, nothing in the product could answer that question. `campaigns.bounced_count` is
**one number for a campaign that rotates through all five domains**, so a single bad domain
hides inside it. Three bounces in 1,000 pooled sends is 0.3% and looks fine; the same three
bounces on one domain that only sent 50 is 6% and is a reputation problem.

This feature makes the difference visible.

---

## What you see

**Operator dashboard → Monitor → Sending Domain Health.** A table of the five domains with
sends, bounces and bounce rate over the last seven days, plus a state for each.

Each domain reads one of three things:

| State | Meaning |
|---|---|
| **Within threshold** | Judged by both rules and clean. |
| **Over threshold** | Broke one of the two rules below. Act on it. |
| **Not enough sends** | The domain has not sent enough for a percentage to mean anything, so the rate rule was **not applied**. This is not a pass. |

That third state matters more than it looks. A percentage on a small denominator is noise:
a domain that sent 28 emails hits 2% at 0.56 bounces. Reporting such a domain as "healthy"
would be a check that passes because it had nothing to judge, so it says so instead.

---

## The two rules

Both are per domain, over a rolling seven days.

1. **Three or more bounces, at any rate.** Works at every volume. This is the rule that is
   actually live today.
2. **Bounce rate above 2%, but only once that domain has sent at least 50** in the window.

**Rule 2 is dormant at present, and that is expected.** The campaign's daily limit is 20
across all five domains, which is about 28 sends per domain per week, so no domain reaches
the 50-send floor. The floor is calibrated for ramp volume, not today's. Raising the
campaign's daily limit is a separate pre-ramp change. Until then rule 1 does the work, and
the dashboard says plainly that rule 2 judged nothing.

Thresholds live in one file: [`src/lib/sending-health/thresholds.ts`](../src/lib/sending-health/thresholds.ts).

---

## MON-023 and its four states

The monitor collapses the per-domain picture into one check.

| State | Monitor reads | When |
|---|---|---|
| **healthy** | OK | Judged by both rules, nothing over threshold. |
| **insufficient_sends** | OK | Nothing over threshold, but no domain cleared the 50-send floor, so rule 2 judged nothing. The detail line says so. |
| **failing** | PROBLEM | A domain broke a rule. Sentry alert, sidebar badge. |
| **stale** | PROBLEM | The figures stopped being refreshed. |

**Why `insufficient_sends` reads OK rather than UNKNOWN.** (ADR-035. Ratified by Doug on
2026-08-27 after seeing it in production, with the UNKNOWN alternative costed.) The monitor sweep writes an
event only when a check's state *changes*, and it treats "no prior event" as UNKNOWN. A
check that sat at UNKNOWN from birth would never write a row, and would render exactly like
MON-008: registered, permanently silent, and impossible to tell apart from a monitor that
nothing queries. The distinction is not lost, it just lives in the per-domain table instead
of in the traffic light.

**Why `stale` exists at all.** Unlike every other monitor, MON-023 reads a **stored**
verdict rather than computing one live. A stored verdict can go out of date: if the cron
that writes it stops, the last answer sits there saying "healthy" forever. A monitor that
reads green because its input stopped arriving is the same defect as one that reads green
because it had nothing to judge. So the view checks the verdict's age **before** it reads
the verdict, and anything older than 60 minutes (four missed 15-minute runs) reports stale.

---

## How it connects

```
GET /accounts                    ->  the mailbox list  (filter is mandatory, see below)
GET /accounts/analytics/daily    ->  sends + bounces, per mailbox, per day
        |
        |  handler: src/lib/integrations/handlers/instantly/sending-health.ts
        |  (the ONLY file that knows which tool this is)
        v
  syncSendingHealth()            src/lib/sending-health/sync.ts
        |  resolves can_report_sending_health from integrations_registry
        |  upserts on (stat_date, mailbox)
        v
  sending_mailbox_daily_stats    one row per mailbox per day
        |
        |  evaluateSendingHealth()   src/lib/sending-health/evaluate.ts
        v
  sending_health_snapshot        one row: verdict + per-domain breakdown + computed_at
        |                                     |
        v                                     v
  mon_023  (freshness + mapping)     GET /api/operator/sending-health
        |                                     |
        v                                     v
  monitor sweep, Sentry              Sending Domain Health panel
```

Runs inside the existing **`instantly-poll` cron, every 15 minutes**. It does not have its
own schedule.

### Tool agnosticism

Nothing above the handler names a sending tool. `sync.ts` asks `integrations_registry`
which tool provides `can_report_sending_health` and dispatches accordingly; that switch is
the single place a tool name appears outside the handler directory. Swapping tools is a
registry row plus a handler. The monitor, the view, the API route and the dashboard panel
all stay untouched. (ADR-001.)

---

## Things that will bite you

**The mailbox filter is mandatory.** `GET /accounts/analytics/daily` returns HTTP 413
without an `emails` parameter — even for a single day. That is why the mailbox list has to
be fetched first. It is not an optimisation.

**The account list returns a pagination cursor even on the last page.** Ten accounts came
back with a cursor attached and requesting it returned an empty list. The loop terminates
on an **empty page**, not on a missing cursor. Get this wrong and it loops forever.

**Thirty-one days is a hard ceiling** on the analytics range, enforced by the provider.
`chunkDateRange` splits anything longer. History older than that which we never captured is
gone permanently, which is why the backfill was run on day one.

**Three days are re-fetched every run, not one.** A bounce can be attributed to the day the
*send* happened rather than the day the bounce arrived, so a day's figures are not final
when the day ends. The upsert on `(stat_date, mailbox)` makes re-fetching free and
idempotent.

**Warmup mail is not counted, and must never be.** `accounts/analytics/daily` reports
campaign sends only. Warmup runs at roughly 100/day across the ten mailboxes against 30
campaign sends in a week, so mixing them in would dilute every bounce rate by about 23x and
hide real problems. The two live in different endpoints and never overlap.

---

## Why the thresholds are in TypeScript and not in the view

Every other `mon_NNN` view computes its own state in SQL. This one does not, and the reason
is testability.

The only database this project has is production. `vitest.config.ts` deliberately withholds
Supabase credentials from the test suite so tests cannot write to it, which means every
database-dependent test is blocked — **including `mon_006_per_row.test.ts`, the one
existing test of a monitor view's thresholds, which has never executed a single
assertion.** A threshold nothing can run a test against is a threshold nobody has checked.

So the arithmetic lives in `src/lib/sending-health/`, where vitest reaches it with no
database, and the view reads the result. MON-016 already reads a stored verdict
(`cron_heartbeats.ok`), so the sweep needed no special case.

The cost is the duplication that remains: the 60-minute interval and the state mapping
exist in both TypeScript and SQL. That pair is guarded by
`src/lib/sending-health/__tests__/sql-parity.test.ts`, which reads the migration file and
fails if the two stop agreeing.

**Getting a non-production database is the next build.** It unblocks the other 38 blocked
tests as well, and would let this logic move back into SQL if that were ever preferred.

---

## If it breaks

**MON-023 says stale.** Nothing is known to be wrong with the domains. The 15-minute
`instantly-poll` cron has stopped writing. Check MON-002 first, then `cron_heartbeats` for
`instantly-poll`, then the route's logs.

**MON-023 says failing.** Open the Sending Domain Health panel. One bad domain among four
good ones is that domain's problem: pause it in the sending tool and check its DNS records.
All five bad at once is a list-quality problem, not a domain problem, so check email
verification is running.

**The panel says "No data yet".** The verdict has never been written. Expected immediately
after deploy, before the first cron run. If it persists, the capability is probably not
registered:

```sql
SELECT capability, tool_name, is_active FROM integrations_registry
WHERE capability = 'can_report_sending_health';
```

**Figures look wrong.** Re-run the backfill; it is idempotent and safe at any time:

```
dotenv -e .env.local -- npx tsx scripts/backfill-sending-health.ts
```

**Useful queries.**

```sql
-- The monitor as the sweep sees it
SELECT * FROM mon_023;

-- The verdict and its per-domain breakdown
SELECT overall_state, computed_at, detail, jsonb_pretty(domains)
FROM sending_health_snapshot WHERE id = 1;

-- Raw daily data
SELECT sending_domain, sum(sends) AS sends, sum(bounces) AS bounces
FROM sending_mailbox_daily_stats
WHERE stat_date >= current_date - 6
GROUP BY 1 ORDER BY 3 DESC, 2 DESC;
```

---

## Security posture

Both tables and the view are **service-role only**: RLS enabled with zero policies, **and**
`REVOKE ALL ... FROM anon, authenticated` by name. Both, not either — RLS with no policies
denies the rows but does not remove the grant sitting underneath it, which is the
2026-08-25 `verification_calls` finding. The view is revoked separately because a view runs
with its owner's privileges and would otherwise hand anon the rows without RLS ever being
consulted, which is the 2026-08-26 finding.

All 27 privilege checks were read back in **both** directions after the migration applied.

This is operator-only and never client-facing. `get-client-visible-campaign-metrics.ts`
already draws that line: "per-mailbox attribution, complaint rate, mailbox health, and
anything that identifies WHICH addresses bounced" is diagnostic. A client sees their own
org-level bounce total and nothing here.

---

## Not built, deliberately

- **Auto-pause.** Needs write access to the sending tool, and it would be the first
  automated action taken on a number that has never once been non-zero. The monitor alerts;
  a human pauses. Revisit after a real bounce has travelled the whole path.
- **Hard versus soft bounce.** The source reports one bounce count with no breakdown.
- **Spam complaint rate, inbox placement, domain reputation.** Not available from any
  endpoint surveyed.
- **Per-recipient-domain analysis** (are Outlook recipients bouncing more than Gmail).
  A real question, different data.
