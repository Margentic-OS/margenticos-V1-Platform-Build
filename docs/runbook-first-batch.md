# Runbook: the first live synthesis batch

Written 2026-08-26, BEFORE anything is flipped. Nothing in here is to be improvised on
the day.

Everything below assumes the branch is merged and deployed to production. The whole
point of the sequencing is that each step is reversible on its own, and that the step
which spends money comes last and smallest.

---

## What we are trying to find out

One number decides whether this change is worth keeping:

> **`cache_read_input_tokens` as a share of total input on the first real batch.**

Everything else is machinery. The 50% batch discount is guaranteed by Anthropic and
needs no proof. The *caching* half is not guaranteed: Anthropic documents in-batch
cache hits as best-effort at **30% to 98%**, and our own evidence is a 13-call probe
that used `max_tokens: 16` while production uses 16,000 and generates about 6,200
output tokens per call. A real batch may spread further in time and read less.

**Break-even, stated so it can be checked rather than argued:**

| TTL | Write cost | Read cost | Cost per request at B reads per write |
|---|---|---|---|
| 5 minutes | 1.25x base input | 0.1x | `(1.25 + 0.1(B-1)) / B` |
| 1 hour | 2.00x base input | 0.1x | `(2.00 + 0.1(B-1)) / B` |

They are equal at **B = 6.84**. Below that, the 5-minute TTL is cheaper. The batched
call currently asks for `ttl: '1h'` (`BATCH_CACHE_TTL` in
`src/lib/agents/prospect-research-sources-agent.ts`). That choice is **provisional** and
this run is what settles it.

---

## Before anything is flipped

Confirm all five. Any one failing stops the run.

1. **The branch is merged and deployed.** The pg_cron migration POSTs to
   `app.margenticos.com`, which serves `main`.

2. **The route exists in production and is gated:**
   ```
   POST https://app.margenticos.com/api/cron/synthesis-batch-sweep   ->  401, not 404
   ```
   A 404 here means the deploy has not landed. Scheduling against a 404 gives a failing
   heartbeat every five minutes that reads as a broken sweep rather than a missing deploy.

3. **MON-022 reads OK.**
   ```sql
   SELECT state, detail FROM mon_022;
   ```
   This is the structural check: all three uniqueness indexes present, at most one
   research path enabled, RLS on both synthesis tables, neither reachable by anon. If it
   is PROBLEM, the detail line names which guarantee is missing. Fix it with a migration
   first. Do not work around it.

4. **Flags are at their starting state:**
   ```sql
   SELECT key, enabled FROM system_flags WHERE key LIKE 'queue_research%';
   -- queue_research           true
   -- queue_research_collect   false
   -- queue_research_sources   false
   ```

5. **Both tables are empty.**
   ```sql
   SELECT (SELECT count(*) FROM synthesis_batches)       AS batches,
          (SELECT count(*) FROM synthesis_batch_entries) AS entries;
   ```

---

## The flips, in order, and why the order is the order

### Step 1. Schedule the sweep, with every flag still false

Apply `supabase/migrations/20260826150000_synthesis_batch_sweep_pg_cron.sql`.

**Why first.** With `queue_research_sources` false, nothing ever creates a
`pending_submission` entry, so the sweep finds nothing, writes a heartbeat, and idles at
zero cost. We want the machinery running and **provably idle** before it has any work,
not switched on at the same moment as the work.

**Wait 10 minutes**, then confirm:

```sql
SELECT ran_at, ok, detail FROM cron_heartbeats
WHERE job_name = 'synthesis-batch-sweep' ORDER BY ran_at DESC LIMIT 3;

SELECT state, detail FROM mon_021;
```

Expect at least two heartbeats, `ok = true`, and MON-021 moving from `UNKNOWN` to `OK`.

**If MON-021 stays UNKNOWN:** the cron is not firing. Check
`SELECT jobname, active FROM cron.job WHERE jobname = 'synthesis-batch-sweep';`

**If heartbeats show `ok = false`:** read the detail. `ANTHROPIC_API_KEY is not set` is
the likely one, and it fails before doing any work, by design.

**Reverse:** `SELECT cron.unschedule('synthesis-batch-sweep');`

### Step 2. Turn on the drain valve, still with no work entering

```sql
UPDATE system_flags SET enabled = true, updated_by = 'first-batch-runbook'
WHERE key = 'queue_research_collect';
```

**Why before the switch, not after.** `queue_research_collect` lets phase 2 claim work.
With it off and `queue_research_sources` on, phase 1 would buy sources and submit a batch
that nothing ever reads: money spent on work that cannot finish. The operator route
refuses that combination outright (409), but the ordering here means we never rely on
that refusal.

**Reverse:** set it back to false. Safe at this point *only* because nothing is in
flight. Once batches exist, see the abort section.

### Step 3. The switch. This is the money step.

```sql
UPDATE system_flags SET enabled = false, updated_by = 'first-batch-runbook'
WHERE key = 'queue_research';

UPDATE system_flags SET enabled = true, updated_by = 'first-batch-runbook'
WHERE key = 'queue_research_sources';
```

**Both statements, in that order.** They are mutually exclusive at the database level:
turning the second on while the first is still on fails with `23505` on
`system_flags_research_path_exclusive`. That is the index doing its job, not an error to
work around.

### Step 4. Run ONE small batch

From the operator dashboard, research **a single organisation with a small unresearched
set. Five to ten prospects.** Not a full backlog.

Five to ten is chosen deliberately: enough that a cache read rate means something (the
first request in any batch is always a write, so at 5 prospects the ceiling is 4 reads to
1 write, i.e. B = 5), and few enough that a total failure costs about 50 cents of sources
rather than tens of dollars.

---

## What to watch, in order, with the numbers

### Within 5 minutes: the batch was submitted

```sql
SELECT id, anthropic_batch_id, state, request_count, cache_ttl,
       requested_at, submitted_at, expires_at
FROM synthesis_batches ORDER BY requested_at DESC LIMIT 5;
```

**Good:** one row, `state = 'submitted'`, `anthropic_batch_id` populated, `cache_ttl = '1h'`,
`request_count` matching the number of prospects.

**One row per prospect instead of one row total** means the gather is not batching. Stop
and investigate before running more: the discount still applies but the cache benefit,
about a third of the saving, does not.

**`state = 'attempted'` with a null `anthropic_batch_id` for more than 30 minutes** is
the un-receipted window. MON-021 goes PROBLEM on exactly this. Do NOT resubmit and do NOT
requeue by hand. The next sweep reconciles it by matching `custom_id`s. Watch for
`reconciled_batches` in the sweep's heartbeat detail.

### Within about an hour: the batch completed

```sql
SELECT b.anthropic_batch_id, b.state, b.counts, b.ended_at, b.collected_at,
       count(e.*) FILTER (WHERE e.state = 'succeeded')  AS succeeded,
       count(e.*) FILTER (WHERE e.state IN ('errored','expired','cancelled')) AS failed,
       count(e.*) FILTER (WHERE e.state = 'collected')  AS collected
FROM synthesis_batches b
LEFT JOIN synthesis_batch_entries e ON e.batch_id = b.id
GROUP BY b.id ORDER BY b.requested_at DESC LIMIT 5;
```

Most batches finish inside an hour. The ceiling is 24 hours, and the sweep ages one out
at 25.

### THE NUMBER

```sql
SELECT
  sum((usage->>'cache_read_input_tokens')::bigint)      AS cache_reads,
  sum((usage->>'cache_creation_input_tokens')::bigint)  AS cache_writes,
  sum((usage->>'input_tokens')::bigint)                 AS uncached_input,
  sum((usage->>'output_tokens')::bigint)                AS output,
  round(
    100.0 * sum((usage->>'cache_read_input_tokens')::bigint)
    / nullif(sum((usage->>'cache_read_input_tokens')::bigint)
           + sum((usage->>'cache_creation_input_tokens')::bigint)
           + sum((usage->>'input_tokens')::bigint), 0), 1) AS cache_read_pct,
  round(
    sum((usage->>'cache_read_input_tokens')::bigint)::numeric
    / nullif(sum((usage->>'cache_creation_input_tokens')::bigint), 0), 2) AS reads_per_write
FROM synthesis_batch_entries
WHERE usage IS NOT NULL AND updated_at > now() - interval '6 hours';
```

`reads_per_write` is the **B** in the break-even table. Read it against 6.84.

| Result | Reading | Action |
|---|---|---|
| **B above 7** | The 1-hour TTL is paying for itself | Keep it. Record the number in the ADR. |
| **B between 5 and 7** | Ambiguous, close to break-even | Keep the TTL for now, run a second batch before deciding. Do not conclude from one run. |
| **B below 5** | The 1-hour TTL is a LOSS | Set `BATCH_CACHE_TTL` to `'5m'` and re-measure. The batch discount is unaffected. |
| **`cache_reads` = 0 across the batch** | Caching is not working at all in-batch | Stop. See the abort section. |

**A note on honesty here.** The 13-call probe measured 85% at 1h. If this run lands near
the 30% floor, that is the answer, and the earlier probe was measuring a different thing:
`max_tokens: 16` against production's 16,000. Report the number that came back, not the
number we expected.

### The reconciliation against Anthropic's console

Open the Anthropic console's Batches view. For the batch id in `synthesis_batches`:

- **request counts match** our `counts` column
- **the cost shown is roughly half** the equivalent non-batch spend
- **the number of batches matches** ours (one per organisation, not one per prospect)

If the console shows a batch we have no row for, that is an orphaned submission and the
reconciliation path is what should have caught it. Say so; do not delete it.

### The copy, which is the point of all of it

```sql
SELECT p.first_name, p.company_name, p.personalisation_trigger,
       r.icp_fit, r.qualification_status, r.selected_candidate_id,
       e.doc_superseded
FROM prospects p
JOIN prospect_research_results r ON r.id = p.current_research_result_id
LEFT JOIN synthesis_batch_entries e ON e.prospect_id = p.id
WHERE p.organisation_id = '<org>' AND r.created_at > now() - interval '6 hours';
```

**Read the openings.** The whole claim of this change is that batching alters nothing
about the copy. If an opening looks off, it is not the batching: the same
`synthesisFromMessage`, the same `selectCandidate`, the same writer and judge ran. But
read them anyway, because that claim is the thing worth checking on the first run.

`doc_superseded = true` on any row means the messaging document was revised during the
wait and the opening was written against the snapshot. That is correct behaviour, and
worth knowing it happened.

---

## The abort

### Abort criteria. Any one of these.

1. **`cache_reads` = 0 across the whole batch.** Caching is not surviving batching, and a
   third of the saving is gone. The change may still be worth keeping on the 50% discount
   alone, but that is a different decision made with different numbers.
2. **MON-021 PROBLEM on the un-receipted case** and reconciliation does not clear it
   within two sweeps. That is the only state that can lead to paying twice.
3. **Any prospect gets an opening that does not match its research**, or a research row
   appears for a prospect that was not in the batch.
4. **`failed` entries above 20% of the batch.** MON-021 alarms on this over 24h.
5. **Apify actor runs start getting rejected.** Means both research paths are somehow
   live; MON-022 should already be red.

### The abort itself

```sql
-- ONE statement. New work goes down the proven path immediately.
UPDATE system_flags SET enabled = true,  updated_by = 'abort'
WHERE key = 'queue_research';

UPDATE system_flags SET enabled = false, updated_by = 'abort'
WHERE key = 'queue_research_sources';
```

Order matters again: `queue_research_sources` must go false before `queue_research` goes
true, or the exclusion index refuses the second statement. Run them the other way round
if the first fails.

### **DO NOT TURN OFF `queue_research_collect`.**

This is the one instruction in this document most likely to be got wrong under pressure,
because turning everything off feels like the safe move. It is not.

Batches already submitted are **already paid for**. Their results sit in Anthropic's
store for 29 days. `queue_research_collect` is what lets phase 2 read them. Turning it
off strands that money permanently: the sweep goes idle, nothing collects, and the
prospects keep their bought sources and never get copy.

**Leave it ON until every in-flight batch has drained.** Confirm with:

```sql
SELECT count(*) FROM synthesis_batches WHERE state IN ('attempted','submitted','ended');
-- must be 0
SELECT count(*) FROM synthesis_batch_entries
WHERE state IN ('pending_submission','submitted','succeeded','errored','expired');
-- must be 0
```

Only when both are zero is it safe to turn the drain valve off, and even then there is
little reason to.

### What the abort does NOT undo

- Sources already bought stay bought. They are on the entry rows and a later run reuses
  them rather than re-buying, which is exactly what those columns are for.
- Research rows already written stay written. They are complete and correct rows.
- `personalisation_trigger` values already set stay set. That is shipped copy.

Nothing needs cleaning up. The paths were built so that stopping is a flag flip, not a
recovery operation.

---

## After a successful run

1. Record the measured `reads_per_write` and `cache_read_pct` in ADR-033, replacing the
   word "provisional" with the number.
2. If B came back below 5, change `BATCH_CACHE_TTL` to `'5m'` in the same commit.
3. Compute the actual per-prospect saving from `synthesis_batch_entries.usage` against the
   $0.192 all-in baseline, and write it down. The forecast was 20 to 31%.
4. Only then consider raising the batch size beyond one small organisation.
