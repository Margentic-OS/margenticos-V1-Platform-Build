// Everything Supabase provides that PGlite does not. Stubbed so that a migration failure is
// attributable to OUR SQL rather than to a missing extension. Anything left failing after
// this is a defect in the migration set, which is the whole point of the exercise.
export const BOOTSTRAP = [
  // Roles Supabase creates.
  `DO $$ BEGIN
     CREATE ROLE anon NOLOGIN NOINHERIT;              EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     CREATE ROLE authenticated NOLOGIN NOINHERIT;     EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     CREATE ROLE authenticator NOINHERIT;             EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     CREATE ROLE supabase_admin SUPERUSER;            EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     CREATE ROLE postgres SUPERUSER;                  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     CREATE ROLE pg_cron NOLOGIN;                     EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

  // Schemas.
  `CREATE SCHEMA IF NOT EXISTS auth`,
  `CREATE SCHEMA IF NOT EXISTS extensions`,
  `CREATE SCHEMA IF NOT EXISTS graphql_public`,
  `CREATE SCHEMA IF NOT EXISTS supabase_functions`,
  `CREATE SCHEMA IF NOT EXISTS cron`,
  `CREATE SCHEMA IF NOT EXISTS net`,
  `CREATE SCHEMA IF NOT EXISTS vault`,

  // auth helpers every RLS policy in this repo calls.
  `CREATE TABLE IF NOT EXISTS auth.users (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     email text, raw_user_meta_data jsonb, created_at timestamptz DEFAULT now())`,
  `CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid AS $fn$ SELECT NULL::uuid $fn$ LANGUAGE sql STABLE`,
  `CREATE OR REPLACE FUNCTION auth.role() RETURNS text AS $fn$ SELECT NULL::text $fn$ LANGUAGE sql STABLE`,
  `CREATE OR REPLACE FUNCTION auth.jwt()  RETURNS jsonb AS $fn$ SELECT NULL::jsonb $fn$ LANGUAGE sql STABLE`,
  `CREATE OR REPLACE FUNCTION auth.email() RETURNS text AS $fn$ SELECT NULL::text $fn$ LANGUAGE sql STABLE`,

  // pg_cron. Stubbed, not installed: PGlite has no pg_cron, and a missing extension would
  // mask the question being asked.
  `CREATE TABLE IF NOT EXISTS cron.job (
     jobid bigserial PRIMARY KEY, schedule text, command text, nodename text, nodeport int,
     database text, username text, active boolean DEFAULT true, jobname text)`,
  `CREATE OR REPLACE FUNCTION cron.schedule(text, text, text) RETURNS bigint
     AS $fn$ INSERT INTO cron.job(jobname, schedule, command) VALUES ($1,$2,$3) RETURNING jobid $fn$ LANGUAGE sql`,
  `CREATE OR REPLACE FUNCTION cron.unschedule(text) RETURNS boolean
     AS $fn$ DELETE FROM cron.job WHERE jobname = $1; SELECT true $fn$ LANGUAGE sql`,
  `CREATE OR REPLACE FUNCTION cron.unschedule(bigint) RETURNS boolean
     AS $fn$ DELETE FROM cron.job WHERE jobid = $1; SELECT true $fn$ LANGUAGE sql`,
  `CREATE OR REPLACE FUNCTION cron.alter_job(bigint, text, text, text, text, boolean) RETURNS void
     AS $fn$ SELECT NULL::void $fn$ LANGUAGE sql`,
  `CREATE OR REPLACE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL,
     database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL) RETURNS void
     AS $fn$ SELECT NULL::void $fn$ LANGUAGE sql`,

  // pg_net.
  `CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb,
     params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{}'::jsonb,
     timeout_milliseconds int DEFAULT 5000) RETURNS bigint AS $fn$ SELECT 1::bigint $fn$ LANGUAGE sql`,
  `CREATE OR REPLACE FUNCTION net.http_get(url text, params jsonb DEFAULT '{}'::jsonb,
     headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds int DEFAULT 5000)
     RETURNS bigint AS $fn$ SELECT 1::bigint $fn$ LANGUAGE sql`,

  // Supabase's default privileges on public. Without these, every grant-related migration
  // tests nothing, because the grant it revokes was never there.
  `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role`,
  `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role`,
  `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role`,
  `GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role`,
]
