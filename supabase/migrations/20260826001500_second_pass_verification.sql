-- Second-pass email verification: schema, paid-call ledger, and monitoring.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT THIS IS FOR
--
-- MyEmailVerifier runs on the whole list and reports "Catch All" for domains that accept
-- mail for every address. That is honest: an SMTP probe cannot confirm a specific mailbox on
-- such a domain. It is also, at current volume, a dead end. Best practice caps accept-all
-- addresses at 2-5% of a campaign, and with 8 catch-alls carrying finished copy that implies
-- a batch of 160 to 400 prospects to mail them. There are 13 send-eligible prospects in
-- total. The cap makes the bucket unsendable, so the only route to those 8 is resolving them
-- OUT of the bucket, at which point they are ordinary deliverable addresses and uncapped.
--
-- A second, resolution-capable vendor runs on the catch-all and unknown segment ONLY. This
-- is a two-step pattern, not a vendor swap. Measured on the live cohort 2026-08-25: 8 of 10
-- resolved deliverable.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY SECOND-PASS COLUMNS AND NOT A GENERIC verification_results TABLE
--
-- Approved by Doug 2026-08-25. There are two vendors, not N. A generic per-provider verdict
-- table would add a join to every place eligibility is read to buy flexibility for a third
-- vendor that does not exist. The verdict is read on the hot path at send and research time
-- and wants to be a flat column.
--
-- The genuinely separate need is COUNTING PAID CALLS, which flat columns cannot do: a call
-- that spent money and then failed leaves no verdict to write, so it leaves no trace. That
-- is a known residual of the first pass, tolerable there because the first vendor is free.
-- This vendor is $8 per 1,000, and a paid call you cannot count is a budget you cannot
-- enforce. Hence verification_calls, whose job is accounting, not verdicts.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- NOTE ON THE COLUMN NAMES: NO VENDOR NAME ANYWHERE
--
-- prospects.verification_provider carries a column DEFAULT of the literal string
-- 'myemailverifier'. A vendor name in a column default is the hardest kind to remove,
-- because every existing row carries it. second_pass_provider therefore has NO DEFAULT: it
-- is written explicitly by whichever handler produced the verdict, or stays null.

BEGIN;

-- ── 1. Second-pass verdict on the prospect ───────────────────────────────────────────
ALTER TABLE public.prospects
  -- The vendor's own word, verbatim. The canonical translation lives in
  -- src/lib/sourcing/verification-verdict.ts and is applied on read, never on write, so the
  -- audit trail keeps the vendor's actual answer.
  ADD COLUMN IF NOT EXISTS second_pass_status        text,
  ADD COLUMN IF NOT EXISTS second_pass_reason        text,
  -- 0-100. RECORDED SO A THRESHOLD CAN BE DERIVED LATER FROM REAL DATA. Gated on by nothing:
  -- the 2026-08-25 sample scored 90/90/90/90/90/90/90/90/75/15, which leaves the entire
  -- usable range between 75 and 90 unobserved. n=10 cannot support a numeric cut-off.
  ADD COLUMN IF NOT EXISTS second_pass_score         integer,
  ADD COLUMN IF NOT EXISTS second_pass_provider      text,
  ADD COLUMN IF NOT EXISTS second_pass_verified_at   timestamptz,
  -- Whether the second vendor AGREES the domain is catch-all. On the sample it said yes on
  -- all ten while still resolving eight, which is the evidence for the whole approach. If
  -- this starts coming back false on addresses the first pass called catch-all, the vendors
  -- disagree about the DOMAIN, which is a worse problem than disagreeing about a mailbox.
  ADD COLUMN IF NOT EXISTS second_pass_accept_all    boolean,
  ADD COLUMN IF NOT EXISTS second_pass_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS second_pass_locked_at     timestamptz,
  ADD COLUMN IF NOT EXISTS second_pass_error         text;

-- Selection predicate for the sweep: unlocked-or-stale, under the attempt cap, first pass
-- said something unconfirmable. Partial index because the eligible set is a small minority.
CREATE INDEX IF NOT EXISTS idx_prospects_second_pass_pending
  ON public.prospects (organisation_id, second_pass_locked_at)
  WHERE second_pass_status IS NULL
    AND independent_email_status IS NOT NULL
    AND suppressed = false;

-- ── 2. The paid-call ledger ──────────────────────────────────────────────────────────
--
-- ONE ROW PER PAID ATTEMPT, WRITTEN BEFORE THE CALL.
--
-- Written before rather than after, and that ordering is the whole point. A row written
-- after a successful call cannot record the call that spent money and then failed, which is
-- precisely the case a budget has to count. Writing first costs one extra insert per address
-- and makes an uncounted paid call impossible short of the process dying between the insert
-- and the fetch.
CREATE TABLE IF NOT EXISTS public.verification_calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  -- SET NULL rather than CASCADE: if a prospect is deleted, the fact that money was spent
  -- on it is still true and still has to be countable.
  prospect_id     uuid REFERENCES public.prospects(id) ON DELETE SET NULL,
  provider        text        NOT NULL,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  outcome         text        NOT NULL DEFAULT 'attempted',
  verdict         text,
  score           integer,
  error           text,
  CONSTRAINT verification_calls_outcome_valid
    CHECK (outcome IN ('attempted', 'ok', 'failed'))
);

-- The budget query: count calls for one provider since the start of the UTC day.
CREATE INDEX IF NOT EXISTS idx_verification_calls_provider_requested
  ON public.verification_calls (provider, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_verification_calls_prospect
  ON public.verification_calls (prospect_id);

-- ── 3. RLS: enabled with no policies, so only service_role reaches it ────────────────
--
-- CLAUDE.md requires RLS on every table before any data is written. This table holds
-- operational spend accounting and is never read by a client or by a browser session, so it
-- gets NO policies at all. Enabling RLS without policies denies anon and authenticated
-- outright; service_role bypasses RLS and is the only caller.
--
-- THE PARAGRAPH THAT USED TO BE HERE WAS WRONG, and the read-back caught it. It said this
-- migration creates no functions, so there was "nothing here to revoke". That is true of
-- EXECUTE on functions and false of tables: ALTER DEFAULT PRIVILEGES grants table privileges
-- to anon and authenticated as well, and immediately after this ran,
--
--     has_table_privilege('anon', 'public.verification_calls', 'SELECT')  ->  true
--
-- RLS makes that harmless, verified: as anon, with a live row present, the table returned 0
-- rows. But it means RLS is the ONLY control, and a later migration adding a permissive
-- policy would open the ledger with no other layer behind it. Closed by revoking the roles
-- by name in 20260826002000_verification_calls_revoke_anon_authenticated.sql.
--
-- The lesson generalises the CLAUDE.md rule: assuming the effect of a grant instead of
-- reading it back is the mistake, and it is not limited to functions.
ALTER TABLE public.verification_calls ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. MONITORING. A scheduled job that cannot be observed is a scheduled job you do not have.
--
-- Three things are required and all three are here, because any one missing leaves the job
-- dark: the view, the monitor_checks row, and the sweep querying it. The third lives in
-- src/app/api/cron/monitor-sweep/monitors.ts and is added in the same commit.
--
-- MON-019 is the cautionary tale. Its view was created and its monitor_checks row seeded, the
-- name was added to the sweep's viewNames array, and it was STILL never read, because the
-- sweep looped over a second parallel array that was one entry shorter. Fixed in the same
-- session by replacing both arrays with pairs.
--
-- This view reads ok into its STATE, following mon_016 and mon_019 rather than mon_002.
-- mon_002 derives state from staleness alone, so a job that runs punctually and fails every
-- single time reads OK there.

CREATE OR REPLACE VIEW public.mon_020 AS
  SELECT 'MON-020'::text AS check_code,
    CASE
      WHEN max(ran_at) IS NULL THEN 'UNKNOWN'::text
      -- 90 minutes against a 30-minute schedule: three missed firings. Looser than MON-019's
      -- two because this sweep is the low-priority one. It spends money, its backlog is
      -- small and bounded, and nothing downstream stalls while it is quiet, so paging on a
      -- single blip would train the alarm to be ignored.
      WHEN (EXTRACT(epoch FROM (now() - max(ran_at))) / 60::numeric) > 90::numeric THEN 'PROBLEM'::text
      WHEN bool_or(NOT ok) FILTER (WHERE ran_at > now() - interval '120 minutes') THEN 'PROBLEM'::text
      ELSE 'OK'::text
    END AS state,
    COALESCE(
      max(CASE WHEN ok = false THEN detail ELSE NULL::text END),
      'Last run: '::text || to_char(max(ran_at), 'YYYY-MM-DD HH24:MI:SS UTC'::text)
    ) AS detail,
    max(ran_at) AS last_run
  FROM public.cron_heartbeats
  WHERE job_name = 'verify-catch-all'::text;

-- ON CONFLICT DO UPDATE, not DO NOTHING. MON-016 was seeded with DO NOTHING, a pre-existing
-- row won, and the live dashboard still shows the wrong title for it.
INSERT INTO public.monitor_checks
  (code, title, description, category, tier, is_scheduled, expected_interval_minutes,
   plain_meaning, plain_impact, plain_action)
VALUES (
  'MON-020',
  'Catch-all second-pass verification every 30m',
  'Confirms /api/cron/verify-catch-all is running and succeeding. PROBLEM on three missed '
    || 'firings (90 minutes) or on any failed run in the last two hours. This sweep spends '
    || 'real money per address, so a failed run may mean the credit balance is empty.',
  'liveness',
  2,
  true,
  30,
  'The job that takes a second look at addresses on catch-all domains is running.',
  'If it stops, prospects on catch-all domains stay unmailable and their finished copy sits '
    || 'unused. Nothing breaks and no error appears: the pipeline simply produces fewer '
    || 'sendable prospects than it paid to research.',
  'Check the verify-catch-all pg_cron job is scheduled and active, then check the Bouncer '
    || 'credit balance. A 402 from the vendor means the pay-as-you-go balance is empty, which '
    || 'looks like a bug and is a billing state.'
)
ON CONFLICT (code) DO UPDATE SET
  title                     = EXCLUDED.title,
  description               = EXCLUDED.description,
  category                  = EXCLUDED.category,
  tier                      = EXCLUDED.tier,
  is_scheduled              = EXCLUDED.is_scheduled,
  expected_interval_minutes = EXCLUDED.expected_interval_minutes,
  plain_meaning             = EXCLUDED.plain_meaning,
  plain_impact              = EXCLUDED.plain_impact,
  plain_action              = EXCLUDED.plain_action;

-- Status: APPLIED (verified live 2026-08-25)
--
-- Live read-back immediately after apply:
--
--   second_pass columns on prospects   9
--   verification_calls exists          yes
--   verification_calls RLS enabled     true
--   verification_calls policy count    0        (RLS with no policies = service_role only)
--   anon rows visible with a live row  0        (checked under SET LOCAL ROLE anon,
--                                                inside BEGIN ... ROLLBACK)
--   mon_020 state                      UNKNOWN  (correct: no heartbeat yet, the job is
--                                                not scheduled)
--   MON-020 in monitor_checks          1
--   second_pass_provider default       NONE     (deliberate, see the note above)
--
-- One thing the read-back caught: anon held a table-level SELECT GRANT despite RLS blocking
-- every row, because Supabase's ALTER DEFAULT PRIVILEGES grants it at creation time. Closed
-- in 20260826002000_verification_calls_revoke_anon_authenticated.sql.
