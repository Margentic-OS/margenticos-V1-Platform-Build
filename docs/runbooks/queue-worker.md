# Runbook: the durable job queue and its worker

**What this is.** A background queue that runs the three slow, money-spending units of
work: `enrich` (Apollo), `research` (Apify plus Anthropic) and `compose` (Anthropic).
One row per prospect per job type.

**Why it exists.** All three used to run inside a single web request. Vercel kills any
request at 300s and research takes about 47 seconds per prospect, so one click could only
ever do about five. See ADR-029.

---

## Is it running?

```sql
SELECT check_code, state, detail FROM mon_016;   -- worker health
SELECT check_code, state, detail FROM mon_017;   -- is the queue draining
SELECT check_code, state, detail FROM mon_018;   -- failure rate
SELECT * FROM queue_depth;                       -- depth per job type and client
```

The worker writes a heartbeat every minute:

```sql
SELECT ran_at, ok, detail FROM cron_heartbeats
 WHERE job_name = 'queue-worker' ORDER BY ran_at DESC LIMIT 10;
```

**MON-016 reads `ok`, not just staleness.** A worker that runs punctually and fails every
time shows PROBLEM here. That is deliberately unlike MON-002, which only notices when a
cron stops arriving.

---

## Turning a job type on or off

Nothing runs unless **both** gates are open: the flag is true **and** a handler is
registered in `src/lib/queue/handlers.ts`.

```sql
SELECT key, enabled, note, updated_by FROM system_flags;

-- Turn one on
UPDATE system_flags SET enabled = true, updated_by = 'operator:doug', updated_at = now()
 WHERE key = 'queue_enrich';
```

Turning one **off** is the rollback, and it needs no deploy. The inline path takes over
again immediately.

If a flag is true but no handler is deployed, the worker refuses to claim and reports the
run as failed, which turns MON-016 red. That is intentional: otherwise work would pile up
with nothing able to run it and no symptom anywhere.

---

## What to check when something looks wrong

**MON-016 stale.** The cron stopped, or the route is failing before it can write.
```sql
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'queue-worker';
SELECT status, return_message, end_time FROM cron.job_run_details
 WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'queue-worker')
 ORDER BY end_time DESC LIMIT 5;
```
Note that `status = 'succeeded'` there only means pg_net **queued** the request. For the
real HTTP result:
```sql
SELECT status_code, left(content, 300), created FROM net._http_response
 ORDER BY created DESC LIMIT 5;
```

**MON-016 PROBLEM with a heartbeat present.** Read the `detail`. It names the first cause.

**MON-017 PROBLEM.** Work is queued and nothing is finishing. Check in this order: is the
flag on, is a handler deployed, does the provider account still have credit.

**MON-018 PROBLEM.** Read the failures and look for a cluster with one message, which
usually means a provider or configuration problem rather than bad luck:
```sql
SELECT last_error, last_error_class, count(*) FROM job_queue
 WHERE state = 'failed' AND updated_at > now() - interval '24 hours'
 GROUP BY 1, 2 ORDER BY 3 DESC;
```

---

## The circuit breaker

If two jobs in one pass fail with an account-exhaustion error (out of credit, quota
exceeded, 402), the worker **turns that job type's flag off by itself** and records
`updated_by = 'circuit-breaker:account-exhausted'`.

That is not a fault. Retrying thousands of queued jobs against a dry Apollo or Apify
account would burn attempts for nothing. Top the account up, then set the flag back to
true by hand. Nothing turns itself back on.

---

## Things that will surprise you

**A job that has already been paid for is never retried.** If a worker dies after the
external API returned, `spend_recorded_at` is set. The next attempt refuses to run and
goes terminal with a reason. Losing that job is deliberate: we cannot reconstruct a
response we already paid for, and calling again is the bug that cost 141 Apollo credits
for 29 prospects on 10 August 2026.

**A worker invocation finishes what it claims; it does not resume.** If it is killed at
the 300s wall, the work in flight is lost and one attempt is burned. The lease is what
makes the row recoverable.

**Research is capped at 10 in flight, globally.** Not a preference: Apify allows 25
concurrent actor runs and the LinkedIn source uses two per prospect. Raising it without
raising the Apify plan buys actor-run rejections, not throughput. `assertQueueConfig()`
throws at startup if someone tries.

**Spend, not speed, is the real ceiling.** At 10 in flight the queue can do roughly 1,300
research prospects a day, but the Apify plan funds roughly 833 to 1,666 a **month**.
