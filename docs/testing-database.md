# The test database

## What this does

Eight test files talk to a real Postgres database instead of a mock. They create
organisations, campaigns, prospects, signals and monitor events, run the code under
test against them, and delete them afterwards. They need a real database because
what they are testing is the database itself: row level security, a trigger, a
uniqueness constraint, a view. A mock cannot prove any of that, because a mock
would be us asserting that our own idea of the rule matches our own idea of the rule.

They now run against a **dedicated test project**, never production.

## Why this exists

Until 2026-08-27 those files read `NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`, and they ran with a service-role key, which bypasses
row level security completely. Whatever database those two variables named was
fully writable by the test suite.

On this machine they named production.

The result was eight organisations sitting in the live database called
"Archived Test Active" and "Archived Test Archived", plus "Test Org A (DRY RUN)",
"Test Org B (DRY RUN)", "Write Test Org B" and "Compliance Test Org". They were
deleted on 2026-08-27. The test that created most of them is
`monitor-acknowledge.test.ts`, and the slug timestamps in the deleted rows decode
to their own creation times to the second, which is how the link was proved rather
than guessed.

They accumulated because cleanup only runs when a test COMPLETES. An interrupted
run strands whatever it had already inserted.

## What you need to set

Create `.env.test.local` in the project root. **It is gitignored, and this
repository is public. Never commit it, and never paste its contents into a commit
message, an issue, or a chat.**

```
TEST_SUPABASE_URL=https://tidqheqjzvwmrrrebzir.supabase.co
TEST_SUPABASE_SERVICE_ROLE_KEY=<the service_role key for that project>
```

To get the key: Supabase dashboard → project **margenticos-baseline-restore-test**
→ Project Settings → API Keys → `service_role`. It is the secret one, not the
`anon` / publishable one. The tests need `service_role` because they must bypass
RLS to set up and tear down fixtures.

Nothing else needs setting.

An earlier version of this file claimed `NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` "are deliberately NOT used by tests any more". **That
was wrong**, and the correction matters. Three production modules build their own
service-role client internally rather than accepting one, so that a caller cannot
hand them a session client by mistake:

- `getClientVisibleReplies` and `getOperatorRepliesForOrg`
- `getClientVisibleCampaignMetrics`

All three read those two variable names and throw when the key is missing. The two
test files that exercise them therefore call
`bridgeEnvForSelfClientingModules()`, which re-populates those names **pointed at
the test project**, after the allowlist has already refused anything else. So the
names are still used; the values are never production's.

## Running them

```
npx dotenv -e .env.test.local -- npx vitest run
```

A plain `npx vitest run` still works and still passes ~1,840 tests. The eight
database files fail with a message telling you which variable is missing. That is
the intended behaviour: they fail loudly rather than falling back to whatever
database happens to be configured, because a silent fallback is what caused this
whole problem.

## The two controls, and why there are two

**1. The environment is poisoned, not emptied.** `vitest.setup.ts` runs before
every test file and OVERWRITES `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` with an unusable
`.invalid` sentinel. So even `npx dotenv -e .env.local -- npx vitest run`, the
command the old test files documented in their own headers and the actual
historical cause, cannot reach production.

**It deliberately does not `delete` them, and that distinction is the whole
control.** Two test files call `dotenv.config({ path: '.env.local' })` at module
scope, and module scope executes on every collection regardless of the
`describe.runIf` gate above their suites. `dotenv.config()` without
`override: true` does not overwrite a variable that is set, but it DOES fill one
that is absent. Deleting the four names makes them absent, so dotenv puts them
straight back with production values. The first version of this file did delete
them, and therefore handed back exactly what it was written to remove. Assigning
a value keeps the keys present, so dotenv leaves them alone.

There is a test for this, `poisoning, not deleting, is what blocks a dotenv
refill`, which asserts both halves: dotenv skips a set variable and fills a
deleted one. If someone simplifies the setup back to `delete`, that test goes red
and explains why.

**2. The URL is checked.** `src/test-utils/test-database.ts` validates at the
moment a client is constructed. It is an **allowlist**, not a denylist: the only
permitted databases are the test project ref and a local stack on localhost.
Production is refused by name with a loud message; an unknown ref is refused too.

A denylist would be the weaker control and would fail in the expensive direction.
A second production project, a restored clone, or a typo'd ref would all pass a
denylist, because none of them is the one string being denied.

The two controls are different in kind on purpose. The first removes the value;
the second checks it. A check can be skipped by not calling it. A variable that
is not there cannot be read by anybody.

**3. A structural test.** `src/test-utils/__tests__/production-isolation.test.ts`
scans every test file and fails if any of them reads the production variables.
The eight files were fixed by hand; nothing stops a ninth being written the same
way by copying an old one, which is exactly how the pattern spread. That test
distinguishes reads from writes, because a dozen mocked unit tests legitimately
ASSIGN fake values to those names, and a guard that reports twelve false
positives gets its allowlist stuffed until it protects nothing.

## Seed data

The test project was restored from `supabase/baseline/schema.sql`, which captures
**schema only**. Reference data that the migrations insert is therefore absent.

- `monitor_checks` — **needed, and seeded on 2026-08-27** (23 rows).
  `monitor_events.check_code` is a foreign key to it, and
  `monitor-acknowledge.test.ts` inserts an event with `check_code = 'MON-001'`.
  Without the seed that test fails on a foreign key violation that looks like a
  code bug and is not one.
- `integrations_registry` — **empty, and not currently needed.** Production has 15
  rows. No test in the eight loads the registry: the compliance tests stop at the
  pre-upload gates and never reach dispatch. If a future test exercises a
  capability handler, this will need seeding too, and the symptom will be
  `registry-cache: integrations_registry is empty — no capabilities are active`.

Everything else the eight files need, they create themselves: organisations,
campaigns, prospects, signals, documents, FAQs, and even auth users
(`auth.admin.createUser`).

## If the project is paused

Supabase free projects pause after a week of inactivity, and a paused project
refuses connections, which surfaces as a confusing timeout rather than a clear
error. Unpause from the dashboard. As of 2026-08-27 it is `ACTIVE_HEALTHY`.

## The one remaining way to reach production

`ALLOW_PRODUCTION_DB_ACCESS=i-understand-this-can-write-to-production` disables
the environment stripping. It exists for two opt-in, read-only diagnostics that
legitimately report on live data:

- `eligibility-against-live-data.test.ts` (`RUN_ELIGIBILITY_REPORT=1`) — SELECTs
  prospects and prints a split. Writes nothing.
- `cache-receipt.test.ts` (`RUN_CACHE_PROBE=1`) — calls Anthropic, touches no
  database.

Both also call `dotenv.config()` themselves at module scope, which is why the
value has to be reachable at all. The override prints a warning when used. If you
see that warning during an ordinary run, something is wrong.

This is a deliberate hole and it is the weakest point in the design. Closing it
means giving those two diagnostics their own runner outside vitest. Logged in
BACKLOG.
