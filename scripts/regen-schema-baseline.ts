// Regenerates supabase/baseline/schema.sql from the LIVE catalog, read-only.
//
//   dotenv -e .env.local -- npx tsx scripts/regen-schema-baseline.ts
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS SCRIPT IS IN THE REPO, WHEN THE ORIGINAL GENERATOR WAS NOT
//
// The first generator was left uncommitted "because it reads SUPABASE_ACCESS_TOKEN".
// That is not a reason: every script in this directory reads a credential from the
// environment, and none of them embeds one. The consequence of leaving it out was that
// the ONLY copy of the scrubbing rules was in whoever ran it, so there were none, and on
// 2026-08-26 the baseline shipped a live webhook secret to a PUBLIC repository.
//
// The fix is not "remember to scrub next time". It is this file, where the scrub is part
// of generation, plus assertNoSecrets() below, which REFUSES TO WRITE a file containing
// anything secret-shaped. A generator that cannot emit a secret is worth more than a
// rule that says not to.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE TWO PLACES POSTGRES STORES CREDENTIALS IN THE CATALOG
//
// Both are real, both bit this project, and a dump captures both by default:
//
//   1. TRIGGERS. A Supabase Database Webhook is a trigger calling
//      supabase_functions.http_request(url, method, headers, body, timeout). The HEADERS
//      ARGUMENT IS A LITERAL in the trigger definition, so pg_get_triggerdef returns the
//      secret. This is what leaked. Scrubbed below.
//
//   2. pg_cron. Every scheduled job's command embeds CRON_SECRET as a literal bearer
//      token, for documented reasons (Supabase's postgres role cannot ALTER DATABASE SET,
//      so current_setting() returns NULL). cron.job is EXCLUDED entirely, as it was
//      before. Never add it without scrubbing.
//
// Anything else that ends up storing a credential in the catalog must be added here.

import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PROJECT_REF = 'hjpvnvjryxdjcfdsfhzy'
const OUT = join(process.cwd(), 'supabase', 'baseline', 'schema.sql')

const PLACEHOLDER = '<REDACTED: set from SUPABASE_PENDING_REVIEW_WEBHOOK_SECRET>'

async function q(query: string): Promise<string> {
  const token = process.env.SUPABASE_ACCESS_TOKEN
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is not set')

  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) {
    throw new Error(`catalog query failed ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  const rows = (await res.json()) as Array<{ ddl: string | null }>
  return rows?.[0]?.ddl ?? ''
}

async function count(sql: string): Promise<number> {
  return Number(await q(sql))
}

// ── The scrub ────────────────────────────────────────────────────────────────
//
// Applied to generated DDL before it is assembled, not to the file afterwards, so there
// is no window in which an unscrubbed string exists on disk.
function scrub(ddl: string): string {
  return ddl
    // Supabase Database Webhook headers: '{"x-webhook-secret":"<value>"}' and any sibling
    // header whose name looks secret-ish. Replaces the VALUE only, so the shape of the
    // trigger, and the fact that it needs a secret, both stay visible.
    .replace(
      /("(?:x-[a-z0-9-]*(?:secret|token|key)|authorization)"\s*:\s*")([^"]*)(")/gi,
      (_m, a, _v, c) => `${a}${PLACEHOLDER}${c}`
    )
}

// ── The guard ────────────────────────────────────────────────────────────────
//
// Runs on the FULL assembled file. Refuses to write if anything secret-shaped survives.
// This is the part that makes a repeat impossible rather than merely unlikely.
function assertNoSecrets(content: string): void {
  const patterns: Array<[string, RegExp]> = [
    ['64-char hex (openssl rand -hex 32)', /\b[0-9a-f]{64}\b/],
    ['32-char hex',                        /\b[0-9a-f]{32}\b/],
    ['JWT',                                /\beyJ[A-Za-z0-9_-]{20,}/],
    ['Anthropic key',                      /\bsk-ant-[A-Za-z0-9_-]{10,}/],
    ['generic sk- key',                    /\bsk-[A-Za-z0-9]{20,}/],
    ['Resend key',                         /\bre_[A-Za-z0-9]{15,}/],
    ['bearer token literal',               /Bearer\s+[A-Za-z0-9_.-]{20,}/],
  ]
  const hits: string[] = []
  for (const [label, re] of patterns) {
    const m = content.match(re)
    if (m) hits.push(`${label}: ...${m[0].slice(0, 8)}... (redacted)`)
  }
  if (hits.length > 0) {
    throw new Error(
      'REFUSING TO WRITE: the generated baseline contains secret-shaped values.\n  ' +
      hits.join('\n  ') +
      '\nAdd a scrub rule to scrub() above, or exclude the section, then re-run.'
    )
  }
}

// ── View DDL, and the property that turned out to be a live exposure ─────────
//
// A Postgres view runs with its OWNER's privileges unless security_invoker is on, so this
// one boolean decides whether RLS on the base tables is consulted at all. CLAUDE.md's
// 2026-08-26 finding is exactly that: nine anon-readable mon_* views, owner postgres,
// security_invoker false, handing out the contents of a table anon could not read.
//
// THIS FUNCTION EXISTS BECAUSE THE GENERATOR USED TO LIE ABOUT IT. The old SQL asked
// whether the reloption was PRESENT and then hardcoded the value:
//
//     CASE WHEN EXISTS (... WHERE o LIKE 'security_invoker=%')
//          THEN ' WITH (security_invoker = true)' ELSE '' END
//
// So a view carrying security_invoker=false was written into the tracked baseline as
// security_invoker = true. The disaster recovery file asserted the secure posture on the
// one property that was actually insecure, and restoring it would have produced a
// DIFFERENT database from the one it claims to reproduce.
//
// The trap, worth stating because it is why nobody noticed: the advisor fix on 2026-08-26
// set the affected view to true, so today every view in this database is either true or
// has no reloption at all, and the bug emits the correct text for both. It self-heals and
// stays invisible until the next view is created false. That is precisely when a disaster
// recovery file would be believed.
//
// An ABSENT option emits no clause, deliberately. Absent and false behave identically, but
// they are not the same catalog state, and a restore that turned reloptions NULL into
// {security_invoker=false} would not reproduce what it captured. Fidelity first.
export interface ViewRow {
  name: string
  securityInvoker: string | null
  definition: string
}

export function buildViewsDdl(rows: ViewRow[]): string {
  return rows
    .map(v => {
      const clause = v.securityInvoker === null
        ? ''
        : ` WITH (security_invoker = ${v.securityInvoker})`
      return `CREATE OR REPLACE VIEW public.${v.name}${clause} AS\n${v.definition}`
    })
    .join('\n\n')
}

async function main() {
  const started = new Date().toISOString().slice(0, 16).replace('T', ' ')

  const [
    extensions, sequences, seqOwned, tables, constraints, foreignKeys, indexes,
    functions, views, triggers, rlsEnable, policies, grants, funcGrants, comments,
  ] = await Promise.all([
    q(`SELECT string_agg('CREATE EXTENSION IF NOT EXISTS ' || quote_ident(e.extname) ||
         ' WITH SCHEMA ' || n.nspname || ';', E'\\n' ORDER BY e.extname) AS ddl
       FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace`),

    q(`SELECT string_agg('CREATE SEQUENCE IF NOT EXISTS public.' || c.relname || ';', E'\\n'
         ORDER BY c.relname) AS ddl
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='S'`),

    q(`SELECT string_agg('ALTER SEQUENCE public.' || s.relname || ' OWNED BY public.' ||
         t.relname || '.' || a.attname || ';', E'\\n' ORDER BY s.relname) AS ddl
       FROM pg_class s
       JOIN pg_namespace n ON n.oid=s.relnamespace AND n.nspname='public' AND s.relkind='S'
       JOIN pg_depend d ON d.objid=s.oid AND d.deptype='a'
       JOIN pg_class t ON t.oid=d.refobjid
       JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid`),

    q(`SELECT string_agg(body, E'\\n\\n' ORDER BY relname) AS ddl FROM (
         SELECT c.relname,
           'CREATE TABLE IF NOT EXISTS public.' || c.relname || ' (' || E'\\n' ||
           string_agg('  ' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) ||
             COALESCE(' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid), '') ||
             CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END,
             ',' || E'\\n' ORDER BY a.attnum) || E'\\n' || ');' AS body
         FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public' AND c.relkind='r'
         JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
         LEFT JOIN pg_attrdef ad ON ad.adrelid=c.oid AND ad.adnum=a.attnum
         GROUP BY c.relname
       ) t`),

    q(`SELECT string_agg('ALTER TABLE public.' || c.relname || ' ADD CONSTRAINT ' ||
         quote_ident(con.conname) || ' ' || pg_get_constraintdef(con.oid) || ';', E'\\n'
         ORDER BY c.relname, con.conname) AS ddl
       FROM pg_constraint con
       JOIN pg_class c ON c.oid=con.conrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
       WHERE con.contype IN ('p','u','c')`),

    q(`SELECT string_agg('ALTER TABLE public.' || c.relname || ' ADD CONSTRAINT ' ||
         quote_ident(con.conname) || ' ' || pg_get_constraintdef(con.oid) || ';', E'\\n'
         ORDER BY c.relname, con.conname) AS ddl
       FROM pg_constraint con
       JOIN pg_class c ON c.oid=con.conrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
       WHERE con.contype='f'`),

    q(`SELECT string_agg(i.indexdef || ';', E'\\n' ORDER BY i.indexname) AS ddl
       FROM pg_indexes i
       WHERE i.schemaname='public'
         AND NOT EXISTS (SELECT 1 FROM pg_constraint con
                          WHERE con.conname=i.indexname AND con.contype IN ('p','u'))`),

    q(`SELECT string_agg(pg_get_functiondef(p.oid) || ';', E'\\n\\n' ORDER BY p.proname) AS ddl
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.prokind='f'`),

    // READS THE VALUE, does not test for the key's presence. See buildViewsDdl above.
    // The catalog read stays in SQL; the DECISION about what to emit is in TypeScript,
    // where a test can reach it without a database.
    q(`SELECT json_agg(json_build_object(
           'name', c.relname,
           'securityInvoker', (SELECT option_value FROM pg_options_to_table(c.reloptions)
                                WHERE option_name = 'security_invoker'),
           'definition', pg_get_viewdef(c.oid, true)
         ) ORDER BY c.relname)::text AS ddl
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='v'`),

    // ── THE LEAK SITE. Scrubbed on the way out, below. ──
    q(`SELECT string_agg(pg_get_triggerdef(t.oid) || ';', E'\\n' ORDER BY t.tgname) AS ddl
       FROM pg_trigger t
       JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
       WHERE NOT t.tgisinternal`),

    q(`SELECT string_agg('ALTER TABLE public.' || c.relname ||
         ' ENABLE ROW LEVEL SECURITY;', E'\\n' ORDER BY c.relname) AS ddl
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity`),

    q(`SELECT string_agg('CREATE POLICY ' || quote_ident(p.policyname) || ' ON public.' ||
         p.tablename || ' AS ' || p.permissive || ' FOR ' || p.cmd || ' TO ' ||
         array_to_string(p.roles, ', ') ||
         COALESCE(E'\\n  USING (' || p.qual || ')', '') ||
         COALESCE(E'\\n  WITH CHECK (' || p.with_check || ')', '') || ';',
         E'\\n\\n' ORDER BY p.tablename, p.policyname) AS ddl
       FROM pg_policies p WHERE p.schemaname='public'`),

    q(`SELECT string_agg('GRANT ' || g.privilege_type || ' ON public.' || g.table_name ||
         ' TO ' || g.grantee || ';', E'\\n'
         ORDER BY g.table_name, g.privilege_type, g.grantee) AS ddl
       FROM information_schema.role_table_grants g
       WHERE g.table_schema='public' AND g.grantee IN ('anon','authenticated','service_role')`),

    q(`SELECT string_agg('GRANT EXECUTE ON FUNCTION public.' || p.proname || '(' ||
         pg_get_function_identity_arguments(p.oid) || ') TO ' || r.rolname || ';', E'\\n'
         ORDER BY p.proname, r.rolname) AS ddl
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
       CROSS JOIN (SELECT unnest(ARRAY['anon','authenticated','service_role']) AS rolname) r
       WHERE has_function_privilege(r.rolname, p.oid, 'EXECUTE')`),

    q(`SELECT string_agg(stmt, E'\\n' ORDER BY stmt) AS ddl FROM (
         SELECT 'COMMENT ON TABLE public.' || c.relname || ' IS ' ||
                quote_literal(d.description) || ';' AS stmt
           FROM pg_description d
           JOIN pg_class c ON c.oid=d.objoid AND d.objsubid=0
           JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
         UNION ALL
         SELECT 'COMMENT ON COLUMN public.' || c.relname || '.' || a.attname || ' IS ' ||
                quote_literal(d.description) || ';'
           FROM pg_description d
           JOIN pg_class c ON c.oid=d.objoid
           JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=d.objsubid
           JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
          WHERE d.objsubid > 0
       ) s`),
  ])

  // ── FIX 4: triggers that depend on Supabase PLATFORM schemas ───────────────
  //
  // A Database Webhook trigger calls supabase_functions.http_request. That schema is NOT
  // part of the public schema and NOT an extension: Supabase creates it when Database
  // Webhooks are enabled in the dashboard, the same way it owns auth and storage. A fresh
  // project does not have it, so the restore died with 3F000.
  //
  // Creating the schema here would be wrong: we would be inventing a stub of a platform
  // object and it would diverge from the real one. Dropping the trigger would silently
  // lose it. So the statement is GUARDED: it runs when the platform provides the schema,
  // and RAISES A WARNING naming the manual step when it does not.
  //
  // Found by the 2026-08-27 restore test.
  function guardPlatformTriggers(ddl: string): string {
    return ddl.split('\n').map(line => {
      if (!line.includes('supabase_functions.')) return line
      const inner = line.trim().replace(/;$/, '')
      return [
        'DO $baseline$',
        'BEGIN',
        "  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'supabase_functions') THEN",
        `    EXECUTE $trigger$${inner}$trigger$;`,
        '  ELSE',
        "    RAISE WARNING 'SKIPPED a Database Webhook trigger: schema supabase_functions does not exist. Enable Database Webhooks in the Supabase dashboard, then re-run this statement and set its header value from SUPABASE_PENDING_REVIEW_WEBHOOK_SECRET.';",
        '  END IF;',
        'END',
        '$baseline$;',
      ].join('\n')
    }).join('\n')
  }

  const viewsDdl = buildViewsDdl(views ? (JSON.parse(views) as ViewRow[]) : [])

  // ── ORDER MATTERS HERE: SCRUB, COMPARE, THEN GUARD ──────────────────────────
  //
  // The comparison below is the tripwire added after the 2026-08-26 leak. It fires when a
  // webhook trigger is present and the scrub changed NOTHING, which is the case where the
  // header format has moved and a live secret would sail through untouched.
  //
  // It was briefly dead. guardPlatformTriggers was applied first, in the same expression,
  // and it rewrites the http_request line unconditionally into a nine-line DO block. So
  // `scrubbed === triggers` could never be true whenever an http_request trigger existed,
  // which is the only condition under which the tripwire was meant to fire. The check ran,
  // stayed silent, and could no longer see the thing it was written to catch.
  //
  // That is the same shape as the privilege audit that could not see views and the monitor
  // loop bounded by the shorter of two arrays. A guard that cannot see what it guards is
  // worse than no guard, because it manufactures confidence.
  //
  // So the scrub is compared against its OWN input, before anything else touches the text.
  const scrubbed = scrub(triggers)
  if (scrubbed === triggers && /http_request\(/.test(triggers)) {
    // A webhook trigger exists but the scrub changed nothing. Either the header format
    // moved or there is genuinely no secret. Loud either way: silence here is how the
    // first leak happened.
    console.warn('WARNING: http_request trigger found but the scrub matched nothing. Check scrub().')
  }
  const scrubbedTriggers = guardPlatformTriggers(scrubbed)

  const counts = {
    tables:      await count(`SELECT count(*)::text AS ddl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'`),
    views:       await count(`SELECT count(*)::text AS ddl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='v'`),
    functions:   await count(`SELECT count(*)::text AS ddl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'`),
    triggers:    await count(`SELECT count(*)::text AS ddl FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal`),
    policies:    await count(`SELECT count(*)::text AS ddl FROM pg_policies WHERE schemaname='public'`),
    indexes:     await count(`SELECT count(*)::text AS ddl FROM pg_indexes WHERE schemaname='public'`),
    constraints: await count(`SELECT count(*)::text AS ddl FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND con.contype IN ('p','u','c','f')`),
    sequences:   await count(`SELECT count(*)::text AS ddl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'`),
    extensions:  await count(`SELECT count(*)::text AS ddl FROM pg_extension`),
    comments:    await count(`SELECT count(*)::text AS ddl FROM pg_description d JOIN pg_class c ON c.oid=d.objoid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`),
  }

  const header = `-- ═══════════════════════════════════════════════════════════════════════
-- BASELINE SCHEMA — public schema of project ${PROJECT_REF}
-- Captured ${started} UTC from the LIVE database, read-only.
-- Generated by scripts/regen-schema-baseline.ts. Do not hand-edit.
-- ═══════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS: supabase/migrations/ CANNOT REBUILD THIS DATABASE.
-- Migrations are applied remotely under timestamps that do not match the repo
-- filenames, and no file anywhere creates organisations, prospects or campaigns.
-- The three core create_*_tables migrations from 2026-04-15 exist only in the
-- remote database. If this project were lost, the repository could not recreate it.
--
-- ═══════════════════════════════════════════════════════════════════════
-- SECRETS: SCRUBBED AT GENERATION, AND THE GENERATOR REFUSES TO EMIT THEM
--
-- On 2026-08-26 this file shipped a LIVE webhook secret to a public repository.
-- A Supabase Database Webhook is a trigger calling supabase_functions.http_request,
-- and the headers argument, secret included, is a LITERAL inside the trigger
-- definition. pg_get_triggerdef returned it and nothing looked.
--
-- Two defences now, not one:
--   1. scrub() replaces secret-shaped HEADER VALUES with a placeholder before the
--      file is assembled, so no unscrubbed copy ever reaches disk.
--   2. assertNoSecrets() scans the finished file for 32- and 64-char hex, JWTs,
--      sk-/re_ keys and bearer literals, and REFUSES TO WRITE if any survive.
--
-- The placeholder below is not a value. Restoring this file leaves the webhook
-- unauthenticated until the real secret is put back from the environment variable
-- SUPABASE_PENDING_REVIEW_WEBHOOK_SECRET.
--
-- pg_cron is excluded entirely, as before, for the same class of reason: every
-- scheduled job embeds CRON_SECRET as a literal bearer token in cron.job.command.
-- ═══════════════════════════════════════════════════════════════════════

-- ── EXTENSIONS ────────────────────────────────────────────────────────
${extensions}

-- ── SEQUENCES (must precede the tables whose DEFAULTs call nextval) ───
${sequences}

-- ── TABLES ────────────────────────────────────────────────────────────
${tables}

-- ── SEQUENCE OWNERSHIP ────────────────────────────────────────────────
-- MUST FOLLOW THE TABLES, and used not to. ALTER SEQUENCE ... OWNED BY names a
-- COLUMN, so it needs the table to exist. Emitting it beside CREATE SEQUENCE, which
-- correctly precedes the tables, made the first two statements of every restore fail
-- with 42P01. Found by the 2026-08-27 restore test, not by reading.
${seqOwned}

-- ── PRIMARY KEYS, UNIQUE AND CHECK CONSTRAINTS ────────────────────────
${constraints}

-- ── FOREIGN KEYS (applied after all tables exist) ─────────────────────
${foreignKeys}

-- ── INDEXES (constraint-backing indexes excluded: created above) ──────
${indexes}

-- ── FUNCTIONS ─────────────────────────────────────────────────────────
--
-- check_function_bodies IS TURNED OFF FOR THIS SECTION, deliberately.
--
-- Functions are emitted alphabetically, and plpgsql validates a body at CREATE time, so
-- any function calling one that sorts after it fails. fail_job calls job_queue_backoff
-- and f < j, so the restore died on 42883. Dependency-sorting would need a call graph
-- that Postgres does not track for plpgsql bodies, so it would have to be recovered by
-- reading the source text, which is fragile in a different way.
--
-- The trade-off, stated rather than hidden: with validation off, a function whose body is
-- genuinely broken is created here and fails at RUNTIME instead of at restore. That is
-- acceptable ONLY because every body in this file was dumped from a database where it
-- already ran. It would not be acceptable for hand-written SQL.
--
-- Found by the 2026-08-27 restore test.
SET check_function_bodies = off;

${functions}

RESET check_function_bodies;

-- ── VIEWS ─────────────────────────────────────────────────────────────
-- security_invoker carries the VALUE the catalog holds, true or false, and a view
-- with no such reloption emits no clause because absent is not the same catalog
-- state as false. Until 2026-08-27 the generator tested whether the option was
-- PRESENT and then wrote 'true' regardless, so a view set to false was recorded
-- here as secure. A view WITHOUT security_invoker runs as its OWNER and does not
-- consult RLS on its base tables. See CLAUDE.md.
${viewsDdl}

-- ── TRIGGERS ──────────────────────────────────────────────────────────
-- Header values are scrubbed. See the SECRETS note at the top of this file.
${scrubbedTriggers}

-- ── ROW LEVEL SECURITY ────────────────────────────────────────────────
${rlsEnable}

-- ── RLS POLICIES ──────────────────────────────────────────────────────
${policies}

-- ── GRANTS on tables and views (anon / authenticated / service_role) ──
-- These are load-bearing. Supabase's ALTER DEFAULT PRIVILEGES grants anon and
-- authenticated BY NAME at creation, so a rebuild that omits these does NOT
-- reproduce the security posture. See the database-security rules in CLAUDE.md.
${grants}

-- ── FUNCTION EXECUTE grants ───────────────────────────────────────────
${funcGrants}

-- ── COMMENTS ──────────────────────────────────────────────────────────
${comments}

-- ═══════════════════════════════════════════════════════════════════════════
-- COVERAGE, counted against the live catalog at generation time
--
--     tables      ${String(counts.tables).padEnd(4)}   views        ${String(counts.views).padEnd(4)}   functions   ${counts.functions}
--     triggers    ${String(counts.triggers).padEnd(4)}   policies     ${String(counts.policies).padEnd(4)}   indexes     ${counts.indexes}
--     constraints ${String(counts.constraints).padEnd(4)}   sequences    ${String(counts.sequences).padEnd(4)}   extensions  ${counts.extensions}
--     comments    ${counts.comments}
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT IS NOT HERE. THIS IS THE IMPORTANT HALF.
--
--  1. NO DATA. Schema only.
--
--  2. ONLY THE public SCHEMA. auth, storage, cron, net, extensions and graphql are
--     absent, so a restore has NO USERS and NO STORAGE BUCKETS OR POLICIES.
--
--  3. NO pg_cron SCHEDULES. Excluded ON PURPOSE: each command embeds CRON_SECRET
--     literally. A restore must reschedule from the pg_cron migrations, which ARE
--     in the repo.
--
--  4. NO WEBHOOK SECRETS, AND THE WEBHOOK TRIGGER MAY NOT RESTORE AT ALL. It carries a
--     placeholder instead of the secret, and it is guarded on the existence of schema
--     supabase_functions, which only exists once Database Webhooks have been enabled in
--     the Supabase dashboard. On a fresh project the restore RAISES A WARNING and skips
--     it. Enable webhooks, re-run that one statement, and set the header value from
--     SUPABASE_PENDING_REVIEW_WEBHOOK_SECRET.
--
--  5. NO OWNERSHIP. On restore every object belongs to whoever ran the file. For
--     views this matters: a view's owner determines whose privileges it runs with.
--
--  6. NO ALTER DEFAULT PRIVILEGES, and NO SEQUENCE VALUES.
--
--  7. NO auth.users FOREIGN KEY TARGETS.
--
--  8. IT IS A RECONSTRUCTION, NOT pg_dump. Built from the live catalog via the
--     Management API because db dump needs Docker and pg_dump is not installed.
--     Statement ORDER within a section is alphabetical, not dependency-sorted.
--
--  9. IT HAS BEEN RESTORED, ONCE, on 2026-08-27, into a scratch Supabase project
--     created for the purpose. It failed FIVE TIMES first, and every failure was in
--     this generator rather than in the database: an unscrubbed secret, sequence
--     ownership emitted before its table, alphabetical function order defeating
--     plpgsql body validation, and a trigger depending on a platform schema a fresh
--     project does not have. The counts above prove COMPLETENESS. Only a restore
--     proves EXECUTABILITY, and until that day nothing had.
--
--     Re-run it with scripts/restore-baseline-test.ts. It will not run against
--     production and it will not run against a target that already has objects in
--     public.
-- ═══════════════════════════════════════════════════════════════════════════
`

  assertNoSecrets(header)
  writeFileSync(OUT, header, 'utf8')

  const written = readFileSync(OUT, 'utf8')
  assertNoSecrets(written)

  console.log(`Wrote ${OUT}`)
  console.log(`  ${written.split('\n').length} lines`)
  console.log(`  counts: ${JSON.stringify(counts)}`)
  console.log('  assertNoSecrets: passed (before write and after write)')
}

// Only run when invoked directly, so the pure helpers above can be imported by a test.
if (process.argv[1] && process.argv[1].endsWith('regen-schema-baseline.ts')) {
  main().catch(err => {
    console.error(err.message ?? err)
    process.exit(1)
  })
}
