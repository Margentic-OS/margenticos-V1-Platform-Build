-- MON-013 could not fire. Remove the clause that made it unreachable.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT WAS WRONG
-- ─────────────────────────────────────────────────────────────────────────────
--
-- MON-013 exists to catch a campaign with no provider id. It read:
--
--     WHERE c.status = 'active'
--       AND c.external_id IS NULL
--       AND o.archived_at IS NULL
--
-- The two campaign conditions are mutually exclusive in this system:
--
--   * registerCampaign is the ONLY non-test insert into campaigns and it hardcodes
--     status 'draft'. Verified by a repo-wide search with a positive control.
--   * status is only ever updated afterwards by the instantly-poll campaign refresh,
--     and that refresh selects `.not('external_id', 'is', null)`. A row with a NULL
--     external_id is never touched, so it can never reach 'active'.
--
-- So a row could satisfy `external_id IS NULL` or `status = 'active'`, never both, and
-- the view returned zero rows reassuringly from the day it was written.
--
-- MEASURED, not reasoned about, and the measurement is stated in full because half of
-- it cuts against the change. On 2026-09-07:
--
--     old predicate, live orgs .................. 0 rows
--     new predicate, live orgs .................. 0 rows
--     campaigns with no external_id, any org .... 1 row
--
-- So THIS CHANGE ALTERS NOTHING ABOUT TODAY'S DATA. The one orphan sits in an archived
-- organisation and the archived exclusion, which is kept, still hides it. Anyone
-- expecting the board to change after this ships should not.
--
-- What it fixes is the unreachability, proved against the predicate directly rather
-- than against a dataset that happens not to contain the case:
--
--     campaign state (live org)              old view    new view
--     draft,     no provider id .............. no ........ YES     <- the real case
--     completed, no provider id .............. no ........ YES
--     active,    no provider id .............. yes ....... yes
--     draft,     has provider id ............. no ........ no      <- control
--
-- The first row is the one that matters: registerCampaign hardcodes 'draft', so a
-- genuinely broken setup lands there and the old view was blind to it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS MATTERS BEYOND A TIDY-UP
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The reply poller resolves a campaign by external_id. A campaign with a NULL
-- external_id can never match, so any reply for it is dropped permanently by the
-- unresolved-campaign branch. This monitor is the upstream warning for that whole
-- class, and it was switched off by a clause nobody re-read.
--
-- Same family as the privilege audit that filtered relkind = 'r' and could not see a
-- view, and as the monitor sweep whose loop was bounded by the shorter of two arrays.
-- When the check is the thing that is wrong, nothing downstream of it can notice.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE CHANGE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Drop the status clause entirely rather than widening it to a list of statuses. A
-- campaign with no provider id is worth naming whatever its status: it cannot receive
-- replies, cannot be polled, and cannot be reconciled. Keeping any status predicate
-- would only reintroduce the same coupling in a less obvious form.
--
-- The archived-organisation exclusion is KEPT. An archived client's campaigns are
-- dormant by intention and naming them would be noise. That exclusion is itself under
-- review as a separate item, since collection and processing do not honour it while
-- three monitors do, but changing it here would conflate two decisions.
--
-- Status is still reported in the detail line, because "completed with no external_id"
-- and "draft with no external_id" call for different actions: the first is probably
-- historical and the second is probably an interrupted setup.

CREATE OR REPLACE VIEW public.mon_013 AS
  WITH orphaned AS (
    SELECT
      count(*) AS count,
      min(c.name) AS first_name,
      min(c.status) AS first_status
    FROM public.campaigns c
    JOIN public.organisations o ON c.organisation_id = o.id
    WHERE c.external_id IS NULL
      AND o.archived_at IS NULL
  )
  SELECT
    'MON-013'::text AS check_code,
    CASE
      WHEN count = 0 THEN 'OK'
      ELSE 'PROBLEM'
    END AS state,
    CASE
      WHEN count = 0 THEN 'Every campaign of a live client has a provider id.'
      ELSE count::text || ' campaign(s) have no provider id, so they cannot be polled, '
        || 'reconciled, or matched to an incoming reply. First: '
        || COALESCE(first_name, '(unnamed)') || ', status '
        || COALESCE(first_status, '(none)') || '.'
    END AS detail,
    now() AS check_time
  FROM orphaned;

REVOKE ALL ON public.mon_013 FROM PUBLIC;
REVOKE ALL ON public.mon_013 FROM anon, authenticated;
GRANT SELECT ON public.mon_013 TO service_role;

UPDATE public.monitor_checks
   SET description = 'Reports any campaign belonging to a live client that has no provider '
         || 'id set. Previously also required status = ''active'', which no campaign with a '
         || 'NULL external_id can ever reach, so the check could not fire.',
       plain_meaning = 'Every campaign we hold for a live client is properly connected to the '
         || 'sending tool.',
       plain_impact = 'A campaign with no provider id is invisible to the sending tool in both '
         || 'directions. It is never polled, it is never reconciled, and a reply that arrives '
         || 'for it cannot be matched to a client, so it is dropped and nobody is told. This '
         || 'check previously carried a second condition that no such campaign could ever '
         || 'satisfy, so it reported all-clear for its whole life, including while exactly the '
         || 'row it was written to catch was sitting in the table.',
       plain_action = 'Find the campaign named in the detail line and set its provider id to '
         || 'the matching campaign in the sending tool. If the campaign is historical and has '
         || 'no counterpart there, archive its client or delete the row rather than leaving it '
         || 'to age. Never silence this by adding a status filter back.'
 WHERE code = 'MON-013';
