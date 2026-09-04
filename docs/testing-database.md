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

## Deleting what a test created

Use `deleteTestOrganisations` (or `deleteTestOrganisation` for a single id) from
`src/test-utils/delete-test-organisations.ts`. It is the only sanctioned way to
remove an organisation a test created. Do not hand-write a delete.

    import { deleteTestOrganisations } from '@/test-utils/delete-test-organisations'

    afterAll(async () => {
      await deleteTestOrganisations(supabase, [orgId, otherOrgId], 'my-file.test.ts')
    })

Null and undefined ids are ignored, so a `beforeAll` that threw partway can pass
its variables straight in without guarding each one.

### Why it exists

On 2026-09-04 the test project held 730 organisations, having been emptied to 1
that morning. Every run of the suite added roughly 15 more.

Ten cleanup blocks across ten files deleted organisations, all written like this:

    await supabase.from('organisations').delete().eq('id', testOrgId)

PostgREST answers that with **HTTP 409 and a populated `.error`** when a foreign
key blocks the delete. The bare `await` discarded it. The suite reported green
while the rows were still there, so the leak had no symptom until someone counted
the table. `monitor-acknowledge.test.ts` printed `Tests 6 passed (6)` on the same
run that leaked two organisations.

Only two of the ten were actually failing. The other eight passed **by luck**:
they happened not to create a row in a child table whose key blocks the delete.
`org-archiving-integration.test.ts` was one extra signal row away from joining
them. All ten route through the helper now, because luck is not a fix.

### What the helper guarantees

The defect had two halves, and fixing either alone leaves it reachable:

1. the delete could not succeed — a foreign key blocked it
2. the failure could not be seen — the result was never checked

The helper does both, so a caller cannot take one without the other. It also
**reads the organisations back** afterwards, because a delete that matches no
rows returns no error, and "no error" is not the same as "gone".

### The order, and why it is not obvious

Four keys block a delete of `organisations` directly (NO ACTION):
`reply_handling_actions`, `agent_runs`, `sourcing_runs`, `enrichment_runs`.
Emptying those four is not enough, because three of them are themselves pinned:
`prospects` pins `sourcing_runs` (RESTRICT), `sourcing_runs` and
`prospect_research_results` both pin `agent_runs`, and `reply_drafts` and
`reply_handling_actions` both pin `prospects`. Everything else reachable from an
organisation is CASCADE or SET NULL and needs no help.

That is why this belongs in one helper. No individual test author derived it, and
the two files that got it right did so by hand, for their own case only.

### Why not ON DELETE CASCADE

All four blocking tables are history and attribution. Cascading them is a
**production** schema change that would make deleting an organisation silently
erase its spend and attribution history, to solve a problem that only exists in
tests. Production archives organisations via `archived_at` and does not
hard-delete them, so the cascade would buy nothing there and cost the audit
trail. Decision taken with Doug, 2026-09-04.

### If the list goes stale

It is maintained by hand, which is the shape that drifts, but it does not need a
registry test: the check runs at runtime on every cleanup. A new NO ACTION key
added tomorrow makes the final delete fail with 23503, the helper throws naming
the exact constraint and table, and the suite goes red on the next run. Verified
by deleting `reply_handling_actions` from the list (10 tests red) and `agent_runs`
(the file red), 2026-09-04.
