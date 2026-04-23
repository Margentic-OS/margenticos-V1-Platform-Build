# BACKLOG.md — MargenticOS deferred items and follow-ups
# Started April 2026
#
# Purpose: single source of truth for things to remember across sessions.
# This file captures items that have been consciously deferred, partially built,
# or flagged for future attention — but are not yet ADRs or formal spec items.
#
# Every Claude Code session must read this file at the start.
# Before ending any session, any item the session deferred must be added here.
#
# Format per entry:
#   ## Category header
#   - [tag] Item (date flagged / session reference if useful)
#   Notes / context / next action
#
# Tags:
#   [phase2]     deferred to Phase 2 by current architecture
#   [phase3]     deferred to Phase 3
#   [pre-c0]     must resolve before client zero goes live
#   [pre-c1]     must resolve before first paying client onboards
#   [monitor]    built minimal, needs to grow as usage demands
#   [research]   needs research before building
#   [post-build] post-build housekeeping
#   [commercial] commercial / legal / operational (not a build item)

---

## Pre-client-zero gates (must resolve before MargenticOS runs live campaigns)

- [pre-c1] Haiku critic pass agent for document suggestion quality review
  Not yet built. Required before first paying client's suggestions reach the approval queue.
  Structured evaluation: TOV compliance, messaging rules, quality floor.
  During client zero (Doug), suggestion quality can be judged manually.
  Also a prerequisite for unlocking Option D (per-prospect generated sequences) per ADR-014.

- [pre-c0] ICP filter spec validated against MargenticOS's own ICP (dogfood check)
  Run the extended ICP agent against MargenticOS's intake. Verify the spec it produces
  matches what Doug would have hand-built. If not, iterate the agent prompt before
  running against paying clients.

- [pre-c0] TAM report validated against MargenticOS's own TAM
  Confirm classification lands correctly. If MargenticOS's own ICP lands as red,
  investigate spec quality before trusting the gate on paying clients.

- [pre-c0] Sending infrastructure provisioned for MargenticOS
  2+ domains purchased, SPF/DKIM/DMARC configured, 6 mailboxes created,
  warming running for 2–3 weeks minimum before live sends.
  Runbook: /docs/runbooks/sending-setup.md

- [pre-c1] Lemlist API capabilities verified before LinkedIn DM build starts
  Verify endpoint availability, rate limits, webhook support against live docs.
  LinkedIn DMs not in scope for client zero campaign — verify before first paying client onboards.

- [DONE 2026-04-22] Verify RLS policies on all 11 base tables beyond agent_runs
  Audited all 11 base tables against ADR-003's three-level enforcement requirement.
  Three issues found and fixed:

  (1) organisations table was missing a client SELECT policy — clients couldn't
  read their own org row. Added `clients_read_own_organisation` policy
  (SELECT, authenticated, id = get_my_organisation_id()). Both operator ALL
  and client SELECT policies now present.

  (2) patterns table had no INSERT/UPDATE/DELETE policies — service_role
  bypasses RLS as intended, but no belt-and-braces block on authenticated
  callers. Added three restrictive policies: authenticated_cannot_insert_patterns,
  authenticated_cannot_update_patterns, authenticated_cannot_delete_patterns.
  All evaluate to false for authenticated callers; pattern aggregation agent
  (service_role) continues to bypass as designed.

  (3) strategy_documents status='active' filter confirmed intentional — no change.

  Application-layer note added separately: queries against organisations must
  never SELECT payment_status, contract_status, or engagement_month for client
  views — these are operator-only columns even though the row is visible.

- [DONE 2026-04-22] fetchICPPainProxy in prospect-research-agent.ts — two bugs fixed.
  Bug 1: function queried strategy_documents with status='approved', which is not a valid
  status value (valid: draft/active/archived). Caused function to return empty on every call,
  silently bypassing the ICP data path entirely. Fixed: status='active'.
  Bug 2: hardcoded absolute fallback strings contained consulting/founder-led language,
  violating CLAUDE.md industry-agnosticism. Fixed: replaced with role+company-only copy
  that makes no assumptions about company structure, growth stage, or leadership model.
  Original BACKLOG entry said "undefined function" — the function was defined but silently
  broken. Apollo 403 masked the failure because Step 1 never reached Step 4.

- [pre-c0] Replace TODO placeholders in AgentActivityView and SignalsLogView
  Both views contain placeholder data, not real queries. Required for operator
  visibility before client zero campaigns go live.

- [pre-c0] Build the warnings engine backend
  WarningsRail.tsx exists with placeholder data. No threshold evaluation logic
  exists. Build before client zero — without this, deliverability incidents and
  meeting quality issues go silent.

- [pre-c0] Build the signal processing agent
  Table and processed field exist. No agent file. No webhook routes. Build
  before client zero — without this, no signals flow through the system.

- [phase2] Build the pattern aggregation agent
  ADR-011 already defers signal threshold logic and A/B testing to Phase 2.
  Aggregation agent feeds those systems — if the consumers are Phase 2, the producer is too.
  Sparse data during client zero makes this meaningless to run. Build when signal volume justifies it.

- [DONE 2026-04-23] Build a scheduler for auto-approve timers
  Vercel Cron, hourly schedule (0 * * * *). POST /api/cron/auto-approve,
  protected by CRON_SECRET bearer token. Fetches pending suggestions joined
  to organisations.auto_approve_window_hours (default 72, per-client configurable).
  Calls approve_document_suggestion RPC per due suggestion. Per-suggestion error
  isolation — one failure does not abort the batch. Already-handled suggestions
  (operator approved between query and RPC) skip cleanly without logging a false error.
  SYSTEM_AUTO_APPROVE_ID sentinel in reviewed_by identifies auto-approvals in DB.
  Migration: auto_approve_window_hours added to organisations table. CRON_SECRET
  added to Vercel env vars (Production + Preview).

- [DONE 2026-04-22] Install Resend and wire transactional emails.
  resend SDK installed. Single client instance in src/lib/email/client.ts.
  Generic sendTransactionalEmail() in src/lib/email/send.ts — Sentry-logged failures,
  dev-only onboarding@resend.dev fallback, throws at load in non-dev if RESEND_FROM_EMAIL missing.
  Test route at /api/resend-test (dev-gated). Verified: email delivered to doug@margenticos.com inbox.
  Sending domain: notifications.margenticos.com (Resend EU). Templates deferred until features need them.

- [DONE 2026-04-22] Wire Sentry for error monitoring. Commits 99e8b03, 9547d18.
  @sentry/nextjs v10 installed. EU region confirmed (.ingest.de.sentry.io). Server, client,
  and edge configs created. instrumentation.ts wired with register() + onRequestError hook.
  PII scrubber added (beforeSend strips email, token, secret, linkedin, icp, intake fields).
  Test endpoint at /api/sentry-test (dev-gated, permanent). Confirmed live: MARGENTICOS-1.

- [DONE 2026-04-22] Set up three-environment Git branching and Vercel multi-env deploy
  staging branch created and pushed. Branch protection on main active (PR required,
  0 required approvers, no force pushes, no deletions). Repo transferred from
  personal MargenticOS account to Margentic-OS org (Team plan). Vercel project
  margenticos-platform linked to repo. 11 env vars set in Production scope
  (including NEXT_PUBLIC_APP_URL=https://margenticos-platform.vercel.app).
  10 env vars set in Preview scope (NEXT_PUBLIC_APP_URL omitted — VERCEL_URL fallback).
  First production deploy confirmed Ready (57s build). Repo temporarily public
  (Hobby plan limitation — see Active temporary states in CLAUDE.md).
  3F end-to-end verification (feature branch preview + staging merge test) pending
  first real use — verify on next feature branch push.

- [DONE 2026-04-22] Implement NEXT_PUBLIC_APP_URL fallback to VERCEL_URL in code
  Created src/lib/urls/app-url.ts with getAppUrl() — priority: NEXT_PUBLIC_APP_URL,
  then https://VERCEL_URL, then http://localhost:3000. One usage site updated:
  src/app/login/actions.ts:23. Dev-only check route at /api/app-url-check (returns
  404 on Vercel production, live on preview + local). Verified locally: returns
  http://localhost:3000 as expected.
  Post-commit: hit /api/app-url-check on next preview deploy to confirm
  VERCEL_URL fallback returns the correct preview URL.

- [pre-c0] Build intake file upload (Supabase Storage)
  Intake questionnaire works but file upload for writing samples is missing.
  TOV agent needs writing samples to do its job well.

- [pre-c0] Build intake website URL ingestion
  Website fetch for homepage + 3 inner pages missing. ICP/Positioning agents
  expect this context.

---

## Pre-client-zero critical path (dependency map)
# Last updated: 2026-04-23

Remaining [pre-c0] items in dependency order. Items at the same level can run in parallel.

### Layer 0 — no dependencies, can start immediately (parallel)

**Sending infrastructure** (~4–6 hrs over 2–3 weeks elapsed time)
  Depends on: nothing
  Blocks: everything live — no sends happen without domains warmed
  Note: clock starts now; 2–3 week warming period is elapsed time, not build time.
  Build time is ~2 hrs (domain purchase, DNS config, Instantly mailbox setup).

**Intake file upload** (~1–2 hrs)
  Depends on: nothing (Supabase Storage, standalone feature)
  Blocks: TOV agent gets writing samples → better document quality for ICP filter dogfood + TAM

**Intake website URL ingestion** (~1–2 hrs)
  Depends on: nothing (fetch + extract, standalone feature)
  Blocks: ICP/Positioning agents get homepage context → better document quality for dogfood runs

**Replace TODO placeholders — AgentActivityView + SignalsLogView** (~2–3 hrs)
  Depends on: nothing (UI wiring to existing Supabase tables)
  Blocks: operator visibility during client zero

### Layer 1 — depends on intake being complete (parallel after Layer 0)

**ICP filter spec dogfood check** (~1–2 hrs)
  Depends on: intake file upload + website ingestion (richer input = meaningful dogfood)
  Blocks: TAM report dogfood (TAM gate reads the ICP filter spec)

**Build the signal processing agent** (~4–6 hrs)
  Depends on: nothing structural, but meaningless without campaigns running
  Blocks: warnings engine (warnings evaluate signals); auto-approve scheduler (timer fires,
  Resend sends notification — signals are the feedback that makes this worth running)

### Layer 2 — depends on Layer 1

**TAM report validated against MargenticOS's own TAM** (~1 hr)
  Depends on: ICP filter spec dogfood (TAM gate consumes the filter spec)
  Blocks: sourcing pipeline confidence — if TAM gate misfires, prospect sourcing is unreliable

**Build the warnings engine backend** (~3–4 hrs)
  Depends on: signal processing agent (warnings evaluate processed signals)
  Blocks: client zero campaigns run with silent deliverability risk if this is missing

**Build auto-approve scheduler** (~1 hr — Vercel Cron, bounded task)
  Depends on: signal processing agent (scheduler fires → Resend notification → signals flow)
  Blocks: autonomous loop validation — client zero purpose is proving the end-to-end loop

### Critical path (longest chain)

Intake file upload + website ingestion
  → ICP filter spec dogfood
  → TAM report dogfood

Signal processing agent
  → warnings engine backend
  → auto-approve scheduler

Both chains can run in parallel. Sending infrastructure warming runs concurrently with all of it.

### Total build-time estimate (excluding warming elapsed time)

  Layer 0 (parallel): ~7–11 hrs across 4 workstreams
  Layer 1 (parallel): ~5–8 hrs across 2 workstreams
  Layer 2 (parallel): ~5–7 hrs across 3 workstreams
  ─────────────────────────────────────────────────
  Sequential minimum: ~17–26 hrs build time
  With parallelism:   ~15–22 hrs build time (limited by longest chain)
  Plus 2–3 weeks elapsed for domain warming — the true wall-clock constraint.

---

## Pre-first-paying-client gates

- [pre-c1] Buyer self-descriptor field added to intake questionnaire
  Currently messaging agent defaults to "founders" as the peer-pattern descriptor.
  Before first non-consulting client onboards, add intake field capturing how the
  client's buyers refer to themselves (founder / VP Sales / operations director / etc).
  ICP agent extracts as buyer_self_descriptor; all downstream agents use this
  instead of defaulting to "founder."

- [pre-c1] Lean Marketing conflict of interest resolved
  Doug contracts at Lean Marketing selling to the same buyer profile.
  Read contractor agreement, decide how to handle prospect overlap between
  MargenticOS and Lean Marketing pipelines, make conscious commercial separation.
  Not a build issue. Timing issue.

- [pre-c1] gstack security audit after full build complete
  Install gstack (https://github.com/garrytan/gstack).
  Run /cso security audit.
  Run /design-review on client-facing dashboard.
  Run /qa on staging URL.

- [pre-c1] Apollo paid plan activated (Basic minimum, Professional preferred)
  Apollo free plan returns 403 on people/match endpoint.
  Step 1 of prospect research agent non-functional until paid plan active.
  Also affects post-intake TAM report (uses People API Search which is free,
  but enrichment for Tier 1/2 prospects requires credits).

- [pre-c1] Configure Calendly Routing Forms per client at onboarding
  Three screening questions: business email (blocks personal domains), company
  headcount dropdown (confirms firmographic fit live, catches stale Apollo data),
  short free-text on interest reason. Route qualified → booking page. Route
  disqualified → nurture thank-you page. ~15 min per client at onboarding.
  Biggest single lever for perceived meeting quality. Industry-standard among
  premium agencies (Beanstalk-tier 60-70% positive-reply-to-qualified conversion).

---

## Monitor-and-expand (built minimal, needs to grow)

- [monitor] ICPFilterSpec v1 (13 filter fields + meta)
  Started minimal per ADR-015. Watch across first 3 founding clients.
  Signal-based fields (intent, hiring signals, technographic changes) deferred —
  add when a client genuinely needs them. Do not add speculatively.

- [monitor] Apollo supported_fields manifest
  Built for the 13 v1 fields. When signal-based fields are added to the spec,
  the manifest must be updated.

- [monitor] Canonical industry taxonomy (NAICS-derived)
  Built as a reference translation table. When a new industry appears that isn't
  in the table, add it rather than using tool-specific names ad-hoc.

- [monitor] TAM report thresholds (4-month red, 4–6 amber, 6+ green)
  Calibrated against pessimistic conversion assumptions. After client zero produces
  real conversion data, recalibrate if needed.

- [monitor] Send velocity per client (organisations.send_velocity_per_day)
  Set manually at onboarding based on mailbox count and send limits.
  Will need programmatic recalculation as mailboxes warm up and ramp sends.

---

## Messaging audit items (from April 2026 audit)

Revisit once prospect research agent is built and full outbound cycle is working end-to-end:

- [monitor] Email 3 had 0:1 you/we pronoun ratio
  Consider prompt rule + post-processor check.

- [monitor] Email 1 has dashboard feature copy too early
  Test moving to Email 3.

- [monitor] A/B test queue for CTA variants on Emails 1 and 3
  Parked until A/B infrastructure is live (Phase 2).

- [monitor] Prompt passes banned-vocabulary tests cleanly
  Iterate, don't rebuild when debating later.

- [monitor] Deliberate grammatical imperfections as an A/B test variant
  Lowercase sentence starts, missing terminal full stops, ~1–3 instances per
  4-email sequence. Parked during build to avoid guessing impact on reply rates.
  Test with real data post-client-zero once A/B infrastructure is live.

---

## Post-build tasks

- [post-build] Context7 MCP integration
  Add after full build is complete. Not urgent.

- [post-build] Review Phase 1 implementation against ADR-018 (LLM vs deterministic)
  After client zero goes live, identify:
    - Any LLM calls that could be downgraded to rules
    - Any rules producing edge-case failures that justify LLM layers

- [post-build] Normalise messaging storage to { emails: [...] } envelope
  Currently messaging content in strategy_documents is stored as a bare JSON array
  while all other document types are objects (per ADR-012). Defer database migration
  until post-client-zero.

---

## Post-Tier-1 items

- [post-tier1] Configure custom domain (app.margenticos.com) on Vercel project
  Requires CNAME record in Netlify DNS pointing to cname.vercel-dns.com,
  add domain in Vercel project settings, update NEXT_PUBLIC_APP_URL in
  Production scope to https://app.margenticos.com. Budget: 15 min.
  Non-urgent — margenticos-platform.vercel.app works fine until then.

- [post-tier1] Flip repo to private + upgrade Vercel to Pro ($20/month)
  Trigger: First signed paying-client contract OR first founding-client public
  testimonial naming the platform, whichever comes first.
  Required steps: (a) upgrade Vercel project to Pro before flipping repo,
  (b) flip repo to private on GitHub, (c) verify deploys still work,
  (d) re-run env var audit to confirm nothing leaked during the public period.
  Budget: 30 minutes.

- [post-tier1] Custom staging subdomain (staging.margenticos.com)
  Replace default Vercel preview URL for cleaner internal sharing with Rui or
  founding clients. Not needed until staging URL is being handed to external parties.

- [post-tier1] Consolidate remaining repos under Margentic-OS org
  The following repos remain under the personal MargenticOS account:
  website-test, sales-intel, margenticos-landing, biaog.
  Review which are still live. Archive dead ones. Transfer live ones to the org.
  Non-urgent but keeps GitHub structure aligned with the business entity on Team plan.

---

## Phase 2 deferred items (from ADR-011, ADR-013, ADR-014, ADR-015, ADR-017)

- [phase2] Split Supabase into dev/staging/prod projects when client count justifies data isolation
  Target trigger: 3+ paying clients with production data. Currently using single
  project for all environments. Flagged 2026-04-22.

- [phase2] Add Vercel build status check to required_status_checks on main branch protection
  Once Vercel's GitHub Check integration is confirmed working (i.e. a PR shows the
  Vercel check status), update branch protection via:
  gh api repos/Margentic-OS/margenticos-V1-Platform-Build/branches/main/protection
  with required_status_checks pointing to the Vercel check name. Flagged 2026-04-22.

- [phase2] Evaluate migration of long-running agents to Anthropic Managed Agents platform
  Agents: prospect research, messaging (currently run as Vercel serverless functions).
  Trigger: agents run longer than 2 minutes consistently, OR concurrent agent volume
  exceeds ~10+ concurrent runs, OR Managed Agents gains a feature requiring significant
  in-platform work to replicate.
  Decision point: re-evaluate at 5+ paying clients.
  Budget: 1-2 weeks to migrate, assuming the feature set has matured by then.

- [phase2] Signal threshold processing logic (3/5/10 tier evaluation)
- [phase2] A/B variant generation when 5-signal threshold crossed
- [phase2] Conflict resolution UI for competing document suggestions
- [phase2] Pattern aggregation agent running on schedule (not just manually)
- [phase2] Hunter.io integration activated (can_validate_email)
- [phase2] Instantly B2B Lead Finder handler built (activate when Apollo credit ceiling hit)
- [phase2] Signal-based ICPFilterSpec fields (intent, hiring, technographic change)
- [phase2] Clay handler evaluation (if sourcing scale demands it)
- [phase2] Option D (per-prospect generated sequences) — togglable mode per ADR-014
  Prerequisites: Haiku critic pass built, post-processor extended for generated
  sequences, generation prompt validated against quality bar.
- [phase2] Test messaging agent with claude-opus-4-6 + streaming on stable connection
  Currently on Sonnet 4.6 as local-dev workaround per ADR-013. Revert if Opus
  timeout issue is resolved on production infrastructure.

- [phase2] Human pre-call qualification protocol (Layer 3)
  Option A: Doug manually qualifies first 5-10 meetings per client to build
  intuition, then automate via reply handling agent.
  Option B: hire an SDR/ops person once volume justifies.
  Target: 60-70% positive-reply-to-qualified-held conversion (tier-1 agency benchmark).

- [phase2] Qualified meeting guarantee language in founding-client contracts
  Decide: replacement policy, credit policy, or noise-as-overhead.
  Industry norm: replacement or credit for unqualified meetings.

---

## Phase 3 deferred items

- [phase3] AI reply handling for information requests (with human override)
- [phase3] Nurture sequence automation for warm leads
- [phase3] Multi-campaign coordination per client
- [phase3] Sourcing infrastructure: evaluate Cognism / ZoomInfo / custom data
  pipeline as primary sourcing when client count and credit economics justify

---

## Commercial / operational items

- [commercial] Pricing model review as Phase 1 completes
  $500/month founding offer may be thin against pessimistic unit economics.
  Unit economics at 10 clients pessimistic needs sketching before pricing is
  finalised for non-founding clients. Doug's target: $3,000 setup + $2,500 retainer.

- [commercial] Vendor concentration risk — Instantly as sender + warming + possible
  future sourcing. If Instantly changes terms, pricing, or has an outage, multiple
  system functions affected simultaneously. Mitigation: tool-agnostic architecture
  means handlers are swappable, but migration under pressure is hard. Monitor.

- [commercial] Apollo credit ceiling at ~4 clients on Basic, ~8–10 on Professional
  Budget for Apollo Professional by client #3. Plan alternative (Instantly B2B
  Lead Finder, Clay) for when credit economics break down.

- [commercial] Sending infrastructure scaling
  At 10+ clients with 6 mailboxes each, sending infrastructure becomes a meaningful
  operator task. Consider Mailreef, Instantly's DFY, or similar managed service
  when client count justifies.

---

## Founding-client onboarding pre-flight checklist

Complete all items before the first paying client goes live:

- [ ] Flip GitHub repo from public to private
- [ ] Upgrade Vercel from Hobby to Pro
- [ ] Run gstack security audit (install: https://github.com/garrytan/gstack)
- [ ] Run /cso security audit command
- [ ] Run /design-review on client-facing dashboard
- [ ] Run /qa on staging URL
- [ ] Confirm all Calendly routing forms are configured per-client (Layer 3 qualification)
- [ ] Review Lean Marketing contractor agreement for conflict-of-interest resolution

---

## Lessons learned

- [lesson] Next.js 15 App Router does not propagate API route handler errors as
  unhandled exceptions. Sentry's default integration will not capture them.
  Fix: export `onRequestError` from instrumentation.ts using
  Sentry.captureRequestError (available in @sentry/nextjs v10+). This applies
  to every Next.js 15+ project; stock Sentry tutorials predating Next.js 15
  do not cover it. Took one diagnostic session to isolate.

---

## Application-layer notes

- [reminder] Application queries against organisations for client-facing views must never
  SELECT payment_status, contract_status, or engagement_month. RLS filters rows, not columns.
  App layer is responsible.
