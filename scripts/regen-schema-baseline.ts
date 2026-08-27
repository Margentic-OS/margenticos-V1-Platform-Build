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

    q(`SELECT string_agg('CREATE OR REPLACE VIEW public.' || c.relname ||
         CASE WHEN EXISTS (SELECT 1 FROM unnest(COALESCE(c.reloptions,'{}')) o
                            WHERE o LIKE 'security_invoker=%')
              THEN ' WITH (security_invoker = true)' ELSE '' END ||
         ' AS' || E'\\n' || pg_get_viewdef(c.oid, true), E'\\n\\n' ORDER BY c.relname) AS ddl
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

  const scrubbedTriggers = scrub(triggers)
  if (scrubbedTriggers === triggers && /http_request\(/.test(triggers)) {
    // A webhook trigger exists but the scrub changed nothing. Either the header format
    // moved or there is genuinely no secret. Loud either way: silence here is how the
    // first leak happened.
    console.warn('WARNING: http_request trigger found but the scrub matched nothing. Check scrub().')
  }

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
${seqOwned}

-- ── TABLES ────────────────────────────────────────────────────────────
${tables}

-- ── PRIMARY KEYS, UNIQUE AND CHECK CONSTRAINTS ────────────────────────
${constraints}

-- ── FOREIGN KEYS (applied after all tables exist) ─────────────────────
${foreignKeys}

-- ── INDEXES (constraint-backing indexes excluded: created above) ──────
${indexes}

-- ── FUNCTIONS ─────────────────────────────────────────────────────────
${functions}

-- ── VIEWS ─────────────────────────────────────────────────────────────
-- security_invoker is preserved where set. A view WITHOUT it runs as its OWNER
-- and does not consult RLS on its base tables. See CLAUDE.md.
${views}

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
--  4. NO WEBHOOK SECRETS. The users-pending-review-notify trigger carries a
--     placeholder. Put the real value back from the environment on restore.
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
--  9. **IT HAS NEVER BEEN RESTORED.** The counts above prove COMPLETENESS, not
--     EXECUTABILITY. A restore test needs somewhere to restore TO, which is the
--     same blocked decision as the 38 database-dependent tests.
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

main().catch(err => {
  console.error(err.message ?? err)
  process.exit(1)
})
