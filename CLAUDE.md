# CLAUDE.md — MargenticOS
# Read this completely at the start of every session. Do not skip it.

---

## Active temporary states — read before touching infrastructure

- **Repo is currently PUBLIC on GitHub** to enable Vercel Hobby deploys.
  Acceptable at pre-revenue stage because no secrets are committed and the
  source is not the moat. MUST be flipped to PRIVATE before the first paying
  client is onboarded. This requires upgrading Vercel to Pro ($20/month)
  simultaneously, since Hobby cannot deploy private org repos.

  Trigger: First signed paying-client contract, OR first founding-client
  testimonial that references the platform by name publicly, whichever comes first.

---

## Session start ritual — read these before anything else

Every new Claude Code session must:

1. Run `git status` to check working tree state.
   If the working tree is dirty (uncommitted changes or untracked files not in .gitignore):
   - STOP. Do not proceed.
   - Ask Doug whether another session is active before doing anything.
   - One build session at a time is the standing rule to prevent merge conflicts and context loss.

2. Read, in order:
   - /CLAUDE.md (this file)
   - **The Notion Backlog, via the Notion MCP** — open work lives here, not in a file.
     MargenticOS — Company Brain -> Backlog. Read the **NOW** view first: it holds
     only what is costing something today on a live campaign, and it is deliberately
     short. Then read the gate view matching the current task: BEFORE FIRST CLIENT,
     BEFORE SCALE or LATER.
   - /docs/ADR.md (architecture decisions)
   - The relevant /prd/sections/NN-*.md file for the current task
   - For prospect research agent v2 state: see `docs/prospect-research-agent-v2-state.md`

Do not skip the Notion Backlog. It holds every open item deferred in earlier
sessions that you would otherwise forget. Missing one has cost real hours of
rework more than once.

If the Notion MCP is not configured, STOP and tell Doug before doing any build
work. Do not proceed from memory and do not fall back to `docs/BACKLOG.md` for
open work: that file is closed to new entries and its open items were migrated
to Notion on 2026-09-04, so working from it means working from a stale list.

`docs/BACKLOG.md` is the HISTORICAL RECORD and is still worth reading when you
need the reasoning behind an old decision, or when a code comment cites it by
line number. It also still holds every non-gate tag ([post-build], [phase2],
[monitor], [research], [lesson] and the rest), which were not migrated. Read it
for those. Never add to it.

---

## Who is building this

Doug is building MargenticOS while learning Claude Code. He is not a developer.
He learns by doing, by seeing results, and by understanding each step as it happens.
He uses claude.ai alongside Claude Code throughout the build — sharing screenshots,
asking questions, and sense-checking decisions.

Every response must therefore:
- Explain in plain English what was just built and why
- Never assume technical knowledge Doug has not demonstrated
- Stop and give exact step-by-step instructions when a manual action is required
  (creating an account, adding credentials, configuring a tool, installing an MCP)
- Never proceed past a blocker without flagging it clearly with a path forward
- When something breaks, explain what happened in plain English before suggesting a fix
- When a decision has long-term architectural implications, name it explicitly
  so Doug can make an informed choice rather than discover consequences later
- Never make a significant architectural decision silently

When Doug shares a screenshot or error message, interpret it fully before responding.
When something is unclear, ask one specific question rather than guessing.

---

## What this project is

MargenticOS is an agentic services platform. Doug (the operator) delivers
AI-powered pipeline generation for founder-led B2B consulting firms ($300K–$3M revenue).

Agents execute through existing tools (Instantly, Taplio, GoHighLevel, Apollo, Lemlist).
The dashboard displays results and houses client strategy documents.
Clients never touch the execution layer.

This is not a SaaS product. Do not build it like one.

The full MargenticOS vision includes referral tools, SEO, website generation, paid ads,
and nurture sequences. What is being built now is the foundation: intake, strategy
documents, agent pipeline, results dashboard, core integrations, and feedback loop.
Do not over-engineer for the full vision. Build what is specced in the current phase.
Phases are explicitly subject to change and iteration as the build progresses.

---

## The single most important architectural principle — tool agnosticism

Nothing is hardcoded to a specific vendor. Ever.

Every external tool is registered in the integrations_registry table with its
capabilities, connection status, and API handler reference.

The system declares capabilities, not tool names:
  can_send_email              → currently: Instantly
  can_schedule_linkedin_post  → currently: Taplio
  (Taplio has no public scheduling API. Model: agent generates content →
   dashboard approval → content delivered to Taplio queue via Zapier or manually.
   Never attempt programmatic API scheduling with Taplio.)
  can_send_linkedin_dm        → currently: Lemlist
  can_enrich_contact          → currently: Apollo
  can_book_meeting            → currently: Calendly
  can_validate_email          → currently: Hunter.io (phase two)

Agents and components reference capabilities only. Never tool names.
A handler function maps each capability to whichever tool is registered for it.

Swapping a tool = update the registry + write a new handler. Nothing else changes.
Adding a new tool = new registry row + new handler. Everything else is untouched.

This is what makes the system extensible without rebuilds.
It is the architectural decision that protects the entire future of the product.
Never violate it, even for a shortcut that seems harmless.

---

## Security and resilience — two layers, both always active

### Layer one — data security (Supabase enforced)

Row Level Security must be enabled on every Supabase table before any data is written.
A client must only ever read their own organisation's data.
This is enforced at the database level, not just the application level.

When creating any new table:
  1. Write RLS policies first
  2. Verify they work correctly
  3. Only then write application code that uses the table

API keys and secrets: Supabase environment variables or .env files only.
Never hardcode credentials in application code.
Never expose credentials client-side.
Verify .env is in .gitignore before the first commit of every session.

Authentication: Supabase Auth with magic link (passwordless email).
Operator routes must verify role = 'operator' on every protected request.
Not just at login — on every request to a protected route.

For every new API route, three checks before returning any data:
  1. User is authenticated
  2. User role is appropriate for this route
  3. client_id in the request matches the data being requested

### Layer two — resilience (build discipline)

Security also means the build does not break silently or unrecoverably.

Git commits protect work between steps (see Git section).
Three environments prevent production breakage from development work.
Sentry catches errors before Doug or clients notice them.
The /docs folder means context is never lost between sessions.
The /prd folder means scope decisions are recorded and recoverable.
Staged deployments mean only verified code reaches production.

These are not optional practices. They are the protection against the most
common failure modes in a complex build managed by a non-developer.

---

## Git — mandatory, explained simply

Before every significant change:
  git add .
  git commit -m "checkpoint before: [what you are about to do in plain English]"

After every significant change:
  git add .
  git commit -m "[what was done and why, in plain English]"

Always tell Doug what was just changed, why committing now protects it,
and what the next step is.

A significant change means: any new file, any new function, any database schema
change, any configuration change, any integration addition or modification.

Never make multiple significant changes without committing between them.
The last commit is the recovery point. If there is no recent commit,
recovery is painful and sometimes impossible.

---

## Git workflow

- After every commit, push to origin unless the user explicitly says otherwise
- Ensures Vercel deploys, GitHub backups, and collaborator visibility stay in sync
- Verify push success before reporting commit complete to the user
- If branch protection is bypassed (as admin), note it explicitly in the report

---

## MCP setup — prompt Doug, never assume accounts exist

This project uses MCPs (Model Context Protocol) to give Claude Code direct
access to project tools without manual copy-paste of credentials or schemas.

Required MCPs for this project:
  Supabase MCP   — reads actual database schema, verifies RLS policies,
                   catches data model errors before runtime
  Notion MCP     — the Backlog, Decisions Log and Knowledge Base. Open work
                   lives there and not in a file. See the session start ritual.

Git and GitHub are deliberately NOT an MCP here. Commits, branches, pushes and
PRs go through the Bash tool and the `gh` CLI, which is what every session has
actually used. Files go through Claude Code's native file tools, not a
Filesystem MCP.

A GitHub MCP and a Filesystem MCP were both listed as "required" here from the
start of the project and NEITHER WAS EVER CONFIGURED, in `.mcp.json.example` or
in any live config. Do not reinstate either without a concrete need and a caller.

**The 2026-09-05 finding.** A GitHub personal access token, scope `repo`, existed
solely because this list asked for a GitHub MCP that nobody built. It expired
2026-05-09 and was deleted 2026-09-05. Nothing noticed, because nothing used it:
zero references to GITHUB_TOKEN, GH_TOKEN or GITHUB_PAT anywhere in the repo, no
GitHub credential in Vercel Production or Preview, and no `.github/` workflows at
all. September pushes reached origin regardless of what git authenticates with.
**A required-tools list that names a tool nobody set up produces credentials
nobody uses**, and a standing credential with no consumer is the worst kind: when
it leaks, nothing breaks, so nothing tells you it leaked.

This is the same family as the rest of this week, a document asserting something
that was never true. The clean tree that was 280 commits stale, the audit query
that filtered `relkind = 'r'` and could not see a view, the Notion listing that
reported every row ungated. In each the file said one thing, the world was
another, and the check that should have noticed was itself the broken part.
**A tool earns a place on a required list once it is configured and something
calls it, never before.**

Doug has not set up MCPs before. When an MCP is needed and not yet configured,
stop and provide exact step-by-step setup instructions before continuing.
Specify what to click, what to paste, and what to verify as confirmation it worked.

When any new external account is needed (Supabase project, Instantly workspace,
GoHighLevel subaccount, Lemlist account, Apollo account, etc.), stop and tell Doug:
  - What account is needed and where to create it
  - What settings or credentials to note down during setup
  - Exactly when to come back and what to provide

Never assume an account or credential exists. Always check first.

---

## MCP safety rules

MCPs have the same power to destroy as they do to create. Two rules apply to
every MCP operation in every session, no exceptions:

**Destructive operations require explicit approval before running.**
Before executing anything that removes, drops, wipes, disables, unpublishes,
or force-pushes — show Doug the exact command or API call and wait for a
clear "yes, do it" before proceeding. This covers: DNS record deletion,
env var removal, domain removal, database table drops, branch deletions,
deployment rollbacks, and any operation described with words like delete,
destroy, remove, disable, or force.

**Additive operations run without confirmation.**
New DNS records, new env vars, new domains, new tables, new deployments —
these are safe to execute directly and do not need a confirmation step.

**Never echo secret values.**
When showing env var commands or confirming what was set, display the key
name and scope only. Never print the value. Example: "Set
NEXT_PUBLIC_APP_URL in Production scope" — not the URL if it were a secret,
and never tokens, passwords, or API keys under any circumstances.

---

## Supabase migrations — applied via MCP, never assumed deployed

**Standing rule**: Migrations are NOT automatically applied by Vercel deploy.
Vercel deploys code; Supabase migrations must be applied explicitly via the
Supabase MCP `apply_migration` tool.

**Process**:
1. Write migration in `/supabase/migrations/` with unique timestamp filename
2. Commit to git
3. After push, use Supabase MCP `apply_migration` to run the migration live
4. Verify the change with a live read-back (Supabase MCP query or CLI)
5. Mark the migration file with `-- Status: APPLIED (verified live YYYY-MM-DD)`
6. Commit the status marker

**Never**:
- Assume Vercel deploy applied a migration (it doesn't)
- Skip the live verification step
- Leave migrations in the repo unapplied (track status in the file)
- Run `supabase db push` on this project. See below.

This prevents silent data-layer failures where code expects a schema change that was never applied.

**`supabase db push` is UNSAFE on this project. MCP `apply_migration` is the only
correct path.**

The remote migration history does not match the repo filenames. MCP `apply_migration`
records its own timestamp, generated when it runs, rather than the timestamp in the
migration's filename. So a file named `20260824140000_campaign_sending_state.sql` is
recorded remotely as version `20260824153206`.

`supabase migration list` therefore shows two columns that do not line up, and
`db push` reads that as a large set of unapplied local migrations. Running it would
attempt to replay files the database already has under a different version number,
against a schema that has already moved on.

`supabase migration list` is safe and useful. `db push`, `db reset` and `db remote
commit` are not. Confirmed 2026-08-24 while building the job queue.

---

## Documentation — update /docs every session, never skip

All technical documentation lives in /docs at the project root.
This is what Doug and Claude Code use when something breaks or a new session starts.

When building or changing any component, update the relevant /docs file.
If no file exists for the component, create one before finishing the session.

Write in plain English. Assume the reader is not a developer.
Each doc must cover: what this does, what it connects to, what to check if it breaks,
and why key decisions were made.

Required /docs files — create at project setup if missing:
  /docs/architecture.md     — system overview, data flow, tool-agnostic principle
  /docs/data-model.md       — all tables, fields, relationships, RLS policies
  /docs/auth.md             — roles, access control, multi-user client setup
  /docs/agents.md           — each agent: purpose, inputs, outputs, isolation rules
  /docs/integrations.md     — registry pattern, each registered tool, handler locations
  /docs/dashboard.md        — all views, what each shows, why
  /docs/signals.md          — signal types, processing logic, benchmark thresholds
  /docs/intake.md           — questionnaire flow, file types, completeness logic
  /docs/approval.md         — channel modes, notification timing, batch sampling
  /docs/reply-handling.md   — reply types, routing, escalation sequence
  /docs/deployment.md       — environments, variables, Sentry, Vercel configuration

The /prd folder holds the product specification (see PRD.md).
/docs = living technical reference, updated continuously as the build progresses.
/prd  = product specification, updated only when scope formally changes.

---

## Before ending any session — create a Notion Backlog row

If the session defers any scope item, decides to revisit something later, or hits
a known limitation that future-Doug will forget about, **create a row in the Notion
Backlog** before the session ends. Use the Notion MCP. Do not write it to a file.

This is not optional. The discipline is:
  1. Session surfaces something to defer.
  2. Claude Code flags it explicitly in the session summary.
  3. Doug confirms the item should be deferred (versus addressed now).
  4. Claude Code **creates the Notion Backlog row**, with Gate, Area, Type,
     Status = Open, and enough context in the page body to act on months later.
  5. Only then does the session end.

Without this, the backlog stays in Doug's head and in individual chat threads,
and the one that matters slips through when he's switching contexts.

**Write it the moment you find it, not at the end.** The habit that matters is
recording a finding immediately, while the reasoning is still in context. Only
the destination changed on 2026-09-04. If you catch yourself thinking "I will
add that at the end", add it now.

### Which database

  Backlog        A thing not yet done. Anything actionable.
  Decisions Log  A settled decision and its reasoning. Not a task; nobody can
                 "complete" it. Set Status = Locked.
  Knowledge Base A durable measured fact or a lesson. How something actually
                 behaves, what a limit really is, what an incident cost.

If it cannot be completed, it is not a Backlog row. Filing a finding as a task
puts something permanently uncompletable in the task list.

### Setting Gate on a Backlog row

  Live risk                   costing something today on a live campaign
  Before first paying client  must be resolved before the first paying client
  Before scale                fine at current volume, breaks at 500+ prospects
  Later                       real, but not before the above

**Every row must have a Gate.** The four gate views filter on it, so an ungated
row appears in no view and is invisible from the moment it is written.

### Reading the Notion Backlog back — LISTINGS AND FILTERS LIE. PAGE FETCH DOES NOT.

**Never use a Notion listing or filter for anything that decides scope.** Not to
count rows, not to decide what is in a batch, and never to decide that a field is
empty.

Measured on the Backlog database on 2026-09-04. Four read paths, three answers,
one column:

  aggregate COUNT / GROUP BY   ->  146, and "0 rows ungated"
  unfiltered view enumeration  ->  47 rows, has_more false, Gate key ABSENT on the rest
  rows-mode `Gate is_empty`    ->  127 rows, including rows that plainly have a Gate
  targeted page fetch          ->  Gate correctly set
  the browser UI               ->  Gate correctly set, every row

**The page API and the browser are truthful. Listings and filters are not.** They
were caught misreporting the same column three separate ways in one session,
including a view that returned `has_more: false` on a partial result set, which is
a listing asserting completeness it does not have.

The pattern, so it is recognisable next time: rows edited recently were reported
correctly and older rows silently lost the field **in the index only**. So the
error is invisible unless you already know what the answer should be, and it looks
exactly like data loss. **It is not.** The UI was checked on 2026-09-04 and every
Gate renders correctly, including the rows the enumeration omits.

Rules that follow:

1. **Page-fetch before marking anything Done**, or before acting on any row's
   field values.
2. Never "repair" a field on the strength of a listing. A bulk write to fix
   phantom nulls would have overwritten ~100 correct rows.
3. If you must enumerate, derive the list from a capture you can audit, state how
   you derived it, and say the number out loud so it can be checked. Do not present
   a listing count as a measurement.
4. An empty or short result is not evidence of absence. It is evidence the
   instrument answered.

This is the same shape as the audit query in the database-security section that
filtered `relkind = 'r'` and returned zero rows reassuringly for months: **when the
check is the thing that is wrong, nothing downstream of it can notice.**

### Reading the CODE back — A CLEAN TREE IS NOT A CURRENT TREE

**`git status` clean means no uncommitted changes. It says nothing about whether the
branch reflects main.**

Any session whose output depends on what the code currently contains must
**`git fetch origin` and work from `origin/main`**, and must **state the commit it
read in its first report**. A verdict about code with no commit attached is not a
verdict.

**The 2026-09-04 incident.** A triage session checked `git status` at start, saw
clean, and treated clean as current. The branch was **280 commits behind main**,
diverged 2026-08-27. Eighty-nine backlog rows were judged against it. It concluded
that client approval on strategy documents had not been removed, because
`DocApprovalControls.tsx` and `/api/documents/approve/` were both still present in
the working tree. On main both are **deleted**, replaced by `DocumentVersionHistory`,
`DocumentRevisionControls` and `/api/documents/revert`, plus a test literally named
`no-client-approval-surface.test.tsx`. The work had shipped days earlier.

**The error has a direction, and knowing it saves re-work.** A stale tree makes you
conclude work does NOT exist when it does. It cannot invent work that was never
written. So stale-tree findings are wrong in the direction of **too much work, not
too little**: a list of "still open" rows will contain items already done. The
reverse error, concluding something exists when it has since been deleted, happens
only where main REMOVED code, and is much rarer.

**`git cherry` answers a different question than the one you are asking.** It
compares by **patch-id**, so it reports a commit as unmerged whenever the surrounding
context has drifted, even though the change itself is upstream. In the same 2026-09-04
incident it reported **4 of 7 commits as NOT UPSTREAM when all 7 had landed.** Acting
on that would have meant re-applying work already on main.

To ask whether work is on main, **compare content, never identity**:

    git show origin/main:path/to/file | grep 'the thing you added'
    git ls-tree origin/main -- path/to/file        # present or deleted?

Identity comparisons (patch-id, SHA equality) answer "is this the same commit". The
question that matters is "is this change present", and only content answers it. The
same distinction applies to verifying a deploy: check by **containment and presence**,
never by SHA equality.

### A grep that finds nothing may not have run

**A zero result from `grep` has two causes and they look identical: the code is clean,
or the search never ran.** Shell quoting, an unescaped metacharacter, a wrong path, a
glob the shell expanded itself, `--include` patterns zsh ate before grep saw them.

**Always prove the grep can find something you know is there before concluding it
found nothing.** Search for a string you are certain exists in the same file with the
same command shape. If that returns zero too, the instrument is broken, not the code.

**The 2026-09-04 near-miss.** A triage session searched
`grep -c "toolName: 'Instantly'" SettingsView.tsx` and got **0**, and nearly retired a
backlog row as fixed. The nested quotes were eaten by the shell. Re-run without them,
the same file returns a hit on line 31, and `PLACEHOLDER_SETTINGS` still carries
`'Apex Consulting'`, `'Instantly'`, `'Taplio'`, `'Lemlist'`, `'Apollo'` and
`'Calendly'` as literals. The row would have been closed on the strength of a search
that never executed.

Same session, same shape: `--include=*.ts` unquoted, which zsh tried to glob-expand and
aborted the command with "no matches found" rather than running it.

**The general rule, and it is the one this file keeps relearning:** a check that
returns nothing has not told you the world is empty. It has told you the check
answered. Establish that an instrument can detect a positive before trusting its
negative.

**And check the test harness is actually running before trusting it.** This project's
suite needs `npx dotenv -e .env.test.local -- npx vitest run`. Without that file the
run **silently skips 33 tests, including cross-organisation isolation, and reports
green**. Measured on 2026-09-04: 1,830 tests on a stale tree without the env file,
against **2,938 on main with it**. A green run at the wrong count is the same class of
lie as the clean tree and the Notion listing. **State the test count.** Below ~2,924
means the env file is not being read.

### Label every finding by evidence type, because they expire differently

  DATABASE-EVIDENCED   read from the live database, a live API, or a deployed
                       environment. **Stays true as main moves.** Production is
                       production whatever branch is checked out.

  CODE-EVIDENCED       read from a file in a working tree. **Expires the moment main
                       moves.** Worthless without the commit it was read at.

State which every time. A closed row backed by a database read needs no re-checking
when the branch changes; a closed row backed by a grep needs re-proving against the
current commit. Mixing them means re-verifying everything or trusting everything, and
both are wrong.

---

## Model selection — right model for each task

Per ADR-013, current agent model assignments:

  Document generation agents (ICP, positioning, TOV):  claude-opus-4-6
  Buyer criterion derivation:                          claude-opus-4-6
                                                       Reads every approved document plus
                                                       intake and derives WHO the client
                                                       emails. Runs once per ICP approval,
                                                       not per prospect. See ADR-046.
  ICP geography derivation:                            claude-opus-4-6
                                                       Reads ONLY the tier 1 and tier 2
                                                       geography of the ICP being promoted,
                                                       and derives WHERE the client sells.
                                                       Tier 3 is the disqualifier tier and is
                                                       deliberately not read. Runs once per
                                                       ICP approval, alongside the buyer
                                                       criterion, so that path now makes TWO
                                                       model calls. See ADR-013.
                                                       It is the only Anthropic client in this
                                                       codebase with an explicit timeout and
                                                       maxRetries: the SDK defaults are 10
                                                       minutes and 2 retries, which is 30
                                                       minutes against a 300s route, and
                                                       nothing retries a failed spec
                                                       derivation. Every other client here
                                                       still inherits those defaults.
  Messaging generation agent:                          claude-sonnet-4-6
                                                       (local-dev workaround —
                                                        revert to opus-4-6 when
                                                        streaming works stable)
  Prospect research — synthesis, writer, judges:       claude-sonnet-4-6
                                                       CORRECTED 2026-08-24. This list and
                                                       ADR-013 both said haiku-4-5. The code
                                                       has used sonnet-4-6 since the v2 agent
                                                       shipped (synthesize.ts:22,
                                                       write-opening.ts:23-24). Sonnet is
                                                       roughly 3x Haiku, so every cost model
                                                       built on the old figure was low.
                                                       RESEARCH MAKES FOUR SONNET CALLS PER
                                                       PROSPECT: synthesis, writer, floor
                                                       judge, judge. A retry re-runs the
                                                       writer, so a retried prospect is five
                                                       or six. This is where the per-prospect
                                                       Anthropic spend is, and where prompt
                                                       caching pays.
  Composition (bridge sentence):                       NONE. Composition makes zero model
                                                       calls. BRIDGE_ENABLED has been false
                                                       since 5047e24 (2026-08-19).
  Signal processing, batch tasks:                      claude-haiku-4-5-20251001
  Reply handling (positive reply classification):      claude-haiku-4-5-20251001
  Claude Code itself (build, debug, refactor):         claude-sonnet-4-6

Model versions must be passed explicitly in every Anthropic API call.
Never rely on API defaults.

If a model is retired or replaced, update the relevant agent file directly.
Update this list and ADR-013 in the same commit.

---

## Agent isolation — absolute, enforced at three levels

Every agent invocation must pass client_id as a required parameter.
Agents query only data associated with that client_id. No exceptions.

The only permitted cross-client operation is reading the patterns table,
which contains anonymised aggregated insights — never raw client data.

The patterns table is written ONLY by the dedicated pattern aggregation agent.
No other agent, no application code, no manual query ever writes to it directly.

Three enforcement levels:
  1. Database: RLS policies block cross-client queries at the data layer
  2. Application: explicit client_id filter on every Supabase query
  3. Agent prompts: no prompt references any data source outside current client context

Wrong: const signals = await getSignals()
Right: const signals = await getSignals({ client_id })

A data leak between clients is the most serious error this system can produce.
If ever unsure whether an agent call is properly isolated, stop and verify first.

---

## Agent conventions — stateless, discrete, isolated

### Stateless invocation
Every agent must be stateless. No module-level variables that persist between calls.
All state is passed as explicit parameters on every invocation.
Each call must be independently reproducible: same inputs produce equivalent outputs.
Never rely on in-memory state from a previous invocation.

### Discrete entry points
Each agent has its own dedicated entry point file.
Named descriptively after its function: prospect-research-agent.ts, document-generation-agent.ts.
No shared dispatcher file that branches on a type parameter to route to different agents.
One file = one agent = one clear purpose.

---

## Product scope and industry agnosticism

MargenticOS is industry-agnostic infrastructure. The 
agent pipeline, document generation system, composition 
layer, approval flow, and all supporting architecture 
are designed to serve any B2B business regardless of 
industry, buyer type, company size, or growth model.

The current go-to-market focus is founder-led B2B 
consulting and coaching firms. This is a starting point 
based on Doug's access, validated pain data from 1,311 
Lean Marketing sales call transcripts, and 
founder-market fit. It is not a product constraint.

The long-term vision is a full AI agentic-led marketing 
department for hire, deployable across any B2B industry.

Build decisions must reflect this:

- No agent prompt may hardcode industry-specific 
  assumptions, buyer archetypes, pain points, growth 
  models, or competitive sets as universal defaults
- All agent prompts must derive industry, buyer type, 
  and pain language from runtime documents — the ICP 
  document, positioning document, TOV guide, and 
  intake data
- When intake data is thin, agents must flag the gap 
  and derive from context — they must never fill gaps 
  with consulting assumptions
- Example values in prompt templates, output format 
  schemas, and worked examples must be industry-neutral
- Any new agent, prompt, or feature built must pass 
  this test: "Would this work correctly for an AI 
  voice calling company, a SaaS business, or a 
  logistics firm?" If not, it is not ready

The only exception: MargenticOS's own client-zero 
campaigns target consulting and coaching firms because 
that is Doug's ICP for MargenticOS itself. This is 
operationally correct and does not contradict the 
above — it is one client's ICP, not a universal 
assumption baked into the product.

## Industry naming is always canonical — never tool-specific

Internal storage, agent prompts, filter specifications, and database fields always
use canonical NAICS-derived industry names (e.g. "Management Consulting",
"Software Publishers", "Marketing Consultancy"). Never store or reference Apollo's
industry names, Instantly's industry names, LinkedIn's industry names, or any
other tool-specific taxonomy in application code, agent prompts, or client
records.

Each sourcing handler owns its own translation table from canonical names to
tool-specific names. Translation is the handler's responsibility. Nothing
upstream of the handler sees tool-specific names.

Doug never sees NAICS codes in the UI. The UI displays canonical industry names
directly.

---

## Prompt and validator consistency rules

When a prompt and a validator enforce the same rule, they must agree exactly.
If one is updated, the other must be checked and updated in the same session.

Known validator thresholds. Code-enforced, cannot be overridden by the prompt.
THE SOURCE OF TRUTH IS EMAIL_WORD_LIMITS and EMAIL_SUBJECT_LIMITS in
src/agents/messaging-generation-agent.ts. The figures below mirror it. If you change one,
change both in the same commit, and check docs/prompts/messaging-agent.md too.

  Email 1 subject:   maximum 40 characters (target < 25). The ONLY email with a subject.
  Emails 2, 3 and 4: subject_line must be null; subject_char_count must be 0.
                     All three thread under Email 1 so a reader who ignored the first
                     three can scroll up from the breakup and see who the sender is.
                     Email 4 previously had its own subject with a 24-character cap and a
                     four-distinct-subjects rule. Both are DELETED, not relaxed: they
                     existed only to make a separate Email 4 subject workable, and the
                     separate subject was the mistake. Do not reinstate either.
  Email 1 body:      50 to 80 words, hard cap 90, floor 50
  Email 2 body:      30 to 85 words. NOT chained to Email 1. The coupling was DELETED on
                     2026-08-28, not relaxed. All four emails are written in one response,
                     so Email 1's final word count does not exist while Email 2 is being
                     written: the rule demanded a target the model could not read. Measured
                     across 15 attempts in two runs, Email 2 landed 62 to 79 words against
                     an Email 1 of 56 to 71, and the pair of rules cost EIGHT failed
                     single-variant API calls in one run, which is what exhausted the 240s
                     guard. 85 is mean + 3sd of that observed distribution. Do not reinstate
                     the coupling to "restore the taper": the taper is carried by the bands
                     themselves (85 / 70 / 50).
  Email 3 body:      30 to 70 words, must be NO LONGER THAN Email 2 (equal passes).
                     This is the SAME shape as the deleted Email 2 rule and is kept
                     deliberately: it binds only when Email 2 lands near its 30-word floor,
                     and it was not implicated in any measured failure. See BACKLOG MSG-02.
  Email 4 body:      up to 50 words. NO FLOOR. A breakup at 26 words is not a defect,
                     and the old floor of 30 cost a full regeneration call each time
  Sign-off:          TWO mandatory lines at the end of every email body, consecutive,
                     nothing after them:
                       [sender first name]     <- organisations.founder_first_name
                       [sender company name]   <- organisations.name
                     An email ending with only the first name FAILS validation.
                     The company name is required, never optional: optionality means it
                     does not get populated. It gives the prospect something searchable
                     without putting a link in the body. Never hardcoded, always read
                     per client from the organisation record. If organisations.name is
                     empty the run fails loudly at preflight rather than omitting the line.
  Questions:         maximum ONE question mark per email body, enforced in code.
                     The CTA is the question. Rhetorical questions count.
  Opening word:      must not be I or We, applied to the observation slot only.
                     Email 1 paragraph 3 ("what changes") MAY begin with We.
  Em dashes:         zero tolerance; any instance causes the entire variant to be flagged
  Bare pronouns:     HARD FAIL on it/they/them in EMAIL 1 P3 when that paragraph never
                     names what they stand for. P3's only predecessor is the replaced
                     slot, so the referent can only be P2. "We run it differently" shipped
                     and broke: with a researched P2 it reads "run WHAT differently".
                     Write "We run outbound differently". P4 onward is REPORT ONLY,
                     because P3 survives composition and may supply the antecedent, and
                     bare demonstratives are report-only everywhere because "that" is also
                     a relative pronoun and a complementiser. Measured across 27 real
                     Email 1s: 1 hard hit, which was the bug, and 12 report-only hits that
                     a wider gate would have rejected as false positives.
  Back-references:   HARD FAIL on a demonstrative binding a noun in EMAIL 1, paragraph 3
                     onward: "that ceiling", "this pattern", "those meetings", "such
                     firms". P2 is replaced at composition, so a later paragraph pointing
                     at it breaks exactly when personalisation succeeds. Enforced by
                     findBackReferences in src/lib/style/back-reference.ts.
                     EMAIL 1 ONLY: composition replaces nothing in emails 2 to 4, so a
                     back-reference there is ordinary English. Reported, never gated.
                     Gating all four positions dropped a whole variant.
                     Definite articles are REPORT ONLY and must never gate: "without you
                     touching the outreach" is good copy and no pattern can tell it from
                     "so the gap between projects isn't a panic".
  Sentence reuse:    HARD FAIL, EMAIL 1 ONLY. No full sentence (4+ words) may appear in
                     more than one variant's Email 1. Emails 2 to 4 may overlap and are
                     not checked: Email 1 is where the four angles differ and where most
                     replies originate, and policing all sixteen emails compounded so
                     badly that the last variant could not be filled.
                     Within Email 1 it covers every sentence, not just subjects and
                     openers. Enforced by SentenceRegistry in
                     src/lib/style/sentence-frames.ts, which normalises proper nouns and
                     numbers first, so swapping one name does not clear it. The two-line
                     sign-off is exempt. First writer wins, in sorted variant order.
  Offer line (P3):   names what the SENDER does and what changes for the prospect. Must
                     not describe work the prospect still has to do, and must not explain
                     their own job back to them. "You take the calls and close them" fails
                     on both counts and shipped in three variants at once.
  Firmographics:     HARD FAIL on any figure from the prospect's record: revenue,
                     headcount, funding, currency amounts, "500K", "5M", "team of 12".
                     The population may be qualified by ROLE, STAGE or SITUATION only.
                     "Most B2B consulting firms at the £500K to £5M mark" and "billing
                     north of £500K" both shipped and both are banned. It reads as a
                     database lookup, it may be wrong, and a wrong number in the opening
                     line is worse than a generic one. The ICP revenue band is a TARGETING
                     instruction, never email content. Enforced via BANNED_FIRMOGRAPHIC.
                     Ordinary numbers are untouched: "your last 30 reviews", "13 months".
  Ampersands:        none in prose; write "and". Fine inside a company's own name.
  Internal jargon:   never send ICP, top of funnel, buyer persona, value prop, or
                     go-to-market to a prospect. Enforced in code via BANNED_JARGON.
  Exclusivity:       never assert what the prospect does NOT have. "Most of the pipeline
                     comes from referrals" survives being wrong; "no outreach running"
                     does not. The problem is framed as a pattern they can recognise
                     themselves in, never as a verdict about them.

Word counts include the {{first_name}} line and BOTH sign-off lines, and exclude the
opt-out footer. word_count and subject_char_count are RECOMPUTED by the agent from the body
text before validation and before storage. The model's self-reported values are discarded.
countWords is imported from the composition layer so both measure identically.

Rendered end of every sent email, in order:
  [CTA question]
  (blank line)
  [sender first name]
  [sender company name]
  (larger gap, added by plainTextToHtml)
  Not for you? Just reply stop.
The footer is appended at composition, after the sign-off block, and is not word-counted.

Email 1 is authored as a FRAME WITH A SLOT, not as finished copy:
  P1 {{first_name}}
  P2 observation slot, replaced at composition when research exists. Names the problem.
     The only paragraph that may describe the problem. Never pitches.
  P3 what changes. Names a RESULT in the prospect's terms. Never names the service,
     the mechanism, or features. Flexes per variant, never a fixed reused line.
  P4 the CTA question
  P5 the sign-off
No paragraph may restate another (non-redundancy), and no paragraph may refer back to the
one above it (paragraph independence, because P2 is unknown at authoring time).

When writing or editing an agent prompt, check the corresponding validator before committing.
When writing or editing a validator, check the corresponding prompt before committing.
Never update one without confirming the other still agrees.

---

## Style rules for all generated content

These rules apply to every agent that produces customer-facing text:
trigger sentences, email copy, document summaries, and any output that
reaches a client or prospect.

The canonical source is: src/lib/style/customer-facing-style-rules.ts
Every agent touching customer-facing output must import from this module.
Do not duplicate these rules inline in individual agent prompts — import the constant.

**Em dashes (—), en dashes (–), and double hyphens (--) are absolutely forbidden.**
They are the most recognizable AI writing tells. MargenticOS's ICP (founder-led
consulting firms burned by AI email) detects them immediately.

Replace with:
  - A period and a new sentence (most common fix)
  - A comma (when the clause is tightly connected)
  - A colon (when what follows IS the thing described)
  - Sentence restructuring

Other forbidden AI tells in all generated content:
  - "Delve into"
  - "Navigate the complexities of" / "Navigate the landscape"
  - "Leverage" as a verb (use "use", "apply", or "build with")
  - "Seamless" / "Seamlessly"
  - "Robust"
  - "At the end of the day"
  - "That said" / "Having said that"
  - Sentences starting with "Look,"
  - "Furthermore" / "Moreover" / "Additionally"
  - "It's worth noting that"
  - Three-part parallel lists in a single sentence ("not just X, but Y and Z")
  - "As someone who..." when the framing is speculative or inflated
    (legitimate experience-based openers such as "From working with..." are fine)

The messaging agent has a runtime scrub via scrubAITells() as a safety net.
All agents that produce customer-facing text must call scrubAITells() before
storing or sending output. There is no runtime net without it.

---

## Feedback loop — suggestion queue, never direct document updates

Agents write suggestions to the document_suggestions table.
Agents never update strategy documents directly.

Signal thresholds before a suggestion is generated:
  3 signals (same type, unrelated prospects) → low-confidence suggestion, informational
  5 signals → agent generates A/B test variant for next batch
  10 signals + confirmed A/B winner → high-confidence suggestion generated

When two suggestions conflict for the same document field:
  Surface them together with three options:
  A) Apply suggestion one  B) Apply suggestion two  C) Wait for more signal
  Default is always C. Active choice required to apply either suggestion.

Phase one — schema only:
  Signal threshold logic (3/5/10 tiers), A/B test generation, and conflict resolution
  between competing suggestions are schema-only in phase one. The document_suggestions
  table must exist with the relevant fields (signal_count, confidence_level, ab_variant,
  conflicting_suggestion_id), but the processing logic is not implemented until campaign
  data makes it meaningful. Flag to Doug before implementing any of this logic.
  Do not build it speculatively.

Auto-approve: phase four only. Do not build in phase one.

---

## Approval system — channel toggles

STRATEGY DOCUMENTS HAVE NO CLIENT APPROVAL. Removed 2026-09-03, see ADR-047. A document
is live because an operator produced it, every version is kept with the note that produced
it, and an operator can restore any of them. There is no pending state, no Approve button
and no three-day auto-approval. The channel toggles below are a DIFFERENT mechanism and
are unaffected, as is prospect batch review.

cold_email: sequence-level approval. Client approves the template, not individual emails.
  Optional batch sample (5–10 emails) showing personalisation source tags.
  3-day auto-approve. Notifications at T+0, T+15h, T+48h, T-12h.

linkedin_post: toggle per client, default ON.
  Dashboard is the approval layer. Taplio is the publishing layer only.
  Taplio has no public API for programmatic scheduling — do not attempt to build one.
  Approved in dashboard → content delivered to Taplio queue via Zapier or manually.
  24-hour auto-approve.

linkedin_dm: same model as cold_email. Tool: Lemlist (registered via can_send_linkedin_dm).

Doug notified for all rejections and auto-approvals across all channels.

---

## Reply handling

Positive reply:
  Respond same business hour. Include Calendly link. Say "grab a slot."
  Sign as "[Client Company Name] Team." Never use founder name, never mention AI.

Information request:
  No automated response. Flag to client immediately as high priority.
  Escalation: 15h reminder → 48h second reminder → 72h system holding message.
  Holding message signed by company team. Toggle per client, default off.
  Doug can reply on client's behalf via GHL.

Negative reply / opt-out:
  Any refusal or hostile language = immediate suppression. One signal is enough.
  Covers all variations: stop, remove me, not interested, fuck off, leave me alone,
  and any unmistakeable refusal regardless of exact wording.
  Push suppression to Instantly API immediately.

Out-of-office:
  Detect via pattern matching. Pause sequence for that prospect.
  Extract return date. Resume day after. Default: 10 business days if no date found.
  System manages timing and instructs Instantly to resume via API.

Opt-out footer in all outbound emails:
  "Not for you? Just reply stop."
  Never use the word "unsubscribe."

  Applied at COMPOSITION time, never at document generation time.
  Single source of truth: src/lib/composition/opt-out-footer.ts
  Appended by appendOptOutFooter() in src/lib/composition/compose-sequence.ts,
  which runs after word_count and after the BRIDGE_HEADROOM check so the footer
  never consumes an email's word budget. Rendered with extra top margin by
  plainTextToHtml() in src/lib/composition/custom-variables.ts.

  Do not reinstate a generation-time footer in the messaging agent. One existed,
  it was validated and then discarded by a return-value bug, and every stored
  document was shipped without a footer as a result. Applying it at composition
  means every send is compliant regardless of which document version the copy
  came from, and no document needs a new version to become compliant.
  A generation-time footer would now double up with the composition one.

---

## Benchmark thresholds — warnings engine defaults

Reply rate:         green >5% | amber 3–5% | red <3% for 2 consecutive weeks
                    below 1% = immediate deliverability investigation flag
Positive reply %:   flag if positive replies drop below 40% of total replies
Bounce rate:        green <1% | amber 1–2% | red >2% | auto-pause above 3%
Spam complaint:     green <0.1% | amber 0.1–0.3% | red >0.3%
Open rate:          directional only — flag if below 15% sustained 2 weeks
Unqualified mtgs:   flag if 3+ consecutive meetings marked unqualified
No-show rate:       flag if 2+ no-shows in same week
Doc refresh:        automated warm email to client every 90 days

All thresholds configurable per client in operator settings.

---

## Pipeline visibility — phased unlock

Months 1–2: strategy and setup view is the default. Pipeline view is locked.
Unlock trigger: 2 months elapsed OR 5 meetings booked, whichever comes first.
Trend line visible: after 8 weeks of campaign data.
Trend line dominant: after 12 weeks.
Contract status, engagement month, payment status: operator view only, never client-facing.

---

## Environments — three, never skip staging

development:  local — Supabase local or dedicated dev project
staging:      Vercel preview — automatic on push to any non-main branch
production:   Vercel main — only after staging verified

Separate environment variables in Vercel for each environment.
Never push to production without staging verification.

---

## Code quality

Stack: Next.js 14+, TypeScript, Tailwind CSS, Supabase.
Always TypeScript. Always Tailwind. No inline styles. No separate CSS files.
One component = one responsibility.
Descriptive names: handleApprovalSubmission not handleSubmit.
Plain English comment above complex logic explaining WHY it exists.
Never use console.log, console.error, or console.warn directly in application code.
All log output goes through the project's single logger module.
This enables structured logging, Sentry integration, and log level control.
The logger module is created at project setup and imported everywhere logging is needed.
Debug-level logs must not appear in production — use log level guards.

---

## Hooks — four checks, now ACTUALLY ENFORCED

**As of 2026-08-27 these are executable hooks, not prose.** They were described here from
the start of the project and nothing ran them, so they fired only when someone remembered.
On 2026-08-26 a live webhook secret reached a PUBLIC repository inside a schema dump and
stayed there until a manual scan found it a day later. A rule that depends on remembering
is not a control.

Wired in `.claude/settings.json`:

  PreToolUse  on Bash          -> .claude/hooks/pre-commit-gate.sh   BLOCKS the commit
  PostToolUse on Edit/Write    -> .claude/hooks/post-edit-tsc.sh     advisory

The gate inspects the **staged diff**, which is exactly what the commit will contain, and
**added lines only**, so the commit that REMOVES a secret is never blocked. Exit 2 blocks;
matched values are redacted to their first six characters in the output.

Self-test: `bash .claude/hooks/__test__/gate-selftest.sh` — 11 cases, and the ALLOW cases
matter as much as the BLOCKs. A gate that blocks everything is an outage, not a control.

Do not bypass a block with `--no-verify` or by rewording the command. If a match is a
false positive, narrow the pattern in the hook, and say so in the commit message.

### Pre-commit: secret check (NEW 2026-08-27)
Blocks any staged addition containing a 64- or 32-character hex string, a JWT, an
`sk-`/`sk-ant-`/`re_` key, an AWS or GitHub token, or a `Bearer` literal.

64-char hex is there because that is `openssl rand -hex 32`, which is what generated both
`NEXT_INTERNAL_SECRET` and the webhook secret that leaked.

**A database dump is not safe to commit by default.** Postgres stores credentials in the
catalog in at least two places: a Supabase Database Webhook keeps its headers as a literal
inside the trigger definition, and pg_cron keeps bearer tokens in `cron.job.command`. Any
dump, baseline or schema capture must be scrubbed by its generator, not afterwards. See
`scripts/regen-schema-baseline.ts`, which scrubs during generation and refuses to write a
file containing anything secret-shaped.

### Pre-commit: .env check
Before any commit, verify .env is in .gitignore.
  Run: grep '\.env' .gitignore
If .env is not listed, add it and commit the updated .gitignore first.
Never proceed with a commit if .env could be tracked by Git.

### Pre-commit: tool-name reference check
Before committing any new or modified agent or component file, scan for hardcoded
tool names: Instantly, Taplio, Lemlist, Apollo, GoHighLevel, Calendly, HunterIO,
MyEmailVerifier, Bouncer, Apify, Brave.

MyEmailVerifier was missing from this list until 2026-08-25, and its absence is exactly
why the literal string 'myemailverifier' reached a DATABASE COLUMN DEFAULT
(prospects.verification_provider) without ever being flagged. A vendor name in a column
default is the hardest kind to remove later, because existing rows carry it. Any new
vendor goes on this list in the same commit that introduces its handler.
Hardcoded tool names belong only inside handler functions in the integrations layer.
If a hardcoded tool name appears in an agent or component, flag it before committing.

### Post-edit: TypeScript type check
After editing any TypeScript file, run: npx tsc --noEmit
Confirm no type errors were introduced before moving to the next step.
Do not commit TypeScript files with type errors.

---

## What not to build

Do not build:  email sending        → Instantly
Do not build:  LinkedIn scheduling engine  → Taplio handles content delivery after dashboard approval; no API integration
Do not build:  LinkedIn DMs         → Lemlist
Do not build:  CRM                  → GoHighLevel
Do not build:  prospect database    → Apollo
Do not build:  email signatures     → configure in Instantly per client
Do not build:  booking system       → Calendly or client's existing tool

---

## Anti-patterns — never

Never hardcode a tool name where a capability reference belongs.
Never hardcode client_id or user_id in application code.
Never return Supabase data without RLS or explicit client_id filter.
Never show operator-only data in a client-visible component.
Never write directly to a strategy document — always use suggestion queue.
Never write directly to the patterns table except from the aggregation agent.
Never skip staging for any reason.
Never end a session without committing completed work.
Never make an architectural decision silently — always name it to Doug.
Never proceed past a blocker without explaining it in plain English first.
Never place a route directly under src/app/dashboard/ outside (client)/ or operator/ —
  dashboard/layout.tsx is a bare passthrough with no auth gate and no chrome. A bare
  dashboard/ route would be silently unauthenticated. Client pages go in (client)/,
  operator pages go in operator/. Route-group parentheses are invisible to URLs.

---

## Silent-failure shapes — recognise these before writing them

Some code shapes fail without producing an error, a log line, or a failing test. They are
worth recognising by shape, because each one has already cost this build real time.

### Parallel arrays that must stay in sync

Two arrays whose elements correspond by INDEX, walked together by a loop. Adding an entry to
one and not the other produces no error: the loop is bounded by one of them, so the extra
entry is silently never reached, or the pairing shifts and every entry after the insertion
point is quietly mismatched.

**The 2026-08-25 incident.** monitor-sweep held `checkCodes` (16 entries) and `viewNames`
(17 entries), looped `for (i = 0; i < checkCodes.length; i++)`, and read `viewNames[i]`. So
`mon_019` at index 16 was never queried. The verification sweep was running, writing
heartbeats, and its monitor view returned OK, while `monitor_events` held ZERO rows for
MON-019. **A monitor that exists and is silent reads on the dashboard as a monitor that is
healthy, so this is a defect that hides defects.**

Worse: the commit immediately before the fix was titled "so something actually reads the
verification sweep's heartbeat". It added the view name to one array and not the check code
to the other. **The defect survived its own fix**, and the commit message asserted otherwise.

The fix is structural, not vigilance: **one array of pairs**, so the drift cannot be
expressed. There is no way to add a view without naming its code, and no index arithmetic to
get wrong.

    // Wrong
    const codes = ['MON-001', 'MON-002']
    const views = ['mon_001', 'mon_002', 'mon_003']

    // Right
    const MONITORS = [['MON-001', 'mon_001'], ['MON-002', 'mon_002']] as const

And pair it with a test that checks the registry against the WORLD, not just against itself.
The test that would have caught this scans the migrations for every `CREATE VIEW mon_NNN` and
fails if the sweep does not query it. That test also guards itself: it fails if the scan finds
no views at all, rather than passing vacuously over an empty set.

This is the same family as validate-one-thing-return-another: **the check runs, reports
success, and the thing it was supposed to protect was never reached.**

### A type assertion that switches off the check that would have caught it

`as` does not convert a value. It tells the compiler to stop checking. So the single
most dangerous place for a cast is exactly where a type was doing useful work.

    // Wrong. The literal is incomplete, and `as` is why nothing says so.
    const byJobType = {
      enrich: emptyResult(),
      research: emptyResult(),
      compose: emptyResult(),
    } as Record<JobType, JobTypeResult>

    // Right. Derived, so the drift cannot be expressed.
    const byJobType = Object.fromEntries(
      JOB_TYPES.map(jobType => [jobType, emptyResult()]),
    ) as Record<JobType, JobTypeResult>

**The 2026-08-26 incident.** `run-worker.ts` held the wrong version above. Without the
cast, `Record<JobType, JobTypeResult>` makes an incomplete literal a COMPILE ERROR, and
that error is precisely the notification that a new job type needs a result slot. The
cast silenced it. When `research_sources` and `research_collect` were added,
`byJobType[jobType]` was `undefined`, and the worker crashed on `result.enabled` inside a
try/catch that recorded the crash as "job type pass threw". Thirty tests failed at once,
which is the only reason it was caught before deploy. In production it would have been a
job type that silently never ran, reported as a caught error rather than as a missing
handler.

This is the same family as the parallel arrays above, one level up: a second list
(the literal's keys) that has to be kept in step with a first list (`JOB_TYPES`) by hand.
The fix is the same in kind: derive the second from the first so there is only one list.

**The rule:** before writing `as` on an object literal, ask what the target type would
have rejected. If the answer is "an incomplete or wrong-shaped literal", the cast is
load-bearing in the wrong direction. Build the value from the source of truth instead.
`satisfies` is often the right tool where a literal really is wanted: it checks the shape
without widening or silencing.

### A fake that does not honour a filter cannot test that filter

An in-memory stand-in for a database client is the standard way to test query logic
without a live connection. The trap is that a fake is written to satisfy the code paths
you were thinking about, and it QUIETLY ACCEPTS every call it does not implement:

    eq:    (c, v) => chain      // recorded, honoured
    in:    (c, v) => chain      // recorded, honoured
    limit: () => chain          // SWALLOWED. Returns everything, always.

The chain still returns data, the test still passes, and the assertion still looks like
it is about the filter. It is not. Remove the filter from the real query and nothing
fails.

**Three instances, all found on 2026-08-26 by mutation-testing rather than by reading:**

- `.limit()` ignored. `MAX_ENTRIES_PER_BATCH` set to 1 passed the whole suite, so a change
  turning one batch per organisation into one batch per prospect would have shipped
  green, taking the shared cached prefix with it.
- `.select(cols)` swallowed at the wrapper. The column list was consumed by `from().select()`
  and never reached the chain, so a hook keyed on which columns a read asked for never
  fired, and deleting the claim's concurrency guard passed everything. That guard is what
  stops two overlapping sweeps submitting and paying for the same entry twice.
- `job_type` and `state` filters dropped in the enqueue fake. Narrowing the real query
  from three research job types to one failed exactly ONE test, the one that inspects the
  filter directly, while every behavioural test stayed green. The behavioural tests were
  the ones that were supposed to prove the prospect could not be double-charged.

**Why this is its own shape.** It is not the parallel arrays (two lists that must agree),
and it is not validate-one-thing-return-another (a check that runs on the wrong value).
Here the production code is CORRECT and the test is structurally incapable of noticing
when it stops being. The suite is green in both worlds, so coverage numbers, test counts
and CI all report success while the guard is gone.

**How to apply:**

1. A fake must honour every filter the code under test applies, or explicitly THROW on
   the ones it does not implement. Silently returning `chain` is the failure.
   `limit: () => { throw new Error('fake does not implement limit') }` is a better fake
   than one that ignores it.
2. **Mutation-test the guard, not the code path.** Delete the filter in the real query and
   confirm a test goes red. Zero failures means the filter is not covered, whatever the
   line coverage says.
3. When a mutation comes back uncovered, **suspect the fake before the guard.** Twice out
   of three here the guard was correct and the fake was lying.
4. Anything with a timing component (a row changing between a read and a write) needs the
   fake to be able to CHANGE STATE at that exact point. A test that sets up the conflict
   before the read never reaches the guard at all, which is how the first version of the
   concurrency test passed against both the real code and the mutated code.

### A test that reads the migration files proves history, not present state

Migrations are append-only. A test that scans `supabase/migrations/*.sql` for a
`CREATE INDEX` proves that a migration once created it. It says nothing about whether the
index exists now, because a later migration is free to drop it and the CREATE stays in
the repository, green forever.

**Found 2026-08-26 by mutation-testing a test rather than a guard.** A test asserted that
the migrations still create `system_flags_research_path_exclusive`, the index that a
TypeScript assertion depends on. Deleting the statement failed the test. RENAMING it
failed nothing, because the assertion was a substring match and the new name contained
the old one. The tightened version matches `CREATE UNIQUE INDEX ...` and separately
asserts no `DROP INDEX` names it.

**The rule:** a migration scan is a cheap early warning and it belongs in the test suite,
but it is never the authoritative check. Anything a code path actually depends on being
true in the database gets a LIVE check that reads `pg_indexes`, `pg_constraint`,
`has_table_privilege` or `pg_policies`, and that check goes in a monitor so it keeps
running after the day it was written. State the limit in the test itself, so the next
reader does not over-trust it.

### A rule change that does not change any row, because the verdict was frozen

A predicate evaluated once and stored is not the same thing as a rule. Editing the rule
feels like changing behaviour and changes nothing that already exists.

**`prospects.email_send_eligible` is a materialised verdict.** `checkSendEligibility`, which
owns `EXCLUDED_COUNTRIES`, is called ONLY at verification time
(`verification-trigger.ts:484`, `send-eligibility-resolver.ts:97`) and written to the column
there. The send path reads the column (`actions.ts:288`, `actions.ts:329`) and never
re-evaluates.

**So adding a country to `EXCLUDED_COUNTRIES` is NOT retroactive.** Prospects verified
before the edit keep their old verdict until re-verified, and re-verifying costs money.
There is no code path that re-evaluates eligibility without paying a verifier.

**And our gates govern UPLOAD, not DELIVERY.** Once a prospect is uploaded, the outbound
provider owns the sequence. Setting `email_send_eligible = false` afterwards does nothing to
email the provider has not sent yet. That is not a bug in the column; it is the boundary of
what the column can do.

**The 2026-08-26 finding.** Country normalisation and alias matching both landed on
2026-08-25 and both are correct. Neither reached two German prospects already verified,
already uploaded, and mid-sequence. Their rows read `false / country_excluded_de` while the
provider had two more emails scheduled for them. Four emails had already been delivered, not
the two the incident record captured, and the second went out one day before the fix.

**The rule when changing any eligibility or compliance rule, in order:**

1. Change the rule.
2. Ask what it does to rows ALREADY EVALUATED. Usually nothing. If it must apply to them,
   that is a separate re-evaluation pass with its own cost.
3. Ask what it does to prospects ALREADY UPLOADED. Always nothing. Stopping those is a
   provider-side action and no code does it.

A compliance rule needs three layers and this codebase has two: normalise on write, evaluate
on verification, and REMOVE what is already in flight. The third does not exist. See ADR-034.

### Related shapes already documented elsewhere in this file

- Validating one value and returning another. The generation-time opt-out footer was
  validated and then discarded by a return-value bug; every stored document shipped without
  a footer.
- A REVOKE that is a no-op, and a verification that reads only the role it hopes to see.
  See the database security rules below.
- A producer and a consumer that are each correct and disagree on FORMAT. The Apollo handler
  wrote `"Germany"` and the send rule matched `'DE'`; both sides had passing tests, nothing
  tested the seam, and two German prospects were mailed. If two modules must agree on a
  value's shape, one test must exercise the PAIR, not each side alone.
- A circular import. It passed `tsc --noEmit` and 1,578 vitest tests and failed only
  `npm run build`. This is why a local production build is a required receipt.

## Database security — four standing rules (learn from 2026-06-05, 2026-08-24 and 2026-08-25)

### Rule: seniority_levels is NOT the buyer criterion, and the gate must never read it

Two different questions, and one list serving both is what this project already got wrong.

  seniority_levels     what we ASK THE PROVIDER FOR. Deliberately wide, because the
                       provider derives seniority from job title and is coarse.
                       Narrowing it measured 29,139 rows against 72,458.
  buyer_criterion      who we will actually EMAIL, out of that wide result. Narrower,
                       and DERIVED PER CLIENT from that client's own documents.

The pre-enrichment gate and the fit score both read `spec.buyer_criterion` and nothing
else. Never widen the gate to read `seniority_levels`, and never narrow `seniority_levels`
to make the gate simpler: those are opposite ends of the pipeline and they trade against
different things. See ADR-046.

Never reintroduce a hardcoded list of job titles anywhere. `DECISION_MAKER_PATTERNS` was
twelve fragments applied to every client, it was a Rule Zero violation in production for
months, and it stayed invisible because the one live client in another market passed it by
a coincidental substring collision rather than by design.

---

### Rule: REVOKE FROM PUBLIC is NOT enough on Supabase. Name anon and authenticated.

This is the rule most likely to give you a false sense of safety, because the wrong
version of it looks correct and passes a careless check.

**Supabase runs ALTER DEFAULT PRIVILEGES on the public schema granting EXECUTE to
anon, authenticated and service_role.** Every function created in the public schema
therefore receives EXPLICIT, BY-NAME grants to anon and authenticated at creation
time. It does NOT rely on the PUBLIC pseudo-role.

So `REVOKE ALL ON FUNCTION ... FROM PUBLIC` removes a grant that was never there.
It is a **silent no-op**. It does not error, it does not warn, and the function stays
callable by anon.

**SECURITY DEFINER executes as the function owner and bypasses RLS entirely.**
Enabling RLS on the underlying table with zero policies does NOT protect against
this. The policies are never consulted, because the function is not running as the
caller.

Every SECURITY DEFINER function must therefore:

  1. REVOKE from all three, explicitly:

       REVOKE ALL ON FUNCTION public.fn_name(...) FROM PUBLIC;
       REVOKE EXECUTE ON FUNCTION public.fn_name(...) FROM anon, authenticated;

  2. GRANT to each legitimate caller, in the same migration:

       GRANT EXECUTE ON FUNCTION public.fn_name(...) TO service_role;

  3. VERIFY, before committing, checking the roles that must NOT have it as well as
     the one that must:

       SELECT has_function_privilege('service_role',  'public.fn_name(...)', 'EXECUTE'), -- expect t
              has_function_privilege('authenticated', 'public.fn_name(...)', 'EXECUTE'), -- expect f
              has_function_privilege('anon',          'public.fn_name(...)', 'EXECUTE'); -- expect f

**Checking only the intended caller passes while the hole stays open.** That is the
entire failure mode. A verification that reads `service_role => true` and stops has
proved nothing about who else can call it.

Grant only the roles that actually call the function:
  service_role   → when a route owns the auth gate (most SECURITY DEFINER functions)
  authenticated  → only when RLS policies or client-visible routes call it directly
  pg_cron        → only for scheduled functions not accessible via REST
                   (a pg_cron job that POSTs to an HTTP route does NOT need this)

To audit the whole database for this class at any time:

    SELECT p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
       AND has_function_privilege('anon', p.oid, 'EXECUTE');

Expected: zero rows.

**The 2026-08-24 incident.** The job_queue migration revoked FROM PUBLIC on eight
SECURITY DEFINER functions and granted service_role. The verification step showed
anon and authenticated STILL holding EXECUTE on all eight. The stored ACL read:

    claim_jobs: postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres

For about four minutes, holding only the public anon key, an unauthenticated caller
could have created jobs that spend real money on Apollo, Apify and Anthropic, claimed
another organisation's jobs, marked any job done or failed, or falsely stamped
spend_recorded_at. That last one is the worst: a job with spend recorded must never
call the paid API again, so a false stamp permanently kills real work. Nothing called
the functions yet, so no job existed to attack. Fixed in
20260824160500_job_queue_revoke_anon_authenticated.sql. Every other SECURITY DEFINER
function in the database was audited with the query above and none were affected.

### Rule: The same trap applies to TABLES. RLS is one layer, not the only one.

The rule above is written about FUNCTIONS. **Read it as being about GRANTS**, because
Supabase's ALTER DEFAULT PRIVILEGES on the public schema grants TABLES to anon and
authenticated too, not only function EXECUTE.

This is easy to get wrong in the reassuring direction, because the standard Supabase
advice for a service-only table is "enable RLS, add no policies", and that advice is
correct as far as it goes. RLS with zero policies genuinely denies every row to anon.
What it does not do is remove the GRANT sitting underneath it.

**The 2026-08-25 incident.** verification_calls, the ledger recording every PAID email
verification call, was created with RLS enabled and no policies. That was verified to
work: as anon, with a live row present, the table returned 0 rows. The check used
BEGIN ... ROLLBACK so the probe row was never committed. Then the privilege was read
back directly:

    has_table_privilege('anon', 'public.verification_calls', 'SELECT')   ->  true

RLS was the ONLY thing standing between an unauthenticated caller and the spend ledger.
Nothing was exposed, because RLS held. But a single later migration adding a permissive
policy, or disabling RLS to debug something, would have opened it with no second layer
and nothing to say so.

So for every new table that is service-role only:

  1. Enable RLS. This is what actually protects the rows today.
  2. REVOKE the roles BY NAME anyway, and grant the real caller back:

       REVOKE ALL ON TABLE public.table_name FROM anon, authenticated;
       GRANT ALL ON TABLE public.table_name TO service_role;

  3. VERIFY in BOTH directions, the roles that must NOT have it as well as the one
     that must:

       SELECT has_table_privilege('service_role',  'public.table_name', 'SELECT'), -- t
              has_table_privilege('anon',          'public.table_name', 'SELECT'), -- f
              has_table_privilege('authenticated', 'public.table_name', 'SELECT'); -- f

To audit every table in the database for this class:

    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND has_table_privilege('anon', c.oid, 'SELECT')
       AND NOT c.relrowsecurity;

Any row there is a table anon can read outright. A table with RLS on is protected today
but still worth revoking, per the incident above.

### Rule: THAT QUERY IS NOT ENOUGH EITHER. A VIEW BYPASSES RLS AND THE QUERY CANNOT SEE IT.

Read this immediately after the query above, because the query above is the one that has
been giving false reassurance.

`relkind = 'r'` means ORDINARY TABLES. A view is `'v'` and a materialised view is `'m'`.
So that audit has never once looked at a view, and it has been returning zero rows,
reassuringly, since the day it was written.

**Views are worse than tables here, not better.** A Postgres view executes with the
privileges of its OWNER unless it is created with `security_invoker = true`. Every view in
this database is owned by `postgres`. So an anon-readable view over a table that anon
cannot read **hands anon the contents of that table anyway, through the view**, and RLS on
the base table is never consulted, because the query is not running as the caller.

That means a view can undo a table's protection completely while the table's own
privileges still read back as correctly locked down.

**The 2026-08-26 finding, stated as measured rather than as first reported.**

The bypass is real and was demonstrated end to end:

    -- as anon, reading the TABLE directly: RLS holds
    SELECT count(*) FROM public.cron_heartbeats;   ->  0 rows

    -- as anon, reading a VIEW over the same table: RLS is never consulted
    SELECT * FROM public.mon_019;                  ->  returns data

Nine `mon_*` views (001, 002, 003, 004, 005, 007, 010, 019, 020) are anon-readable,
owned by `postgres`, `security_invoker = false`, and each selects from `cron_heartbeats`,
which has RLS enabled and denies anon directly. What leaks is operational telemetry:
which scheduled jobs exist, when each last ran, whether it is failing, and the free-text
detail line with its counts. No client data, no organisation data, no prospect data.

`client_organisation_view` was ALSO anon-readable and `security_invoker = false`, and it
selects id, name, slug, contract_start_date, pipeline_unlocked, pipeline_unlock_at,
meetings_count, created_at and updated_at from `organisations`. It was initially reported
as exposing all of that for every organisation. **It does not, and checking rather than
acting on the report is the point of this entry.** Its definition ends
`WHERE id = get_my_organisation_id()`, so it self-scopes to the caller's own
organisation, and `get_my_organisation_id()` is SECURITY DEFINER with EXECUTE denied to
anon. Measured: an anon read of that view fails outright with
`42501 permission denied for function get_my_organisation_id`. It also fails closed if
that ever changes, because the function returns `organisation_id FROM users WHERE id =
auth.uid()`, and `auth.uid()` is NULL for anon, so the predicate becomes `id = NULL` and
matches nothing.

So the severity ran the opposite way to the initial report: the harmless-looking
monitoring views are the ones actually bypassing RLS, and the alarming-looking client
view is self-scoped and denied. Both facts came from running the query as anon rather
than from reading the grants.

The correct pattern already existed in the same database: `client_prospects_view` has
`security_invoker = true` and denies anon. So this was never a policy decision in either
direction. Grants and options were whatever the default was on the day each view happened
to be created, and the audit could not see the difference.

### Rule: THAT QUERY WAS STILL WRONG. IT READ ONE PRIVILEGE OUT OF EIGHT.

The version above was corrected once, for `relkind = 'r'`, and it stayed wrong in a second
way for another day: **it asked who could SELECT and never asked who could WRITE.**

That is not hypothetical. `client_organisation_view` appeared in its output on 2026-08-26,
was reasoned about carefully on the read path, and was cleared. It was auto-updatable,
owner-executing, and `anon` and `authenticated` both held the full `arwdDxtm` default on
it, so a signed-in client could UPDATE their own organisation row through the view,
including `pipeline_unlocked`, the operator-controlled phased unlock. See ADR-039, which
measured that write succeeding. **The write grants were invisible to the query that was
looking for problems.**

So this is the third time one shape has cost real time here: the `relkind = 'r'` filter,
the monitor sweep's parallel arrays, and now a privilege list with seven omissions.

**The audit query, corrected again. Use this one. It reads all eight privileges.**

    SELECT c.relname,
           c.relkind,
           pg_get_userbyid(c.relowner) AS owner,
           COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
                      WHERE option_name = 'security_invoker'), 'false') AS security_invoker,
           c.relrowsecurity AS rls,
           who.rolname AS role,
           string_agg(p.priv, ',' ORDER BY p.priv) AS held
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (SELECT unnest(ARRAY['anon','authenticated']) AS rolname) who
      CROSS JOIN (SELECT unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE',
                                      'TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) AS priv) p
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'v', 'm')
       AND has_table_privilege(who.rolname, c.oid, p.priv)
     GROUP BY c.relname, c.relkind, c.relowner, c.reloptions, c.relrowsecurity, who.rolname
     ORDER BY c.relkind, c.relname, who.rolname;

`MAINTAIN` is Postgres 17 and is in the list for the same reason the other six are: a
partial list is exactly how the last two misses happened. To read the privilege back for
ONE relation after changing it, which the rules above require in both directions, ask for
each privilege as its own column rather than aggregating.

Read every row:

  - **table, RLS on** — intended. RLS is the gate. Note that the grant underneath it is
    the Supabase default and RLS is therefore the ONLY layer.
  - **table, RLS off** — an outright read and write of every row.
  - **view or matview, `security_invoker` not true** — RLS on the base tables is never
    consulted. Any privilege here is the whole of the protection, and a write privilege
    is a write path straight past RLS.
  - **view, `security_invoker = true`, anything beyond SELECT** — the predicate constrains
    WHICH ROWS, only the grant constrains WHAT OPERATIONS. A read-only view gets SELECT
    and nothing else. ADR-039.

**AND NOW IT RUNS WITHOUT BEING REMEMBERED. See MON-024.** A query in a markdown file is
not a control, for the same reason the commit gate had to become a hook on 2026-08-27: it
fires only when someone thinks to run it, and the two misses above both happened while
this section already existed. `mon_024` applies the four rules above against the live
catalog on every monitor sweep, and returns UNKNOWN rather than OK when it finds no
relations to evaluate, because every one of those rules passes vacuously over an empty set.

Keep the query here anyway. It is what you run when you want the full list rather than a
verdict, and MON-024's detail line names only the first failing class.

**Why this is in the security section and not in a backlog file.** The bug was not in the
database. It was IN THE AUDIT. A check that runs, returns zero rows, and cannot see the
class it was written to find is the same shape as the opt-out footer that was validated and
then discarded, and as the monitor sweep whose loop was bounded by the shorter of two
arrays. When a check is the thing that is wrong, nothing downstream of it can notice.

**The generalisation, which is the part worth carrying:** the mistake in both the
2026-06-05, 2026-08-24 and 2026-08-25 incidents is identical, and it is not about
functions or tables. It is ASSUMING THE EFFECT OF A GRANT INSTEAD OF READING IT BACK.
Whenever a migration changes who can reach something, read the privilege back for every
role that matters, in both directions, before committing.

### Rule: Every REVOKE ships with explicit GRANTs to each legitimate caller

The other direction of the same discipline. A REVOKE that forgets to grant the real
caller back breaks the feature silently.

Never REVOKE and commit without verifying callers. The 2026-06-05 incident: a May
security-audit REVOKE removed PUBLIC access to approve_document_suggestion without
granting service_role back. Every UI Approve click silently failed for days until
the Postgres error log was checked directly.

Both incidents have the same root cause: a grant change was made and its effect was
assumed rather than read back. has_function_privilege is the read-back, and it must
cover every role that matters, in both directions.

### Rule: Diagnostics on side-effecting functions use BEGIN ... ROLLBACK

Never call a side-effecting Postgres function with a bare SELECT to "see what it does."
SELECT fn() commits if the function has side effects (inserts, updates, deletes).
Wrap in an explicit transaction and roll back:

  BEGIN;
  SELECT fn(arg1, arg2);
  ROLLBACK;

Omitting the ROLLBACK is the same as committing. The 2026-06-05 incident: a SELECT
approve_document_suggestion(...) called as a diagnostic committed the approval and
bypassed the UI verification the operator had asked to perform themselves.

---

## When something breaks

1. Read the Sentry error. It says exactly what broke and where.
2. Check the relevant /docs file. It explains what the component connects to.
3. Explain to Doug in plain English what happened before suggesting anything.
4. Make one targeted change. Test. Commit if it resolves the issue.
5. If stuck: open claude.ai, share the Sentry error, the relevant /docs section,
   and the relevant /prd section. That context is enough to diagnose almost anything.

The /docs and /prd folders exist specifically for recovery.
Update them every session so they are useful when needed most.

---

## Code behaviour principles

Behavioral guidelines to reduce common LLM coding mistakes.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

## Deterministic code first — LLM only when judgment is required

See ADR-018.

When introducing any new component, state explicitly whether it is deterministic
code or uses an LLM call. Default: deterministic. An LLM must be justified by a
specific judgment or synthesis requirement that rules cannot meet at acceptable
quality.

Use LLMs for: creative synthesis (document generation, prospect research triggers,
reply classification, generated copy critique).

Use deterministic code for: counting, filtering, routing, threshold evaluation,
scheduling, pattern matching on predictable text.

When in doubt, build the deterministic version first. It is almost always cheaper
and faster to add an LLM layer later than to simplify an LLM-dependent system.

---

## ADR reference list — as of September 2026

For quick reference. Full text in /docs/ADR.md.

  ADR-001  Tool-agnostic capability registry over direct integrations
  ADR-002  Suggestion queue over autonomous document updates
  ADR-003  Agent isolation enforced at three levels (RLS + app filter + prompt)
  ADR-004  Taplio as publishing layer only, dashboard as approval layer
  ADR-005  No LinkedIn scraping in prospect research
  ADR-006  Lemlist for LinkedIn DMs, not La Growth Machine
  ADR-007  Reply handling automated for positive replies only in Phase 1
  ADR-008  Pipeline view hidden for first two months
  ADR-009  MargenticOS runs as client zero before any paying clients
  ADR-010  Taplio integration is dashboard content delivery, not scheduling API
  ADR-011  Signal threshold logic and A/B testing deferred to Phase 2
  ADR-012  Messaging agent writes one document_suggestions row with full_document replacement
  ADR-013  Model version selection for agents
  ADR-014  Multi-variant template rotation now, per-prospect generation future
  ADR-015  ICP Filter Specification and tool-agnostic sourcing
  ADR-016  TAM gate and inventory-driven sourcing
  ADR-017  Tiered enrichment and sending routing
  ADR-018  Deterministic code vs LLM usage principles
  ADR-027  Two-client pattern for SSR routes (sessionClient + serviceClient)
  ADR-028  Code validators as hard gates on LLM output; prompt instructions advisory only
  ADR-029  Durable job queue in its own table; agent_runs stays the history
  ADR-030  Client reply view: org-scoping RLS-backed, intent-filtering chokepoint-enforced
           (renumbered from a duplicate ADR-026 on 2026-08-24)
  ADR-031  Two-pass email verification; send eligibility resolved by one shared function
  ADR-032  Sourcing filter hardcoded in the handler; both location axes constrained
  ADR-033  Research synthesis on the Batch API, split into research_sources +
           research_collect with the intermediate state in synthesis_batch_entries
  ADR-034  Send eligibility is evaluated once at verification and frozen on the row;
           changing EXCLUDED_COUNTRIES is NOT retroactive, and our gates govern
           UPLOAD, not delivery
  ADR-049  Suppression reaches the sending tool through can_suppress_contact, by interest
           status rather than delete or the workspace blocklist, and MON-026 reconciles
           against the PROVIDER rather than against our own suppression columns
  ADR-038  A rejection note is carried into the run that replaces the rejected
           suggestion; the note must reach the AGENT, not just a column
  ADR-039  A client-facing view runs as the CALLER, and the GRANT is the control
  ADR-040 to ADR-046  see /docs/ADR.md; this list was five entries behind the file
           until 2026-09-03, which is how ADR-047 was nearly filed as ADR-039
  ADR-047  Client approval on strategy documents removed; a document is live because
           an operator produced it. Every version kept and restorable. An upstream
           change FLAGS downstream documents stale and never regenerates them
  ADR-046  Buyer criterion derived per client from their own documents, applied before
           enrichment through one shared selector; it is NOT the provider seniority filter
  ADR-035  A four-state sending-health verdict collapsed onto the sweep's three states;
           insufficient_sends maps to OK deliberately, because a state whose resting
           value would be UNKNOWN makes the check born dark
  ADR-036  The 5-20 headcount narrowing is a stopgap, and the 21-50 band is declared
           but not sourced
  ADR-037  A tiering verdict is frozen on the row; ONLY a new ICP filter spec
           re-queues removed prospects, and the re-queue count logs at warn
  ADR-038  An operator's rejection note is an instruction to the next run, not an
           audit record; both it and the client's revision note travel to the agent,
           and the rejection note wins on conflict
  ADR-039  A client-facing view runs as the CALLER, and the GRANT is the control;
           the predicate constrains which rows, only the grant constrains what
           operations, so a read-only view gets SELECT and nothing else

---

## PRD section reference list — as of April 2026

  01-product.md         Target client, offer, commercial model
  02-stack.md           Technology stack, tool registry pattern
  03-data-model.md      All database tables, fields, RLS policies
  04-auth.md            Authentication, roles, multi-user access
  05-intake.md          Questionnaire, file upload, website ingestion
  06-agents.md          All agents: purpose, inputs, outputs, isolation
  07-feedback-loop.md   Signal thresholds, suggestion queue, A/B testing
  08-approval.md        Channel modes, notification timing, batch sampling
  09-reply-handling.md  Reply types, routing, escalation, opt-out
  10-signals.md         Signal types, processing, pattern library
  11-warnings.md        Warning types, thresholds, tiered response protocol
  12-dashboard.md       All views, components, phased unlock
  13-integrations.md    Registry pattern, each tool, webhook events, setup
  14-phasing.md         Phase one through four with deliverables
  15-sourcing.md        Prospect sourcing pipeline (new, April 2026)
