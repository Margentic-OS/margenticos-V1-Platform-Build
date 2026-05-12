-- Migration: 20260513_users_pending_review.sql
--
-- Three parts:
--
-- 1. users_pending_review table
--    Captures duplicate invite attempts — inserted by the handle_new_user trigger
--    when a second client user is invited to an org that already has one.
--    Operator SELECT only via RLS (trigger writes via SECURITY DEFINER, bypassing RLS).
--    A Supabase Database Webhook on INSERT fires the operator notification email.
--
-- 2. Partial unique index on users(organisation_id) WHERE role = 'client'
--    Prevents the race condition where two simultaneous invites both create a
--    public.users row for the same org. One succeeds; the other gets unique_violation,
--    which the trigger catches and routes to users_pending_review.
--
-- 3. handle_new_user() function + on_auth_user_created trigger
--    Fires AFTER INSERT on auth.users. For client invites (identified by
--    raw_user_meta_data->>'intended_role' = 'client'):
--      - Reads organisation_id from raw_user_meta_data
--      - Attempts INSERT into public.users
--      - On unique_violation: inserts into users_pending_review instead
--        (auth.users row remains; user has no app access without a public.users row)
--      - Does NOT raise exception — the transaction commits, persisting the
--        users_pending_review row so the Database Webhook can fire.
--    Operator invites (role_intent IS NULL or != 'client') pass through unchanged.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
--   DROP FUNCTION IF EXISTS public.handle_new_user();
--   DROP INDEX IF EXISTS public.users_one_client_per_org;
--   DROP TABLE IF EXISTS public.users_pending_review;

BEGIN;

-- ── Part 1: users_pending_review table ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.users_pending_review (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL,
  attempted_org_id uuid     NOT NULL REFERENCES public.organisations(id),
  attempted_at  timestamptz NOT NULL DEFAULT now(),
  reviewed      boolean     NOT NULL DEFAULT false
);

ALTER TABLE public.users_pending_review ENABLE ROW LEVEL SECURITY;

-- Operators can read all pending review rows. No INSERT/UPDATE/DELETE for
-- authenticated users — only the trigger writes here (SECURITY DEFINER).
CREATE POLICY "operators_read_all_pending_review"
  ON public.users_pending_review
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE users.id = auth.uid()
        AND users.role = 'operator'
    )
  );

-- ── Part 2: Partial unique index on users(organisation_id) WHERE role = 'client' ──

-- Prevents two simultaneous invites from both inserting a client row for the
-- same org. Postgres handles concurrent inserts atomically — one succeeds,
-- the other gets unique_violation (caught by the trigger).
CREATE UNIQUE INDEX IF NOT EXISTS users_one_client_per_org
  ON public.users (organisation_id)
  WHERE role = 'client';

-- ── Part 3: handle_new_user() function and trigger ────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  org_id      uuid;
  role_intent text;
BEGIN
  org_id      := (NEW.raw_user_meta_data->>'organisation_id')::uuid;
  role_intent := NEW.raw_user_meta_data->>'intended_role';

  -- Safety door: only handle client invites. Operators are created via SQL
  -- with no metadata. Do NOT extend this function to handle operators.
  IF role_intent IS NULL OR role_intent != 'client' THEN
    RETURN NEW;
  END IF;

  IF org_id IS NULL THEN
    RAISE EXCEPTION 'missing_organisation_id_in_invite_metadata';
  END IF;

  BEGIN
    INSERT INTO public.users (id, email, organisation_id, role)
    VALUES (NEW.id, NEW.email, org_id, 'client');
  EXCEPTION WHEN unique_violation THEN
    -- Org already has a client user. Record the attempt for operator review.
    -- Do NOT re-raise — let the transaction commit so this row persists
    -- and the Database Webhook can fire the operator notification.
    INSERT INTO public.users_pending_review (email, attempted_org_id)
    VALUES (NEW.email, org_id);
  END;

  RETURN NEW;
END;
$$;

-- Drop existing trigger before recreating (idempotent)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

COMMIT;
