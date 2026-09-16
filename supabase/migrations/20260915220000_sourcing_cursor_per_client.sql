-- Status: APPLIED (verified live 2026-09-15)
--   Applied via Supabase MCP apply_migration to BOTH projects:
--     hjpvnvjryxdjcfdsfhzy (production)  and  tidqheqjzvwmrrrebzir (test)
--   Applying to the test project too is not optional: the suite runs against it, and a
--   live test meeting a missing column fails for a reason that looks nothing like the cause.
--   Read back on production, expecting t / f / f and getting exactly that:
--     service_role  SELECT/INSERT/UPDATE/DELETE  t t t t
--     anon          SELECT/INSERT/UPDATE/DELETE  f f f f
--     authenticated SELECT/INSERT/UPDATE/DELETE  f f f f
--     relrowsecurity = true, policies = 0
--   All four privileges checked per role, not just SELECT: a privilege list with omissions
--   is how client_organisation_view's write grants stayed invisible for a day.

-- Where each client's sourcing has reached in the provider's result set.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE DEFECT THIS EXISTS FOR
--
-- The sourcing handler set `page = 1` on every run, so every run read records 1..cap of the
-- same result set and dedupe threw away everything it had seen before.
--
-- Measured on three consecutive runs for the live client on 2026-09-15:
--
--     21:30:45   cap 30   returned 30   written 24   duplicates  6
--     21:31:52   cap 36   returned 36   written  4   duplicates 32
--     21:32:32   cap 44   returned 44   written  8   duplicates 36
--     ------------------------------------------------------------
--     total               returned 110  written 36   duplicates 74   (67.3%)
--
-- Run 3's window added exactly records 37 to 44 over run 2's, which is 8 records, and it
-- wrote exactly 8. The always-start-at-one model predicts the observed output almost
-- exactly, which is the evidence that a cursor fixes it.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY A RECORD OFFSET AND NOT A PAGE NUMBER
--
-- The three runs above used caps of 30, 36 and 44, and `per_page` is derived from the cap.
-- So "page 2" addressed a different range of records in each run, and a stored page number
-- would have been meaningless the moment the batch size changed. A record offset is stable
-- under any per_page and converts with page = floor(offset / per_page) + 1.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THE ICP DOCUMENT IS PART OF THE ROW
--
-- The offset is a position in ONE result set, and the result set is defined by the ICP
-- filter spec. A new ICP is a different query, so position 4,000 in the old one has no
-- relationship to position 4,000 in the new one. Carrying the offset across an ICP change
-- would skip the first 4,000 records of a result set nobody has ever read.
--
-- The reset is therefore keyed on the document that produced the spec. Recording it here
-- rather than inferring it means the reset is a visible column comparison, not a rule
-- someone has to remember.

CREATE TABLE IF NOT EXISTS public.sourcing_cursors (
  organisation_id  uuid PRIMARY KEY REFERENCES public.organisations(id) ON DELETE CASCADE,

  -- The ICP document whose spec defines the result set this offset indexes into.
  -- ON DELETE SET NULL rather than CASCADE: losing the document should force a reset on the
  -- next run, not silently delete the client's position and read from the top as though
  -- nothing had been sourced.
  icp_document_id  uuid REFERENCES public.strategy_documents(id) ON DELETE SET NULL,

  -- 0-based count of provider records already consumed for this client.
  -- Counts records READ, not prospects written: the handler's post-filters drop rows, and an
  -- offset that advanced only by survivors would re-read every dropped record on every run.
  record_offset    integer NOT NULL DEFAULT 0 CHECK (record_offset >= 0),

  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sourcing_cursors IS
  'Per-client resume position in the sourcing provider result set. Offset counts records '
  'READ, not prospects written. Reset when icp_document_id changes, because a new ICP is a '
  'different result set.';

-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY. Service-role only, and BOTH layers, per the 2026-08-25 finding.
--
-- RLS with zero policies genuinely denies every row to anon, and that is the layer doing the
-- work today. It does NOT remove the GRANT underneath it, because Supabase runs ALTER
-- DEFAULT PRIVILEGES on the public schema granting tables to anon and authenticated at
-- creation time. verification_calls was created exactly this way and RLS was the only thing
-- standing between an unauthenticated caller and the spend ledger.
--
-- So: enable RLS, and revoke the two roles BY NAME as well.

ALTER TABLE public.sourcing_cursors ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.sourcing_cursors FROM anon, authenticated;
GRANT ALL ON TABLE public.sourcing_cursors TO service_role;

-- Verify with, expecting t / f / f:
--   SELECT has_table_privilege('service_role',  'public.sourcing_cursors', 'SELECT'),
--          has_table_privilege('anon',          'public.sourcing_cursors', 'SELECT'),
--          has_table_privilege('authenticated', 'public.sourcing_cursors', 'SELECT');
-- Checking only the intended caller proves nothing about who else can reach it.
