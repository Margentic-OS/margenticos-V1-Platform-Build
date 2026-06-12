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

## Agent quality batch from dry-run rounds (DONE 2026-06-11)

- [DONE 2026-06-11] Agent prompt quality fixes from Simcare and 360dungarvan dry runs
  Commit: 2e49dcf — "agents: sector-complete taxonomy, unmatched-industry flag, grounding rule, pain balance, cold-email register clamp, doc framing"

  Issues found and fixed:
  1. 360dungarvan (Irish primary-school meals business) tagged as "Management Consulting" because
     CANONICAL_INDUSTRIES list contained only consulting categories. FIXED: Expanded list from 
     25 to 76 entries covering all NAICS sectors (education, healthcare, construction, manufacturing, 
     financial, retail, hospitality, logistics, tech, media, agriculture, energy, govt, non-profit).
     Agent now maps unmapped industries to unmatched_industries array with operator review flag.
     Commit: icp-filter-spec.ts, icp-agent.md (CHANGE 1-2).

  2. 360dungarvan's messaging cited "Green Flag" schools initiative that doesn't appear in intake,
     website, or research — model supplied it from world knowledge. FIXED: Added grounding rule
     to all 4 document-generation prompts (icp, positioning, tov, messaging). Any externally 
     verifiable third-party fact not in source materials must be listed in "Assumptions we have 
     made" section for operator confirmation (CHANGE 3).

  3. Simcare reported ICP and positioning over-focused on margin pain despite evidence of other
     dimensions. FIXED: Added pain-dimension breadth rule to ICP and positioning prompts. Documents
     must surface all pain dimensions (financial, time, operational, risk, growth, reputation, 
     compliance) that evidence supports, not just financial (CHANGE 4).

  4. Break-up email (Email 4) near-identical across variants A through D. FIXED: Added differentiation
     requirement. Email 4 now reflects same opening angle as Email 1 in each variant, keeping variants
     distinct while maintaining "this is the last email" message and permission-to-decline tone (CHANGE 6).

  5. Clients find strategy documents impressive but unsure what to do with them. FIXED: Added framing
     copy to dashboard: "The brain behind your campaigns. Review them to keep targeting sharp." Frames
     documents as what powers campaigns, not reference material (CHANGE 7).

  6. Highly formal TOV documents licensed overly formal cold emails. FIXED: Added channel-constraints
     clamp to messaging prompt. Cold email register (conversational, short sentences, sub-100 words)
     overrides brand formality. Client TOV expressed WITHIN constraints, not instead of them (CHANGE 5).

  Version bumps: icp-agent, positioning-agent, tov-agent, messaging-agent all updated to 2026-06-11
  with detailed changelog entries.

---

## Grounding propagation (DONE 2026-06-12)

- [DONE 2026-06-12] Upstream assumptions propagation into messaging document
  Commit: cf95798 — "agents: propagate upstream assumptions into messaging document"

  The grounding rule (Rule 9) added in the 2026-06-11 batch ensures messaging documents
  flag any external facts not in source materials. However, the upstream documents
  (ICP, positioning, TOV) may already have flagged assumptions. Messaging must carry
  forward those upstream assumptions, attributed to their source, if the messaging
  output relies on them.

  Implementation:
  1. Added UpstreamAssumption interface to track assumption origin (documentType field)
  2. New extractAssumptionsFromDocument() function parses "Assumptions we have made"
     sections from plain_text of each strategy document
  3. Extract upstream assumptions in main agent flow (Step 7, before Claude call)
  4. Pass upstream_assumptions through VariantGenerationContext to all variant generation
  5. Include upstream assumptions in prompt context with clear labeling
  6. Added Rule 10 to messaging-agent.md defining propagation semantics:
     - Carry forward only assumptions the messaging actually relies on
     - Attribute each to its source (ICP, Positioning, or TOV)
     - Avoid noise inheritance: do not copy unused assumptions
  7. Updated quality self-check with four verification points for assumptions

  Result: Complete audit trail of assumptions across the engagement. Client can see
  which external facts were verified at earlier stages vs which are new to the messaging.

---

## Benchmarks page (resolved and deferred items — 2026-05-05)

- [DONE 2026-05-05] Benchmarks page v1 shipped
  Four metrics: reply rate, meeting booking rate, bounce rate, positive reply rate.
  Migration: sent_count/replied_count/bounced_count/campaign_stats_updated_at on campaigns.
  Handler: fetchCampaignStats() calls /api/v2/campaigns/analytics (all campaigns, one call).
  Cron: campaign stats refresh loop added to instantly-poll after reply polling.
  Tier-1 constants: src/lib/benchmarks/tier1-benchmarks.ts — Instantly 2025 + Belkins 2025.
  Metric utility: src/lib/metrics/campaign-metrics.ts — orgId-scoped, no API calls.
  Page: src/app/dashboard/benchmarks/page.tsx — sidebar link now resolves.
  StatsRow reply rate: now reads real data from campaign-metrics utility.
  Commit: 0735a03.

- [pre-c0] Apply migration 20260505_campaigns_sent_count.sql to Supabase (2026-05-05)
  The migration adds sent_count, replied_count, bounced_count, campaign_stats_updated_at
  to the campaigns table. Must be applied before the Benchmarks page or StatsRow reply
  rate will error at runtime on the new columns.
  How to apply: Supabase dashboard → SQL Editor → paste migration contents → Run.
  Or via Supabase MCP: mcp__supabase__apply_migration.
  After applying, run npm run gen-types to regenerate src/types/database.ts from the
  live schema (the current database.ts was hand-patched to unblock TypeScript compilation).

- [monitor] Benchmark constants refresh cadence (2026-05-05)
  BENCHMARKS_LAST_UPDATED = 'May 2026' in src/lib/benchmarks/tier1-benchmarks.ts.
  Trigger for refresh: Instantly or Belkins publishes a new annual cold email report
  (typically Q1 each year). Check in January/February each year.
  When refreshing: update the data constants, the sourceCitation strings, and the
  BENCHMARKS_LAST_UPDATED export. No DB migration needed — Tier-1 is TypeScript constants.

- [phase2] Spam complaint rate — excluded from v1 Benchmarks page (2026-05-05)
  Not polled. The Instantly /api/v2/campaigns/analytics endpoint does not return
  spam complaints. Excluded from v1 as planned.
  Add when: a separate spam complaint source is identified, OR Instantly adds the
  field to their analytics endpoint.
  When adding: extend campaign-metrics.ts and BenchmarksView.tsx; no migration needed
  if sourced from the existing signals table (signal_type = 'spam_complaint').

- [phase2] Open rate — explicitly excluded from v1 (2026-05-05)
  Decision: unreliable since Apple Mail Privacy Protection (2021). Leading vendors
  have stopped reporting it as a primary metric. Excluded from client-facing page.
  If added in future: operator-warnings-rail only, never client-facing.

- [phase2] Tier-2/3 benchmark data from patterns table (2026-05-05)
  The Benchmarks page data fetch falls back through tier 2 → tier 1 when patterns
  are empty. Currently only tier 1 (TypeScript constants) is implemented.
  Tier 2/3 uses the existing patterns table with pattern_type = 'network_reply_rate'
  etc. No new table needed. Build when pattern aggregation agent ships.

---

## Dashboard / Operator UX gaps

- [DONE 2026-05-06] Pre-c1 cleanup batch 3 — 3 fixes in commit b356208
  Item 1: organisations.monthly_meetings_target — migration added, MomentumBlock now prop-driven,
    pipeline page fetches and passes column. DEFAULT 8 preserves current behaviour for existing rows.
  Item 2: organisations.setup_status — migration added (jsonb, DEFAULT pending/pending),
    DocumentsActiveState now data-driven from DB. Status values: pending/in_progress/complete.
  Item 3 (partial): SettingsView "configured directly in Instantly" → "configured in your email sending tool".
    WarningsRail lines 24/32 violations confirmed dead (strings not in current file — pre-build check).
  NOTE: migration 20260506_organisations_target_and_setup_status.sql must be applied to Supabase.
    How: Supabase dashboard → SQL Editor → paste migration → Run.
    Or via Supabase MCP: mcp__supabase__apply_migration.

- [pre-c1] ADR-001 string fixes deferred — WarningsRail/SettingsView.tsx (2026-05-06)
  WarningsRail.tsx lines 24/32: the "domain reputation in Instantly" and "email list hygiene in Apollo"
  strings are not in the current WarningsRail.tsx file at all. Pre-build check confirmed via grep.
  The audit item referred to a previous version of the file. No fix needed in WarningsRail.
  When WarningsRail is rebuilt with real warnings data (warnings engine, Phase 2/3), ensure any
  warning detail strings use tool-agnostic language ("your email tool", "your prospect tool").

- [DONE 2026-05-06] Pre-c1 cleanup batch — 14 fixes in commit 1b6ae3d
  Fix 1+2: Sidebar.tsx — removed Campaigns (pre-launch) and Approvals (not built) from client NAV_RESULTS.
    OperatorSidebar.tsx — removed Campaigns only; Approvals retained for operator.
  Fix 3: pipeline/page.tsx — removed PipelineApprovalBanner + orphaned suggestionsResult query.
  Fix 4: IntakeForm.tsx — Done button now navigates to /dashboard.
  Fix 5: IntakeForm.tsx — removed Wispr Flow product name from dictation nudge.
  Fix 6: login/?next= — threaded through magic link callback. Open redirect guard (must start with /).
  Fix 7: StatsRow reply rate — confirmed already wired. No change needed.
  Fix 8: Operator sidebar ?client= — DEFERRED to Batch 2. Confirmed as view-as-client scoping gap.
  Fix 9: activity/page.tsx — ADR-021 comment added above agent_runs cross-org query.
  Fix 10: substitute-calendly.ts → substitute-booking-link.ts (tool-agnostic rename). One import updated.
  Fix 11: /ADR.md deleted from repo root. /docs/ADR.md is canonical.
  Fix 12: ADR-021 comment added to all four agent trigger routes (icp, tov, positioning, messaging).
  Fix 13: OperatorTopbar — "DP" replaced with initials derived from userEmail prop. All 5 pages updated.
  Fix 14: src/app/dashboard/error.tsx — Next.js error boundary added for dashboard layout.

## View-as-Client — [DONE 2026-06-02]

Page-level scoping works correctly via searchParams.client. Layout-level scoping
(banner, sidebar VIEWING text) does not work in current Next.js 15/16 + Vercel +
Supabase SSR environment despite multiple architectural approaches:

- Custom request header injection (x-view-as-client) — header doesn't propagate to
  layout's headers() call despite x-pathname propagating via the same mechanism.
  Root cause not identified after multiple debug cycles.
- Cookie-based propagation — same outcome, layout's cookies().get() returned undefined
  despite cookie being set on response.
- Cookie sync (request.cookies.set + response.cookies.set per Supabase SSR pattern) —
  same outcome.
- Cookie header injection into requestHeaders before NextResponse.next() — same outcome.

Each approach was diagnostically logged in production and verified via Vercel logs.
The diagnostic logs consistently showed the layout receiving null/undefined for the
view-as-client value while page-level resolution via searchParams worked correctly.

**Resolved 2026-06-02:** The working approach was not server-side propagation at all.
`resolveViewingOrg` (operator-gated) scopes page data to the selected client.
`appendClientParam` carries `?client=` through every nav link so the param survives
navigation. The VIEWING label (OperatorSidebar) and amber banner (OperatorViewingBanner)
are both client components reading `useSearchParams()` directly — no layout-level
propagation needed. ADR-022 closed.

## Operator ergonomics batch — [DONE 2026-06-12]

Three operator usability improvements shipped as a single commit:

- **Item 1: Per-client approvals filtering**
  Approvals page now accepts ?client= query param. Uses resolveViewingOrg to scope
  suggestions to a single client when filtered. Filter indicator shows which client
  is selected with a one-click "Clear filter" button. Entry point from client detail
  page: View Approvals button now links to approvals pre-filtered to that client.
  Files: src/app/dashboard/operator/approvals/page.tsx, ApprovalsView.tsx

- **Item 2: Client switcher in OperatorViewingBanner**
  When viewing a client's dashboard (?client= param present), the amber viewing-client
  banner now shows an interactive dropdown listing all operator's organisations.
  Selecting one swaps the ?client= param on the current path, preserving other params.
  Allows quick navigation between clients without returning to operator view first.
  File: src/components/dashboard/OperatorViewingBanner.tsx

- **Item 3: Client detail enrichment (OPS-1 rebuild)**
  Client detail page now displays two primary blocks:
  
  Block 1 - "Waiting on you": Lists pending actions (document suggestions, staged
  revisions, approvals). Each item links to the relevant approval surface. Empty
  state when no actions pending. Sourced from document_suggestions table filtered
  by organisation and status=pending.
  
  Block 2 - "Client profile": Displays company and contact info (name, founder,
  email, website), documents with version and status, campaigns state, warmup state,
  dispatch mode (mock/live), last login and onboarded date. Fields discovered from
  schema: organisations (name, founder_first_name, warmup_started_at, created_at),
  users (email, last_seen_at), strategy_documents (document_type, status, version,
  last_updated_at), campaigns (status, started_at, paused_at).
  
  Fields with no schema backing (not migrated, beyond scope):
  - company_website (would come from intake_responses field_key='website_url')
  - revenue_range (would come from intake_responses field_key='annual_revenue')
  
  These can be added as future schema extensions without changing the current view.
  
  Files: WaitingOnYouBlock.tsx, ClientProfileBlock.tsx (new), page.tsx (rebuilt)
  
Legacy setup panels (SetupStatusPanel, CampaignRegistrationPanel, etc.) preserved below
the new OPS-1 blocks for operational continuity.

---

## Pre-client-zero gates (must resolve before MargenticOS runs live campaigns)

- [DONE 2026-05-04] Magic link auth redirect hardcoded to localhost in Supabase Site URL (2026-05-04)
  Supabase Auth Site URL was set to http://localhost:3000, meaning magic links sent from
  production redirected users to localhost — which doesn't exist for non-developer operators.
  Fixed by updating in Supabase dashboard: Authentication → URL Configuration.
  Site URL → https://app.margenticos.com
  Redirect URLs allow list → https://app.margenticos.com/** and http://localhost:3000/**
  Pre-c1: before first paying client onboards, verify all auth flows (magic link, any
  future password reset) redirect to the production domain in all environments. The Supabase
  MCP does not expose auth URL config — this change must always be done via the dashboard.

- [DONE 2026-05-03] Sentry alert rules for send-approved-draft failures
  Three rules created via scripts/create-sentry-send-alert-rules.ts.
  Org: margentic-os | Project: margenticos | Token: SENTRY_ALERTS_TOKEN in .env.local

  Rule 562747 — send-failed-individual
    Filter: message contains "sendApprovedDraft"
    Conditions: new issue OR regression | frequency: 5 min

  Rule 562748 — send-failed-sustained
    Filter: message contains "send-approved-draft"
    Conditions: seen >2 times in 1h | frequency: 60 min

  Rule 562749 — db-update-failed-after-send-CRITICAL
    Filter: message contains "db_update_failed_after_send"
    Conditions: new issue OR regression | frequency: 5 min
    Note: CRITICAL — email is in prospect's inbox but DB row not updated; requires manual reconciliation.

- [DONE 2026-05-01] Configure Sentry alert rules for failed reply-send paths (revised)
  Rules originally created 2026-04-29 with compound filters — discovered broken 2026-05-01.
  Root cause: Sentry issue alert `filters` use AND logic. Multiple message-contains filters
  require ALL strings to appear in one event simultaneously — impossible when each targets a
  different code path. Rules existed and appeared configured but could never fire.
  Fix: deleted 553483 and 553534, replaced with four single-filter rules (one per message string).
  Script at scripts/fix-sentry-alert-rules.ts. Org: margentic-os | Project: margenticos.
  SENTRY_ALERTS_TOKEN in .env.local (scopes: alerts:write, project:read, org:read).

  Rule 558250 — reply-send-failed-runtime
    Filter: message contains "sendThreadReply failed"
    Conditions: new issue OR regression | frequency: 5 min

  Rule 558251 — reply-send-failed-on-retry
    Filter: message contains "send_reply API failed on previous run"
    Conditions: new issue OR regression | frequency: 5 min

  Rule 558252 — polling-fetch-failed
    Filter: message contains "Instantly poll: reply fetch failed"
    Conditions: seen >2 times in 1h | frequency: 60 min

  Rule 558253 — polling-uncaught-throw
    Filter: message contains "Instantly poll: reply polling threw"
    Conditions: seen >2 times in 1h | frequency: 60 min

  Rule 553484 — reply-classifier-permanently-failed (unchanged, single filter, was correct)
    Filter: message contains "classifier retry limit reached"
    Conditions: new issue OR regression | frequency: 5 min

  LESSON: when creating Sentry alert rules via the REST API with multiple filters,
  do NOT rely on filterMatch: 'any' — the API may ignore it. Use one filter per rule,
  or create separate rules per message string. The "any of these" option in the Sentry
  UI is not reliably exposed through the API.

- [DONE 2026-04-29] Phase 1 reply-handling code review — smash list (four commits)
  Full code review of classifyReply, processOneSignal, reply-actions.ts, polling/instantly.ts.
  Twelve classifier test cases all passed before fixes were applied. Four groups of fixes:

  Group A — 68375d5 — fix(reply-handling): close opt-out compliance gaps and improve OOO audit trail
    • getExistingActionSummary returns null on DB error; caller now aborts rather than re-processing
      a potentially handled signal (duplicate Calendly send risk closed)
    • Failed Instantly-side suppress on idempotency retry now logs warn "manual review needed"
      instead of silently falling through to "signal already handled"
    • Opt-out with no prospect match now logs error (not warn) with instantly_suppressed field
    • OOO action_payload gains date_parse_attempted and date_found for audit visibility

  Group B — 5debb97 — fix(reply-classifier): timeout, JSON extraction robustness, empty reasoning
    • AbortSignal.timeout(15000) on Haiku call — 15s ceiling prevents a hung classification
      from consuming the entire cron batch window
    • raw.match(/\{[\s\S]*\}/) replaces fence-strip regex — handles explanation text Haiku
      prepends before the JSON block
    • Empty reasoning string defaults to "(no reasoning provided)" with warn log, not null return

  Group C — 91b7b4a — fix(integrations/instantly): preserve error bodies, distinguish 429s, consolidate API base
    • .catch(() => null) replaced with .catch(async () => { _raw_text }) on both response parsers
      — non-JSON error bodies (HTML 429, 502) now preserved for debugging
    • ActionResult gains rateLimited?: boolean — 429 is distinguishable without retry logic yet
    • INSTANTLY_API_BASE consolidated to src/lib/integrations/handlers/instantly/constants.ts;
      both reply-actions.ts and polling/instantly.ts import from shared file

  Group D — 332b718 — feat(monitoring): add Sentry alert for sustained polling failures
    • Alert polling-failures-sustained (rule ID: 553534) — fires when polling-failure issue
      seen >2 times in 1 hour (3+ failures = 45 min of sustained breakage at 15-min interval)
    • Filters on 'Instantly poll: reply fetch failed' OR 'Instantly poll: reply polling threw'
    • Re-alerts at most once per hour. Script at scripts/create-sentry-polling-alert.ts

  Deferred from this review (not fixed tonight):
    Cat 2 #1 (Haiku concurrency) — see phase2 section below
    Cat 2 #5 (Calendly template config) — see pre-c1 section below
    Cat 3 (ADR-001 channel/source agnosticism) — pending decision, see pending-decision entry below

- [c0-blocker] Operator query for failed reply sends (2026-04-29)
  Run in Supabase SQL editor to identify signals needing manual follow-up:

    SELECT
      rha.id,
      rha.signal_id,
      rha.action_taken,
      rha.action_succeeded,
      rha.action_error,
      rha.created_at,
      p.email  AS prospect_email,
      p.first_name,
      o.name   AS org_name
    FROM reply_handling_actions rha
    LEFT JOIN prospects p ON p.id = rha.prospect_id
    LEFT JOIN organisations o ON o.id = rha.organisation_id
    WHERE rha.action_taken = 'send_reply'
      AND (rha.action_succeeded = false OR rha.action_succeeded IS NULL)
    ORDER BY rha.created_at DESC;

  action_succeeded = false  → sendThreadReply API call failed; prospect needs manual Calendly link.
  action_succeeded = null   → run was interrupted mid-call; email status unknown; verify in Instantly.

- [c0-blocker] Verify Instantly lead status values for bounced and unsubscribed (2026-04-28)
  Constants INSTANTLY_LEAD_STATUS_BOUNCED = '-2' and INSTANTLY_LEAD_STATUS_UNSUBSCRIBED = '-1'
  in src/lib/polling/instantly.ts are assumed from training data, NOT confirmed against the live API.
  If wrong, bounce and unsubscribe polling will return zero signals with no error — silent data gap.
  How to verify: once a campaign is live with at least one bounced or unsubscribed lead:
    1. Call the Instantly MCP list_leads with no status filter and the campaign UUID
    2. Find a known-bounced lead in the result
    3. Check the exact value of its `status` field
    4. If it differs from '-2' (bounced) or '-1' (unsubscribed), update the constants and redeploy
  Trigger: immediately after first Instantly campaign produces a bounced or unsubscribed lead.
  Location: src/lib/integrations/polling/instantly.ts lines 35-36 + same constants exported to route.ts

- [DONE 2026-04-29] pg_cron activation for both polling jobs (2026-04-28, completed 2026-04-29)
  Both migrations applied. Calendly URL set. Both cron jobs rescheduled with hardcoded values
  (ALTER DATABASE SET app.* requires supabase_admin on Hobby — current_setting() returns NULL, fails pg_net).
  Workaround: unschedule both jobs post-migration, reschedule with URL and CRON_SECRET hardcoded directly
  in the cron.schedule() command string. Both jobs firing at 21:30 UTC — cron.job_run_details: succeeded.
  Smoke test passed: /api/cron/instantly-poll → {"ok":true,...} | /api/cron/process-replies → {"ok":true,...}
  Migration comments updated to document the Hobby limitation and working reschedule pattern.
  See Lessons Learned: "Supabase Hobby tier: pg_cron config vars via ALTER DATABASE SET blocked".

- [pre-c0] Campaign provisioning flow — campaigns table must be populated before polling produces signals (2026-04-28)
  The polling layer maps Instantly campaign UUIDs → organisation_id via campaigns.external_id.
  If no campaigns rows exist with external_id set, ALL polling events will be logged as warnings
  and skipped (cannot write signal without organisation_id).
  Before the first Instantly campaign is created/launched: insert a row in campaigns with
  external_id = the Instantly campaign UUID, campaign_type = 'cold_email', organisation_id = correct org.
  This is a manual step at launch time; a UI or agent for campaign provisioning is future scope.
  Trigger: immediately before first campaign is launched in Instantly.

- [pre-c1] Encrypt integration_credentials.value via Supabase Vault (2026-04-28)
  Currently stored as plaintext (acceptable for client zero / pre-revenue stage).
  Supabase Vault provides encrypted secret storage backed by pgsodium.
  Migration: change value column to use vault.create_secret() and vault.decrypted_secrets view.
  Trigger: before first paying client onboards (same trigger as repo going private).

- [pre-c1] Haiku critic pass agent for document suggestion quality review
  Not yet built. Required before first paying client's suggestions reach the approval queue.
  Structured evaluation: TOV compliance, messaging rules, quality floor.
  During client zero (Doug), suggestion quality can be judged manually.
  Also a prerequisite for unlocking Option D (per-prospect generated sequences) per ADR-014.

- [DONE 2026-04-23] ICP filter spec validated against MargenticOS's own ICP (dogfood check)
  ICP agent run with website content and canonical industry prompt fix.
  Three issues found and fixed in the same session:
  (1) Industry names were non-canonical ("HR / talent consulting" etc.) — fixed by adding Rule 7
      to the ICP prompt with the full CANONICAL_INDUSTRIES list. Agent now outputs canonical names.
  (2) "agency" in keywords_excluded was too broad — removed. Solo consultants often self-describe
      as "boutique agency"; excluding it would suppress real Tier 1 targets.
  (3) DE and NL missing from country defaults — added. English-operating founders in Germany and
      Netherlands are a real pocket of the target market.
  New module: src/lib/agents/icp-filter-spec.ts — canonical taxonomy, validator that throws
  on non-canonical names, deriveFilterSpec() function.
  One open flag NOT fixed: Tier 2 headcount ceiling drifts run-to-run (8 in prior version, 15 in
  this run). headcount_max=15 borders Tier 3 territory ("10+ person firm with in-house sales teams").
  Per-client override in the filter spec approval UI will handle this. Monitor across first 3 clients.

- [DEFERRED — pending Apollo Basic activation] TAM report validated against MargenticOS's own TAM
  Apollo free plan returns 403 on both people/search and mixed_people/search endpoints.
  TAM gate code is designed and validated (deriveFilterSpec() produces the correct payload shape).
  Apollo Basic ($49/month) required to run the actual query. Doug has deferred Apollo signup
  until closer to launch. Re-run the TAM validation immediately after Apollo Basic is activated.
  The ICP breadth (7 countries, headcount 1–15, 9 consulting industries) makes a red classification
  very unlikely — but the gate must still run before the sourcing pipeline goes live.
  Status: pre-c1 (not pre-c0, since sourcing pipeline is post-sending-infrastructure anyway).

- [DONE 2026-04-29] Reply handling agent — Phase 1 scope per ADR-007
  All five files committed and pushed in session 2026-04-29:
    b15ccaa  feat(reply-handling): Instantly handler at integrations/handlers/instantly/
               suppressLead() + sendThreadReply() — REST interface only, no templating
    e6c0db1  feat(reply-handling): reply classifier with full 8-intent taxonomy
               Haiku (claude-haiku-4-5-20251001), null=classifier_failed, unclear=low-confidence
    ee66087  feat(reply-handling): reply processor with idempotency and dispatch
               20-signal batch, write-before-act, 3-retry classifier limit, DB suppression authoritative
    9261de1  feat(reply-handling): /api/cron/process-replies endpoint
               CRON_SECRET auth, service role, delegates to processReplies()
    0e1a88b  feat(reply-handling): migration skeleton (calendly_url, reply_handling_actions, pg_cron job)
               Migration committed — NOT yet applied. Activation steps in [pre-c0] pg_cron entry above.
  Scope delivered: suppress (opt_out), ooo_log, send_reply ≥0.90 confidence, log_only for all others.
  Sequence-stop on any reply handled automatically by Instantly (stop_on_reply: true).
  OOO pause/resume handled natively by Instantly — agent logs for visibility only.
  [SUPERSEDED 2026-05-01 by ADR-019] Information request escalation (15h/48h/72h chain) deferred to Phase 2. Replaced by immediate-queue tier model (Tier 2/3 drafts); no time-tiered escalation chain needed.
  Remaining before activation: pg_cron config vars, migration apply, Calendly URL, Sentry alerts.

- [DONE 2026-04-24] Store relevance_reason in prospect_research_results table and ResearchResult type
  Added relevance_reason column (migration), included in storeResearchResult() insert,
  added to ResearchResult type, surfaced in test script and DB verify query.
  Also persisted by CSV export (exportBatchResultsToCSV). Commit 6606ab7.

- [DONE 2026-04-24] Sign up for Apify and generate API key
  APIFY_API_KEY set in .env.local and Vercel (Production + Preview). Actor
  harvestapi/linkedin-profile-scraper confirmed accessible via probe. Commit f698fb4.

- [DONE 2026-04-24] Verify Brave Search API integration works end-to-end
  BRAVE_SEARCH_API_KEY set in .env.local and Vercel (Production + Preview).
  Probe returned 2 results for test query — no errors. Commit f698fb4.

- [DONE 2026-04-24] Prospect research agent v2 Phase 1 build — complete
  Four-source pipeline: LinkedIn (Apify/harvestapi), Apollo enrichment, company website,
  web search (Anthropic native → Brave fallback). Synthesis via claude-sonnet-4-6 with
  extended thinking. DB persistence: prospect_research_results table (research_tier,
  synthesis_confidence, qualification_status, trigger_text, trigger_source, relevance_reason,
  synthesis_reasoning, sources_attempted/successful, synthesized_at). Prospect row updated
  (research_tier, qualification_status, personalisation_trigger, current_research_result_id,
  research_ran_at). Batch runner with p-limit parallelism (concurrency=5, per-provider
  sub-limits). Pre-batch cost estimate CLI with Brave quota advisory. 429 retry with
  exponential backoff (3 attempts). Failed prospect logging to logs/failed-prospects-<timestamp>.json.
  CSV export for batch QA review (exportBatchResultsToCSV). scrubAITells() applied to all
  trigger_text output.
  Pre-flight bug fixes (2026-04-24):
    Bug 2A: max_tokens increased 1500→3000 (synthesis was hitting ceiling mid-reasoning)
    Bug 2B: web search limited gate removed (thin-but-real results now reach synthesis)
    Bug 2C: buildTier3TriggerText() grammar fixed (gerund/modal-negative/noun phrase detection)
    Bug 8A: CSV FK disambiguation fixed (prospects!prospect_id to resolve ambiguous join)
    Bug 6: HAIKU_PERSONALIZATION_USD added to cost estimate (was running 12-25% low)
  Dogfood test (Ginny Hudgens) passed: correct Tier 3 classification with coherent reasoning,
  web search content reached synthesis, relevance_reason persisted cleanly to DB.

- [DONE 2026-04-24] Composition layer Phase 1 feature additions
  Bridge sentence: connects research tier output to email sequence opening with
  style enforcement. Personalized CTA: derived from trigger_text + prospect context.
  Value prop alignment filter: synthesis prompt cross-references prospect signal against
  client positioning document before assigning tier and confidence score.
  Shared customer-facing style rules module: src/lib/style/customer-facing-style-rules.ts —
  canonical forbidden-phrase list (em dashes, AI tells) + scrubAITells() runtime scrub.
  All agents producing customer-facing output import from this module; no inline duplication.
  Commits fe36d05 and earlier composition sessions.

- [DONE 2026-04-27] Tier 1 composition path validated on real data (Anya Dayson)
  Dogfood batch 2 re-run produced Anya Dayson (Ascend Strategic Marketing) as icp_fit=strong /
  signal_relevance=use_as_hook — the first real Tier 1 result. Full composition dry-run confirmed:
  trigger fires correctly, Haiku bridge generates cleanly ("That relationship-driven approach works
  until you need predictable revenue between partnership cycles."), patched B1 template reads
  coherently after trigger swap, Haiku CTA personalised to "Ascend", sign-off correct, 85 words
  within limit. Bridge path is validated end-to-end against real prospect data.

- [monitor] Promote estimate-batch-cost.ts to a proper committed CLI (2026-04-27)
  Currently written as a throwaway script and deleted after each use. Should be committed as a
  permanent CLI so the cost gate can be run independently of the batch runner (e.g. before deciding
  whether to run at all, without needing a confirm_before_run=true workaround).
  Trigger: next time an operator-seeded batch is planned.
  Estimated effort: 30 minutes — move constants to a shared module, add CLI arg for prospect count.

- [research] trigger_data column overloaded — synthesis output overwrites seed metadata (2026-04-27)
  File: src/lib/agents/prospect-research-agent-v2.ts:127 (`trigger_data: synthesis` in updateProspect()).
  What's broken: updateProspect() writes the full SynthesisOutput object into trigger_data, completely
  replacing whatever was there. Seed metadata stored in trigger_data (seed_why_fit, seed_source_query,
  seed_niche_category) is silently erased the first time research runs on a prospect.
  Why it matters: original manual qualification reasoning is unrecoverable from the DB once research
  has run. Audit trail loss only — research quality, composition output, and outbound are unaffected.
  Fix options:
    (a) Add separate seed_metadata JSONB column to prospects — never overwritten, holds pre-research
        operator notes permanently.
    (b) Move synthesis output to its own synthesis_data column on prospects, leave trigger_data for
        seed and operator-set values only.
    (c) Promote seed fields (seed_why_fit, seed_source_query, seed_niche_category) to typed columns
        and drop JSONB entirely for this use case.
  Estimated effort: 1–2 hours once schema decision is made. Schema decision is the blocking step.
  Trigger for resolution: next operator-seeded batch is planned, OR audit trail is needed for a real
  decision (e.g. reviewing why a flagged prospect was originally included), OR next schema change
  touches the prospects table — whichever comes first.

- [DONE 2026-04-29] Move polling code from src/lib/polling/ to src/lib/integrations/polling/
  src/lib/integrations/polling/instantly.ts — all Instantly-specific code now under src/lib/integrations/.
  Import path updated in src/app/api/cron/instantly-poll/route.ts. Old directory deleted.
  Trigger was met: Phase 1 reply handling shipped same session. Commit: see refactor(polling) commit.

- [pre-c0-C] Marketing website readiness decision (2026-04-24)
  Current Netlify landing page exists. Cold prospects land there from email signatures and
  Calendly confirmations. Before campaigns go live, Doug needs to decide: is the current page
  credible for the founder-led consulting firm ICP, or does it need an upgrade?
  This is a judgment call, not a build item. ~30 min to review and decide.
  Timing: at least 1 week before first cold email send.

- [pre-c0-C] Calendly personal setup for MargenticOS (2026-04-24)
  ~15 min operator config. Needed for the positive reply template in the reply handling agent.
  Separate from per-client Calendly routing form setup (that's pre-c1, see below).
  Just a personal booking link that Doug controls for MargenticOS outreach.

- [DEFERRED → pre-launch T-10 days] Sending infrastructure provisioned for MargenticOS
  Deferred 2026-04-24. Cash conservation + pre-warmed accounts eliminate warming delay entirely.
  Full plan: see "Pre-launch infrastructure (T-10 days)" section below.
  Trigger: ~7-10 days before actual launch (Apollo activated, dogfood validated,
  outbound copy drafted, target list ready).

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

- [DONE 2026-04-23] Replace TODO placeholders in AgentActivityView and SignalsLogView
  Both views now fetch real data at the page level (server components) and pass
  as required props. Placeholder data and default-prop pattern removed entirely.
  AgentActivityView: agent_runs joined to organisations via client_id FK,
  ordered started_at desc, limit 100. output_summary falls back to error_message
  for failed runs. Error state renders if query fails.
  SignalsLogView: signals joined to organisations and prospects, ordered
  created_at desc, limit 200. detail column dropped — no column exists, raw_data
  unstructured until signal processing agent is built. signalTypeLabel map
  expanded to cover all 17 SignalType values. Error state renders if query fails.
  Also regenerated src/types/database.ts — agent_runs and auto_approve_window_hours
  were missing from the generated types.

- [phase2, trigger: >20 unprocessed reply signals at start of any cron run] Haiku concurrency in reply processor (2026-04-29)
  Current: processReplies() processes 20 signals sequentially. At ~400ms avg per Haiku call,
  batch takes ~8s — fine at current volume. When backlog exceeds batch capacity (signals accumulate
  faster than one 5-min cron cycle clears them), add p-limit concurrency of 3–5.
  Same pattern as prospect research batch runner (concurrency=5, per-provider sub-limits).
  File: src/lib/reply-handling/process-reply.ts — BATCH_SIZE constant and for loop at line ~590.
  Do not build speculatively. Observable signal: reply_received signals with processed=false
  older than 10 minutes at the start of a cron run.

- [phase2, trigger: running batches >1000 prospects regularly OR local execution causes operational pain] Durable background queue for prospect research batches
  Current architecture: p-limit parallel batch with concurrency=5, runs locally via npx tsx.
  Target: 1000 prospects in 30-60 min wall-clock. Sufficient for pre-c0 and single-client operation.
  When this trigger fires: migrate to Vercel Queues or cron-chunked API route with persistent job state.
  Do not build speculatively — the local parallel runner is adequate until the trigger is hit.

- [phase2, trigger: 5+ paying clients actively reviewing batches weekly] Full QA dashboard UI replacing CSV export
  Current: exportBatchResultsToCSV() writes to /tmp. Doug opens in spreadsheet for spot-checks.
  Future: dashboard view with accept/reject per trigger, flag for rewrite, A/B test tracking.
  Do not build until CSV export becomes operationally painful at scale.

- [phase2, trigger: failure rate >5% in production batches] Automated failed-prospect re-queue
  Current: failed prospect IDs written to logs/failed-prospects-<timestamp>.json.
  Doug re-queues manually by passing file to next batch run. Adequate for low failure rates.
  Future: automated retry queue with configurable delay and max attempts.

- [phase2, trigger: running concurrent batches for different clients simultaneously] DB-level idempotency locks
  Current: skip_existing = true provides soft resumability (checks current_research_result_id).
  Safe for sequential client processing. SELECT FOR UPDATE SKIP LOCKED needed only when
  multiple concurrent batch jobs for different clients could race on the same prospect row.

- [phase2, trigger: batches frequently crashing mid-run] Persisted batch state with automatic resume
  Current: skip_existing = true allows restart after crash — already-researched prospects are skipped.
  Soft resumability is sufficient until batches are large enough that mid-run crashes are frequent
  or costly. Persisted batch state (checkpoint table) adds complexity not yet warranted.

- [phase2] Build the warnings engine backend
  WarningsRail.tsx exists with placeholder data. No threshold evaluation logic
  exists. Deferred from pre-c0: warnings only produce value when signals are
  flowing at volume. Signals require cold sends landing, which requires 2–3 weeks
  of domain warming first. For client zero (Doug running outbound), signal volume
  will be too thin to fire meaningful warnings. Build against real client zero data
  rather than a speculative spec. Re-evaluate after 30 days of client zero operation.

- [phase2] Build the signal processing agent
  Table and processed field exist. No agent file. No webhook routes. Deferred
  from pre-c0: processing is meaningless until campaigns are running and signals
  are flowing. Building now saves nothing — the schema is ready and the agent can
  be added once real signal shape is known from client zero. Re-evaluate after
  30 days of client zero operation.

- [phase2] Build the pattern aggregation agent
  ADR-011 already defers signal threshold logic and A/B testing to Phase 2.
  Aggregation agent feeds those systems — if the consumers are Phase 2, the producer is too.
  Sparse data during client zero makes this meaningless to run. Build when signal volume justifies it.

- [DONE 2026-04-23, updated 2026-04-29] Build a scheduler for auto-approve timers
  Route built: /api/cron/auto-approve (CRON_SECRET protected). Fetches pending suggestions
  per organisations.auto_approve_window_hours (default 72). approve_document_suggestion RPC.
  Per-suggestion error isolation. SYSTEM_AUTO_APPROVE_ID sentinel in reviewed_by.
  Migration: auto_approve_window_hours added to organisations table.

  UPDATE 2026-04-29: The Vercel Cron entry (0 * * * * = hourly) was REMOVED from vercel.json.
  Vercel Hobby blocks sub-daily crons — this entry silently rejected every push to main for 6 days.
  The route still exists and works. When auto-approve is enabled (Phase 4 per CLAUDE.md), schedule
  it via pg_cron (same pattern as instantly-poll and process-replies) rather than a Vercel cron entry.
  See Lessons Learned: "Vercel Hobby rejects sub-daily cron schedules at build time".

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

- [DONE 2026-04-23] Build intake file upload (Supabase Storage)
  intake_files table + RLS + intake-files Storage bucket (private, 10MB, PDF/DOCX/TXT/MD).
  POST /api/intake/files/upload: validates, uploads to Storage, extracts text at upload time
  (pdf-parse for PDF, mammoth for DOCX, direct read for TXT/MD), inserts metadata row.
  DELETE /api/intake/files/[id]: verifies org ownership before deleting.
  FileUploadSection component in intake form (voice section): drag-drop + browse, purpose
  selector per file (voice_sample/icp_doc/case_study/other), delete button, extraction
  failure warning.
  TOV agent: now reads both voice_samples pasted field AND intake_files (file_purpose=voice_sample).
  ICP agent: now reads intake_files (file_purpose IN icp_doc/case_study) as reference docs.
  End-to-end verified: 3 real writing samples uploaded, extracted cleanly, TOV agent run
  confirmed dual-source in suggestion_reason ("Writing samples: 1422 words total. Uploaded
  files: 3 (sample-1-linkedin-layoff.txt, sample-2-caio-followup-email.txt,
  sample-3-jeff-whatsapp.txt)"). Supabase MCP used to apply migration — no manual SQL needed.

- [DONE 2026-04-23] Build intake website URL ingestion
  intake_website_pages table + RLS. fetch-website.ts: simple fetch + node-html-parser,
  homepage + up to 3 inner pages (About, Services, Case Studies) via anchor scoring.
  POST /api/intake/website/fetch: auth + org resolve + delete/insert rows.
  IntakeForm: company_url blur triggers fire-and-forget fetch; assets_website field removed
  (company_url is canonical). ICP, TOV, Positioning agents all call fetchWebsiteContext()
  from src/lib/agents/website-context.ts — injected into prompt after uploaded files.
  Failed fetches (timeout, 403, dead link) are non-fatal — agents proceed without website data.

- [pre-c1] Dangling auth.users cleanup for blocked second invites (2026-05-12)
  When handle_new_user() catches a unique_violation and writes to users_pending_review, the
  auth.users row created by the invite is left with no public.users row and no org access.
  The user has a valid Supabase auth identity but cannot log in to anything useful.
  Current guidance: manual delete via Supabase Dashboard → Authentication.
  Required before c1: a daily pg_cron job that sweeps auth.users for rows with no matching
  public.users row older than 24h and deletes them. This prevents auth bloat and removes
  the manual cleanup burden. The 24h window avoids racing a legitimate slow invite accept.

- [pre-c1] Recovery mechanism for orphaned agents_dispatched_at (2026-05-12)
  If /api/intake/complete fires but all 4 agent dispatches fail silently (network error,
  cold start timeout, NEXT_INTERNAL_SECRET missing in env), agents_dispatched_at is stamped
  but no agents run. The org is permanently locked out of the auto-dispatch path because the
  IS NULL guard prevents re-triggering.
  Required before c1: an operator UI button or protected route that resets agents_dispatched_at
  to NULL for a given org, so the auto-dispatch can re-fire. The reset must also clear
  docs_complete_notification_sent_at to allow the completion email to re-send if needed.

- [pre-c1] Operator-as-client onboarding email separation (2026-05-12)
  Doug's operator email (d.h.p1999@gmail.com) is blocked by the GoTrue pre-invite existence
  check in actions.ts — if the same email is registered as an operator, the check finds it
  in auth.users and rejects the invite. Client-zero self-onboarding requires a separate
  email address.
  Workaround: use a Gmail +alias (e.g. d.h.p1999+client@gmail.com) for the first client
  invite. Gmail delivers +alias mail to the same inbox.
  Permanent fix: multi-user role model where one auth.users row can hold both operator and
  client roles, OR a separate operator-invite bypass in the pre-invite check. Defer to
  post-client-zero role model redesign.

---

## Pre-launch infrastructure (T-10 days)
# Trigger: ~7-10 days before actual launch.
# Prerequisites: Apollo activated, dogfood end-to-end validated, outbound copy
# drafted and approved, first target list ready to upload.
# Rationale (2026-04-24): cash conservation during uncertain pre-launch timeline.
# Pre-warmed domains eliminate the 2–3 week warming delay — order close to launch
# date, connect, and go live within days rather than weeks.

- [pre-launch] Confirm Apollo Basic credit allocation covers 200 prospect enrichments/week per client (2026-04-24)
  Apollo Basic ($49/month) includes 12,000 export credits/year (~230/week).
  At 200 enrichments/week per client, Basic covers roughly 1 active client.
  If launching with 2+ simultaneous clients, upgrade path: Apollo Professional ($99/month,
  ~24,000 credits/year, ~460/week). Verify against current Apollo pricing at activation time —
  credit packages change. Confirm before placing the first Apollo order.

- [pre-launch] Upgrade Instantly to Growth monthly ($47/month)
  Do this first. DFY order endpoint and pre-warmed domain pool require paid plan.
  Login → Settings → Billing → Growth monthly.

- [pre-launch] Check pre-warmed domain pool availability
  POST https://api.instantly.ai/api/v2/dfy-email-account-orders/domains/similar
  {"domain": "margenticos.com", "tlds": ["com"]}
  API key in ~/.claude.json mcpServers.instantly.url (after /mcp/).
  Claude Code can call this directly via REST — no MCP needed.
  Confirmed working on 2026-04-24 with free trial. Returns 60+ candidates.

- [pre-launch] Order 4 pre-warmed mailboxes across 2 domains
  Domains selected on 2026-04-24: trymargenticos.com, getmargenticos.com
  (Confirm availability at order time — pool changes.)
  Config: 2 mailboxes per domain, Google Workspace, forwarding → margenticos.com
  Mailbox naming: doug@[domain], douglas@[domain] for each domain (4 total)
  Run simulate: true first for price quote and validation.
  Approx cost: ~$40/month mailboxes + ~$30/year domains = ~$73 first month.
  Claude Code places the real order (simulate: false) only after Doug reviews quote
  and confirms.

- [pre-launch] Configure Gmail display names, signatures, profile photos manually
  ~10-12 min per mailbox × 4 mailboxes = ~40-50 min total.
  Display name: Doug Pettit | MargenticOS (or client-appropriate variant)
  Signature: clean, no logo, matching the TOV guide.
  Profile photo: professional headshot.
  Must be done manually in Gmail — no API for this.

- [pre-launch] Connect mailboxes to Instantly, verify warmup + deliverability
  Add accounts in Instantly dashboard. Confirm warmup status active.
  Run deliverability check before first campaign send.

- [pre-launch] Create campaign shell, upload first target list
  Campaign shell: name, schedule, daily send limits, unsubscribe footer.
  Target list: first Apollo export filtered against ICP filter spec.
  Sequence templates: already drafted as part of dogfood.

- [pre-launch] Launch
  First send. Monitor open rate + bounce rate for 48 hours.

---

## Pre-client-zero critical path (dependency map)
# Last updated: 2026-04-23

Remaining [pre-c0] items in dependency order. Items at the same level can run in parallel.

### Layer 0 — no dependencies, can start immediately (parallel)

**Sending infrastructure** ✓ DEFERRED 2026-04-24 → see Pre-launch infrastructure (T-10 days)
  No longer on the pre-c0 critical path. Will be provisioned ~7-10 days before launch
  using pre-warmed accounts. Removes the 2–3 week elapsed-time constraint from the path.

**Intake file upload** ✓ DONE 2026-04-23
  TOV agent now reads uploaded files + pasted text field. ICP agent reads uploaded icp_doc/case_study files.
  3 real writing samples uploaded and verified. New pending TOV suggestion created with dual-source context.

**Intake website URL ingestion** ✓ DONE 2026-04-23
  company_url triggers fetch on blur. Homepage + up to 3 inner pages stored in intake_website_pages.
  ICP, TOV, Positioning agents all consume via fetchWebsiteContext().

**Replace TODO placeholders — AgentActivityView + SignalsLogView** ✓ DONE 2026-04-23
  Real data wired via server components. See [DONE] entry above.

### Layer 1 — depends on intake being complete (parallel after Layer 0)

**ICP filter spec dogfood check** ✓ DONE 2026-04-23
  Three fixes applied: canonical NAICS industry names in prompt + validator, "agency" removed
  from keywords_excluded, DE/NL added to country defaults. One flag: headcount ceiling drifts
  run-to-run — monitor across first 3 clients, handle via per-client override in approval UI.

### Layer 2 — depends on Layer 1

**TAM report validated against MargenticOS's own TAM** (~1 hr)
  Depends on: ICP filter spec dogfood (TAM gate consumes the filter spec)
  Blocks: sourcing pipeline confidence — if TAM gate misfires, prospect sourcing is unreliable

**Build auto-approve scheduler** ✓ DONE 2026-04-23
  Vercel Cron hourly, POST /api/cron/auto-approve, CRON_SECRET protected.
  Fetches pending suggestions per organisations.auto_approve_window_hours (default 72).

### Critical path (longest chain)

Intake file upload + website ingestion
  → ICP filter spec dogfood
  → TAM report dogfood

Auto-approve scheduler ✓ DONE. Sending infrastructure deferred to pre-launch (T-10 days).

Signal processing agent and warnings engine backend deferred to Phase 2 — see Phase 2 section.

### Total build-time estimate (updated 2026-04-24)

  Layer 0 (parallel): ✓ complete
  Layer 1 (parallel): ✓ complete
  Layer 2: TAM report (~1 hr, blocked on Apollo Basic activation)
  Sending infrastructure: deferred to T-10 days pre-launch — not a build-time constraint
  ─────────────────────────────────────────────────
  Remaining pre-c0 build time: ~1 hr (TAM dogfood, runs once Apollo is active)
  The 2–3 week warming wall-clock constraint is eliminated by using pre-warmed accounts.
  Critical path is now: dogfood end-to-end → activate Apollo → TAM validation → launch.

---

## Pre-first-paying-client gates

- [pre-c1, trigger: first paying client requests reply copy customisation] Calendly reply template config (2026-04-29)
  Current: buildCalendlyReplyBody() in process-reply.ts:80-96 is a code-level constant.
  Any copy change (tone, sign-off, P.S. line) requires a code deploy.
  Acceptable for client zero — one template, operator-controlled.
  Fix when triggered: move template to organisations table or a per-client config row.
  Use {firstName}, {orgName}, {calendlyUrl} as named placeholders resolved at send time.
  Operator editable in the settings view without a deploy.
  File: src/lib/reply-handling/process-reply.ts:80-96

- [pre-c1-B] Payment gateway integration — Stripe assumed default (2026-04-24)
  Estimated scope: 2–3 days. Not a client zero blocker (Doug is client zero, no payment required).
  Build before first paying client onboards. Stripe is the assumed default; confirm before building.

- [pre-c1-B] Password auth alternative to magic link (2026-04-24)
  Supabase Auth supports password auth natively — minimal build effort.
  Build only if a founding client explicitly requests it during onboarding.
  Do not build speculatively.

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
  Apollo free plan returns 403 on people/match AND people/search endpoints.
  Both prospect research agent (Step 1) and TAM gate are non-functional until paid plan active.
  Doug has decided to defer Apollo signup until closer to launch (2026-04-23 decision).
  Activate at apollo.io — both endpoints unblock immediately on Basic ($49/month).
  TAM dogfood validation must run immediately after activation.

- [pre-c1] Configure Calendly Routing Forms per client at onboarding
  Three screening questions: business email (blocks personal domains), company
  headcount dropdown (confirms firmographic fit live, catches stale Apollo data),
  short free-text on interest reason. Route qualified → booking page. Route
  disqualified → nurture thank-you page. ~15 min per client at onboarding.
  Biggest single lever for perceived meeting quality. Industry-standard among
  premium agencies (Beanstalk-tier 60-70% positive-reply-to-qualified conversion).

- [pre-c1] Re-run step E end-to-end once Instantly is connected (2026-05-05)
  Group 6 manual verification step E (approve a pending draft → confirm it delivers a real reply
  to the prospect's inbox) was confirmed as the correct flow, but the send step fails on seed data
  because seed signals lack the id and eaccount fields required for Instantly thread replies.
  Step E cannot be fully verified until Instantly is live and a real reply signal is polled.
  Trigger: first real reply signal exists in reply_drafts from a live Instantly campaign.
  Action: run the full approve flow against a real draft and confirm the reply appears in the
  prospect's inbox via the Instantly sent-mail log.

- [DONE 2026-05-07] Instantly poller: eaccount not validated before writing signal
  RESOLVED. eaccount check added immediately after id check in pollInstantlyReplies
  (src/lib/integrations/polling/instantly.ts lines ~416-428). If eaccount is missing,
  logs a Sentry warning with email_id, from_email, campaign_id and skips the event.
  Matches existing id-check pattern exactly (logger.warn + result.errors++ + continue).
  Commit: see fix(polling) commit from session 2026-05-07.

- [pre-c1] Operator UI hardcoded mock data — wire to real data before first paying client (2026-05-05)
  Three operator UI components contain hardcoded placeholder data:
    - WarningsRail.tsx: PLACEHOLDER_WARNINGS uses client names "Apex Consulting" / "Meridian Group"
      and recommendation text that names "Instantly" and "Apollo" directly in operator-visible strings.
    - SettingsView.tsx: PLACEHOLDER_SETTINGS uses orgName "Apex Consulting", a hardcoded Calendly URL,
      and a mock integrations array with tool names and fake connection dates.
  The warnings engine backend is phase2 (deferred until signal volume justifies it). But before
  a paying client is onboarded: either remove the placeholder data (show empty/coming-soon state)
  or wire to a real data source. Displaying a different client's placeholder data to a paying
  client is an onboarding embarrassment. The tool names in WarningsRail action text also violate
  the operator-facing tool-agnostic principle when the platform serves multiple integration options.

- [DONE 2026-06-05] Login page rate-limit error message is misleading (2026-05-05)
  RESOLVED as part of the auth front-door fix session (2026-06-05).
  actions.ts already checked error.status === 429 and redirected to /login?error=rate_limited.
  ERROR_MESSAGES['rate_limited'] = 'Too many login attempts. Please try again in an hour.'
  Item was live before this session; flagged here for completeness. Confirmed by code review.

- [DONE 2026-06-05] Auth front-door blocker — magic link non-delivery + auth_failed (2026-06-04/05)
  ROOT CAUSE: Supabase project was using built-in SMTP (noreply@mail.app.supabase.io, shared relay,
  2 emails/hour rate limit). Built-in relay has poor deliverability; "sent" logged in Supabase but
  email silently dropped by receiving MTA. Rate limit of 2/hr meant repeated test requests exhausted
  quota with no visible error.
  MORNING auth_failed (benign): requesting a new link invalidates the prior OTP token (Supabase
  single-use semantics). The earlier auth_failed was a superseded token from repeated test requests,
  not a PKCE error or auth bug.

  FIX — three changes, deployed as commits a134c49 (tests/utils) and d7a6ebc (OTP fallback):
  A. Supabase SMTP → Resend custom SMTP (smtp.resend.com:465, sender: MargenticOS <login@margenticos.com>)
     Rate limit raised from 2 → 10/hr. Email subject: "Sign in to MargenticOS". Configured via
     Supabase management API (no code change). Verified: email arrives in seconds, sender correct.
  B. margenticos.com verified in Resend (EU region). DNS added automatically via Netlify DNS REST API
     (zone 69d56b71b4981c20806bb5aa): DKIM TXT on resend._domainkey, MX+TXT on send. subdomain.
     SPF/DMARC: no apex merge needed (apex had no prior SPF; _dmarc already existed as p=none).
  C. OTP-code fallback on login screen: email template updated to include {{ .Token }} (8-digit code
     alongside the link). Login screen post-send state shows code entry form; verifyOtpCode server
     action calls supabase.auth.verifyOtp type:email. Magic-link path unchanged. Scanner-proof:
     code is not a URL and survives email scanner prefetch.

  RESEND KEYS:
  RESEND_API_KEY (send-only, existing) — transactional email from notifications@notifications.margenticos.com
  RESEND_ADMIN_API_KEY (full-access, claude-code-admin key) — domain management automation; stored in
    .env.local only; keep labeled for future automation; no rotation needed unless key is compromised.

- [pre-c1] Verify auth redirect URLs in production for all auth flows (2026-05-05)
  The Supabase Site URL was previously set to localhost and was corrected on 2026-05-04
  (see DONE entry). Before the first paying client onboards: explicitly re-verify that ALL
  auth flows — magic link login AND any future password reset — redirect to
  https://app.margenticos.com in the production environment.
  The Supabase MCP does not expose auth URL config. Verification must be done manually:
  Supabase dashboard → Authentication → URL Configuration. Confirm Site URL and
  Redirect URLs allow-list are both correct. Add to onboarding checklist.

- [pre-c1] Regenerate GitHub PAT before expiry (2026-05-05)
  A 7-day expiry notice has already been received for the GitHub personal access token in use.
  Regenerate at github.com → Settings → Developer Settings → Personal Access Tokens.
  After regeneration: check all locations where the token is referenced and update them —
  ~/.claude/mcp.json (GitHub MCP config), any Vercel environment variables that use a GitHub
  token, and any scripts in /scripts/ that reference GitHub credentials.
  Do not let the token expire: an expired token breaks CI/CD, MCP access, and any automated
  GitHub operations mid-session without a clear error message.

- [pre-c1] ADR-001 violations — operator-visible UI strings hardcoding tool names (2026-05-05)
  Three known instances in operator-facing dashboard components:
    - src/components/dashboard/operator/SettingsView.tsx:188 — "configured directly in Instantly."
    - src/components/dashboard/operator/WarningsRail.tsx:24 — "domain reputation in Instantly."
    - src/components/dashboard/operator/WarningsRail.tsx:32 — "email list hygiene in Apollo"
  The comprehensive readiness audit may surface additional instances. Bundle all ADR-001 string
  fixes into a single dashboard cleanup pass when the audit findings are triaged.

  Also note: SettingsView.tsx integrations registry display (lines 31–35) is hardcoded mock data —
  should be replaced with a live query against the integrations_registry table when next touched.
  Not an ADR-001 violation (the display is meant to show tool names), but it is stale mock data
  that should be wired to real data.

- [pre-c1] Prospect state machine cleanup: qualification_status design (2026-06-12)
  DEFERRED. qualification_status currently mixes research verdict semantics (qualified/flagged_for_review/disqualified)
  with an engagement event ('replied_positive' added 2026-06-12 fix). The reply handler does not gate on suppressed
  before marking replied_positive, and no mutual-exclusion constraints exist across qualification_status, suppressed,
  and outbound_upload_status. Minimal fix shipped 2026-06-12 (allow 'replied_positive' in CHECK constraint).
  Full cleanup deferred to pre-c1: design a proper prospect state machine covering:
    - Research phase (unassessed -> researched -> disqualified)
    - Engagement phase (no_reply -> replied_positive / replied_negative -> meeting_booked)
    - Suppression state (not_suppressed -> suppressed, mutual-exclusive with engagement)
  Current status allows silently overwriting one dimension with another. Not data-lossy (previous value readable
  in updated_at history), but confusing. Ticket for design work pre-c1.

- [pre-c1] FAQ seed agent — generate baseline FAQ library per client at onboarding (2026-05-12)
  Status: Deferred. Pre-client-one blocker. Not needed for client zero.

  The problem this solves:
  The FAQ system (ADR-019) grows organically from operator-handled Tier 3 replies. A Tier 3 reply
  is handled, the extraction agent captures the Q&A, the operator approves it in the curation UI
  (/dashboard/operator/faqs), the FAQ goes live. Over time, more replies route as Tier 2 drafts
  instead of forcing Tier 3 manual handling.

  This works for client zero because the operator (Doug) knows his own answers. It breaks for
  every paying client because of the cold-start problem: day one of campaign sending, the FAQ
  library is empty, every reply hits Tier 3 manual mode, and the operator personally writes every
  reply from scratch until extractions accumulate. At scale (10+ clients) this is 30+ Tier 3
  replies per week just to bootstrap each new client's FAQ library.

  The seed agent solves the cold-start by pre-loading 15–20 FAQ candidates per client at
  onboarding time, generated from data the system already has, and gated by the existing
  curation UI review flow.

  What to build:
  A new agent that runs after intake completion (or as part of the document generation phase,
  alongside ICP/Positioning/TOV/Messaging). Inputs:
    - Intake responses (text fields, files, website fetch)
    - Approved ICP document
    - Approved Positioning document
    - Approved TOV document
    - Approved Messaging document

  The agent generates 15–20 FAQ candidates representing the most likely questions B2B prospects
  will ask in cold email replies, with answers written in the client's voice (per TOV) and tuned
  to pivot toward booking a meeting rather than giving direct answers where appropriate (pricing
  deflects to a call, timelines give a rough range and pivot, etc).

  Candidates write to faq_extractions with status = 'pending' and a new source_type = 'seed_agent'
  field (vs the existing implicit source from real Tier 3 replies). They appear in the existing
  FAQ curation queue at /dashboard/operator/faqs for operator review. Operators can approve_new,
  approve_merge, or reject through the existing queue — no new UI needed.

  Approved seeds land in faqs the same way extraction-based FAQs do. The matcher and drafter
  consume them identically — no downstream code changes needed.

  Why Path B (AI generation), not Path A (client fills a form):
  Path A (15 onboarding questions for the client to answer) was rejected:
    - Adds 15–20 minutes to onboarding, increasing intake friction
    - Weak client answers contaminate the FAQ library with low-quality content
    - Some clients will skip questions or give one-line answers that don't capture real intent
  Path B uses what the system already knows about the client, adds zero client burden, and routes
  everything through the operator review gate that already exists (ADR-019 pattern).

  Critical design notes for when this is built:
    - Agent must respect ADR-001 (industry-agnostic) — no hardcoded niche-specific question
      lists in the prompt. Questions must be derived from client inputs, not from a fixed template.
    - Answer style defaults to pivot-to-meeting for sensitive topics (pricing, exact timelines,
      refund policies, specific results/case studies). Direct answers for factual operational
      questions (do you work with X type of business, do you do email or LinkedIn, etc).
    - Generate questions a cold email prospect would actually ask, not generic FAQ-page questions.
      Website FAQs answer "what we do"; cold email replies ask "what makes you different from X" /
      "what's your pricing" / "what kind of results do you typically see." Different question set.
    - Add source_type column to faq_extractions to distinguish seed candidates from real extractions.
      Schema: source_type text DEFAULT 'extraction' CHECK (source_type IN ('extraction', 'seed_agent')).
      The curation UI can optionally badge seed cards differently, but this is not required for v1.
    - Tune candidate count down if quality suffers at 20 — 10 high-quality seeds beat 20 mediocre ones.

  Build effort estimate: half a day to a full day.
    - src/lib/agents/faq-seed-agent.ts (new agent file, existing agent pattern)
    - /api/agents/faq-seed route (operator-triggered initially; auto-trigger post-messaging-approval later)
    - Schema migration: add source_type column to faq_extractions
    - Optional: badge on extraction cards to distinguish seed candidates in the pending queue
    - Prompt engineering and quality testing — longest part; informed by client zero Tier 3 data

  Decision blockers to resolve at build time:
    - Auto-trigger (after messaging approval) or operator-triggered manually? Lean auto, but
      evaluate after client zero whether operator wants a chance to delay.
    - Should approved seed FAQs visually distinguish from extraction-based FAQs in the KB list?
      Probably not — once approved, they're identical in function. Distinction only matters in review.
    - How does the seed agent handle thin intake (minimal text, no files, weak website)? Either
      generates lower-quality candidates the operator must filter harder, or refuses to run and
      surfaces a "intake too thin for seed FAQs" warning. Decide based on client zero intake patterns.

  When to build this:
  After client zero has run end-to-end and produced real Tier 3 replies. Specifically:
    - Client zero must have handled at least 20–30 real Tier 3 replies first
    - Real reply patterns should inform the seed agent prompt (what questions actually came up,
      what good pivot-to-meeting answers look like, what tone hit)
    - Build during Costa Rica focused work phase, before client one onboards
  Building before client zero means baking assumptions without evidence. Building after means the
  prompt is grounded in real outbound reply data, producing a meaningfully better seed library.

  Related:
    - ADR-019 — FAQ compounding loop (the system this extends)
    - Group 7 (FAQ curation UI) — shipped commit 3d2412f, the review surface this feeds into
    - Messaging agent rigidity (4-email sequence hardcoded) — separate pre-c1 concern

- [pre-c1] Multi-user access per organisation (2026-05-13)
  Current model: one client user per organisation, enforced by the partial unique
  index `users_one_client_per_org` and the handle_new_user trigger built in
  Prompt 2 of the onboarding automation work. Real clients will want to invite
  team members (co-founder, VA, ops lead) to their dashboard. Building this
  before c0 was considered and explicitly deferred — multi-user design decisions
  (roles? admin vs member? invite UX?) should be informed by real client signal,
  not speculated about now.

  When this is built, remove from Prompt 2:
    - The partial unique index `users_one_client_per_org`
    - The exception-raising branch of handle_new_user() (or whatever variant
      shipped per Gap 2 resolution)
    - users_pending_review table and its associated webhook + notify route +
      email template
    - The pre-invite "does this email already exist in auth.users" check in
      the create-org server action

  Add: operator UI for "invite additional user to existing org", role column
  on public.users with appropriate enum, RLS policy review to confirm
  multi-user-per-org assumptions don't break anywhere.

  Trigger: first paying client requests a second user, OR before client one
  onboards if commercial signal suggests it's universally expected. Resolve
  password vs magic-link auth question at the same time.

- [pre-c1] Dangling auth.users cleanup for blocked invites (2026-05-13)
  The Prompt 2 multi-user-signup trigger allows auth.users creation to succeed
  but writes no public.users row when a duplicate invite is detected. This leaves
  a dangling auth.users entry with a valid magic link but no app access.
  Acceptable for c0 (single operator, manually clean via Supabase dashboard).
  Before client one onboards, add a daily pg_cron sweep:
    DELETE FROM auth.users
    WHERE id NOT IN (SELECT id FROM public.users)
      AND created_at < now() - INTERVAL '24 hours';
  Use pg_cron + pg_net pattern (established pattern in this repo — see lessons
  learned re: Supabase Hobby pg_cron config). The 24-hour buffer prevents
  sweeping legitimate users who are mid-invite-acceptance flow.
  Trigger: before client one onboards.

---

## Instantly live-verification checklist (from 2026-06-10 evidence audit)

Systematic audit of all 10 Instantly API call sites, custom variable composition, response parsing, and mock shapes.
Evidence recorded: custom-variables.ts, uploadLeads.ts, orderMailboxes.ts, syncSequenceShell.ts, reply-actions.ts,
campaign-analytics.ts, validateCampaign.ts, instantly.ts polling layer, types.ts, mock-dispatch.ts.

- [pre-c0, HIGH] Verify lead status values against live API (2026-06-10)
  INSTANTLY_LEAD_STATUS_BOUNCED = '-2' and INSTANTLY_LEAD_STATUS_UNSUBSCRIBED = '-1' in
  src/lib/integrations/polling/instantly.ts lines 39-40 are marked UNVERIFIED in code comments.
  Values assumed from training data, never confirmed against live Instantly V2 API.
  If wrong: bounce and unsubscribe polling will return zero signals with no error or warning.
  Result: silent data gap that threatens sending-domain health and campaign health metrics.
  Verification method: once a campaign is live with at least one bounced or unsubscribed lead,
  call Instantly list_leads endpoint with no status filter, find the known-bounced lead, inspect
  its status field value, compare to '-2' and '-1', update constants if different, redeploy.
  Trigger: immediately after first Instantly campaign produces a bounced or unsubscribed lead.
  Related: existing BACKLOG entry at line 265-275 (c0-blocker tag, 2026-04-28) has detailed verification steps.

- [pre-c0, MEDIUM] HTTP 200 treated as business success without body status check (2026-06-10)
  Eight of ten Instantly API call sites (uploadLeads, syncSequenceShell, suppressLead, sendThreadReply,
  fetchCampaignStats, validateCampaign, pollInstantlyReplies, pollInstantlyLeadStatus) check response.ok
  only and do not inspect a status field in the JSON response body.
  Current assumption: Instantly V2 API never returns HTTP 200 with a business-level error status in body.
  Risk: if Instantly ever returns 200 with { status: "error" } in the body, code treats it as success.
  Action: consult Instantly V2 documentation to confirm whether 200-with-error-body is a real pattern.
  If real: add body status checks (status field, error field, or similar) to those 8 call sites.
  If not real: document the assumption in a comment on constants.ts and close this item.
  Note: orderMailboxes correctly validates order_placed field as a business-success gate.

- [pre-c0, MEDIUM] Mock response shapes hand-invented, not doc-copied (2026-06-10)
  Mock dispatch functions (mock-dispatch.ts) provide test responses for all ten endpoints.
  Five mocks were copied from real Instantly V2 docs (via types.ts comments dated 2026-05-21):
    mockLeadsAdd: LeadUploadResponse structure matches docs
  Five mocks were hand-invented without external documentation:
    mockDfyOrder: $35/domain price is realistic but not from docs
    mockCampaignGet/mockCampaignPatch: basic fields match, but sequences field hardcoded empty
    mockEmailsList/mockLeadsList: generic { items, pagination } wrapper with no sample objects
    mockEmailGet: eaccount field is critical for reply routing (validated in polling.ts line 445)
      but response shape never cross-checked against real API
    mockLeadPatch: lt_interest_status field matches request, no full response structure from docs
    mockEmailReply: only id field needed, but completeness vs real API response unknown
  Reply-handling and polling paths must be verified against real V2 responses before trust.
  Action: after first Instantly campaign goes live, capture real API responses from the three endpoints
  used by reply handling (GET /emails/:id, POST /leads/list, PATCH /leads/:id) and audit response shapes
  against mock implementations. Update mocks if fields differ.
  Timing: verify within first week of live campaign operation.

- [pre-c0, MEDIUM] Silent drops in reply polling on missing campaign_id or eaccount (2026-06-10)
  pollInstantlyReplies in instantly.ts (lines 439-443) logs a warning and skips events if email.id
  or email.eaccount is missing. pollInstantlyLeadStatus (line 600) logs a warning if lead.id is missing.
  Current behavior: warning logged, event dropped, counts incremented (result.errors++), but no alert.
  At high reply volume (10+ per poll), silent drops could mask deliverability issues or API contract
  breaks. Current error count is logged (logger.info at lines 497, 628) but no threshold trigger for alerts.
  Action: add a trust-boundary counter to the polling result when missing-field errors exceed a threshold.
  Proposed: if result.errors >5 on any single poll run, capture as a Sentry warning with the error count
  and signal types affected. Operator can react if polling repeatedly drops high volumes of valid events.
  Timing: wire before first live campaign polling (same trigger as lead-status verification).

- [post-c0, LOW] No 429 backoff/retry on Instantly calls (2026-06-10)
  All ten call sites detect HTTP 429 (rate limit) and throw an error or return error result,
  but no exponential backoff or automatic retry logic exists. Polling loops have a safety ceiling
  (MAX_PAGES=50 per resource, MAX_PAGES_PER_CAMPAIGN=50) but no 429 handling other than fail-fast.
  Current assumption: Instantly's rate limits are generous enough that client-zero volume
  (1 campaign, ~50-100 prospects/week) will never hit 429 in production.
  If triggered: implement exponential backoff (2, 4, 8s delays) on any 429, up to 3 retries,
  then fallback to error. Refer to prospect-research-agent.ts for a working example (429 retry
  with p-limit coordination, lines ~380-420).
  Acceptable at client-zero volume. Revisit at scale once multiple concurrent clients hit real 429s.

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

- [DONE 2026-04-28] Paragraph independence validator added to validateEmails() (2026-04-27)
  15 patterns across two categories (pronoun-dependent + prescriptive voice) checked at non-opener
  paragraph start (paragraphs 2+). Paragraph 1 (opener) exempt — gets replaced at composition time.
  Commit: db1bffe. Synthetic test 7/7 passed. v6 regeneration: Variant B fired 1 retry on first pass,
  passed clean on attempt 1. 16/16 emails audited — no violations, no stilted prose.
  Anya Dayson composition dry-run: trigger→P2 transition clean without bridge (Haiku credit exhausted
  during test — bridge path tested logically but not live in this session; see item below).
  v5 archived as "5_pre_validator_extension" and "5" (archived). v6 now active.

- [DONE 2026-04-28] Anya bridge path live-tested after credits topped up
  Credits were topped up mid-session. Re-ran test-anya-compose.ts: both Haiku calls succeeded.
  CTA personalised to "Ascend" ("When referrals slow, does pipeline visibility become a challenge
  at Ascend?"). Bridge was generated but correctly suppressed by word-count gate — Anya's trigger
  is 38 words, leaving only 15-word headroom; 75 + ~16 = 91 > 90 cap. Gate working as intended.
  Bridge path is fully validated: generation call works, gate logic works, email reads coherently.

- [DONE 2026-04-28] approve_document_suggestion RPC fixed — non-numeric version string cast error
  Bug: FLOOR(v_max_version::numeric) broke when any row in strategy_documents had a non-numeric
  version string (e.g. "5_pre_validator_extension") because Postgres cast throws on non-numeric input.
  Fix: replaced FLOOR(v_max_version::numeric) with MAX(CASE WHEN version ~ '^[0-9]+(\.[0-9]*)?' THEN
  FLOOR(version::numeric)::integer ELSE NULL END) + 1 aggregate — skips non-numeric rows entirely.
  Applied via apply_migration (fix_approve_document_suggestion_version_cast). RPC now safe for any
  version string. Manual workaround (three SQL statements) was one-time only; not needed going forward.

- [monitor] v6 copy quality — two minor observations from 2026-04-28 audit
  A3 Email 3: "ICP docs, messaging, targeting, is yours to keep regardless." — subject-verb agreement
  error (plural subject with singular verb). Acceptable for now; fix on next messaging refresh.
  D3 Email 3 P2: "Full visibility into every email sent under your name tends to be what actually
  builds the trust." — slightly service-led; weakest transition in the v6 document. Monitor for
  reply rate signal; if D3 underperforms, rewrite P2 to match the insight-led pattern of B3/C3.

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

- [monitor] Supabase MCP parked 2026-05-01 — @0.5.10 pin is saved correctly in ~/.claude/mcp.json but tools are not loading in the current Claude Code session. Windsurf restart is not enough — the Claude Code session itself must be restarted for MCP processes to reinitialise. Revisit in next session by checking whether mcp__supabase__list_tables appears in the deferred tools list.

- [monitor] Supabase gen types injects a <claude-code-hint> XML artifact (source: Claude Code plugin/hook).
  Wrapper script scripts/regen-types.sh strips it automatically. Always use `npm run gen-types`
  instead of calling supabase gen types directly. If wrapper ever fails, investigate plugin/hook
  config in ~/.claude/ — the injection source is upstream of Supabase CLI.

---

## Post-build tasks

- [post-build] Context7 MCP integration
  Add after full build is complete. Not urgent.

- [post-build] Rename faq_entry_id column to faq_id for consistency with faqs table
  Phase 1 migration (20260429_reply_handling.sql) created reply_handling_actions.faq_entry_id
  with a comment referencing a non-existent faq_entries table. Phase 2 migration closed the FK
  loop — column now correctly references faqs.id. Cosmetic mismatch only; rename in a future
  schema-tidy pass. Flagged 2026-05-01.

- [post-build] Review Phase 1 implementation against ADR-018 (LLM vs deterministic)
  After client zero goes live, identify:
    - Any LLM calls that could be downgraded to rules
    - Any rules producing edge-case failures that justify LLM layers

- [post-build] Normalise messaging storage to { emails: [...] } envelope
  Currently messaging content in strategy_documents is stored as a bare JSON array
  while all other document types are objects (per ADR-012). Defer database migration
  until post-client-zero.

- [post-build] Schema migration discipline — pair every CHECK constraint with a code-side grep (2026-05-02)
  For every text/enum column with a CHECK constraint, grep the codebase for string
  literals that should be in the constraint before finalising the migration. The
  signals.signal_type mismatch was caught by Group 4 testing — the original constraint
  had 13 unused aspirational names while the Group 3 polling code wrote 3 different
  names, none of which were in the constraint. The mismatch was latent because the
  campaigns table was also empty, so no inserts were ever attempted.
  Rule: when writing a migration that adds or modifies a CHECK constraint, run:
    grep -r "'<signal_type_value>'" src/
  for each allowed value, confirming at least one writer exists. For any allowed value
  with no writer, add a comment explaining why it's forward-compatibility reservation
  rather than an active value. Flagged 2026-05-02.

- [post-c0-polish] Drop orphaned handle_new_auth_user function (2026-05-12)
  A function named handle_new_auth_user() exists in the DB alongside handle_new_user().
  handle_new_auth_user was the earlier name; handle_new_user is the current live trigger
  function (on_auth_user_created). handle_new_auth_user is not attached to any trigger and
  is dead code. Drop in a future schema-tidy migration:
    DROP FUNCTION IF EXISTS public.handle_new_auth_user();
  Verify no trigger references it before dropping: SELECT * FROM pg_trigger WHERE tgfoid = 'public.handle_new_auth_user'::regproc;

- [post-c0-polish] Configure Vercel Preview environment variables (2026-05-12)
  The audit found that RESEND_FROM_EMAIL and NEXT_PUBLIC_APP_URL are set for Production only,
  not for Preview. Preview deployments (auto-created on every non-main branch push) will throw
  on any email send and will link back to the production app URL in emails generated during
  testing. Add both vars to the Vercel Preview environment scope. Use Preview-appropriate
  values (e.g. NEXT_PUBLIC_APP_URL pointing to a stable preview URL or localhost, and a
  Resend test-mode key if available).

- [post-c0-polish] Remove 80% threshold warning log from icp-generation-agent.ts (2026-05-12)
  icp-generation-agent.ts lines ~85-97 contain a warning log that fires when the critical
  field completeness score is below 80%. This was a development-time debugging aid and is
  now noise in production logs. The warning does not block execution; it just clutters Sentry.
  Remove the check and the logger.warn call in a clean-up pass after client-zero goes live.

- [post-c0-polish] Empty x-internal-secret header logged when NEXT_INTERNAL_SECRET unset (2026-05-12)
  In agent routes, when NEXT_INTERNAL_SECRET is not set in env, the code does:
    const secret = process.env.NEXT_INTERNAL_SECRET ?? ''
  An empty string header is sent and matched against an empty string secret, which would
  accidentally grant internal-call bypass to any caller that sends an empty header.
  Fix: if NEXT_INTERNAL_SECRET is falsy, log a warning and require operator session auth
  regardless — do not treat an empty secret as a match. This is a defence-in-depth fix;
  the three missing Vercel env vars (including NEXT_INTERNAL_SECRET) must be set before
  production use regardless.

- [post-c0-polish] Migrate 4 INSTANTLY_API_BASE call sites to getInstantlyApiBaseUrl() (2026-05-21)
  The @deprecated INSTANTLY_API_BASE constant is still imported directly in 4 files:
    - src/lib/integrations/handlers/instantly/reply-actions.ts
    - src/lib/integrations/polling/instantly.ts
    - src/lib/integrations/handlers/instantly/validateCampaign.ts
    - src/app/api/cron/campaign-analytics/route.ts (or equivalent analytics handler)
  These were not migrated in Prompt 3B to avoid speculative risk to working code.
  Migrate opportunistically when each file is next modified for another reason.
  getInstantlyApiBaseUrl() evaluates process.env at call time — required for test overrides.

- [post-c0-polish] Hardcoded production Instantly URL in process-reply.ts (2026-05-21)
  src/lib/reply-handling/process-reply.ts around line 119 contains a hardcoded
  https://api.instantly.ai URL instead of using getInstantlyApiBaseUrl().
  This bypasses the configurable base URL pattern and cannot be overridden in tests.
  Fix when next touching process-reply.ts: replace with getInstantlyApiBaseUrl() call.

- [post-c0-polish] Empty personalisation_trigger strings pass the upload filter (2026-05-21)
  handleUploadLeads() in actions.ts filters prospects with .not('personalisation_trigger', 'is', null)
  which correctly excludes NULL values but allows empty strings ('') to pass through.
  An empty string trigger would upload a prospect with a blank personalisation field to Instantly.
  Fix: add .neq('personalisation_trigger', '') to the prospect query, or filter client-side
  before grouping by external_id.

---

## Design review findings (2026-06-10)

Code-level design audit via source analysis (browser auth prevented live testing).
Scope: client dashboard, intake questionnaire, strategy documents.
Design audit report at /docs/.design-audit-temp/design-audit-report.md

- FINDING-001 | Body text is 12px (WCAG AA violation claim)
  Doug triage: Intentional per design.md and parked, not a violation.

- FINDING-002 | Touch targets too small (12px nav items)
  Doug triage: Parked as out of scope. This is a desktop B2B dashboard delivered as a service, not a public mobile site.

- FINDING-003 | Sidebar not mobile-responsive
  Doug triage: Parked as out of scope. Desktop B2B service, not mobile-first.

- FINDING-004 | Two-column layout breaks on tablet
  Doug triage: Parked as out of scope. Desktop-only B2B service.

- FINDING-005 | Missing mobile layout
  Doug triage: Parked as out of scope. Desktop-only B2B service.

- FINDING-006 | No visible focus ring (WCAG 2.1 Level AA violation)
  Doug triage: Accepted as real pre-c1 accessibility polish. Keep open.
  Fix: add focus-visible:outline-2 focus-visible:outline-offset-2 to all interactive elements.

- FINDING-007 | Keyboard focus states unclear
  Doug triage: Accepted as real pre-c1 accessibility polish. Keep open.
  Audit: test Tab/Shift-Tab navigation; hover state exists but no distinct focus indicator.

- FINDING-008 | Hardcoded colors in components
  Doug triage: Parked as maintainability note, not a blocker.
  Issue: colors inline in TSX rather than centralized CSS variables.

Overall design score: C+
Overall AI slop score: A (clean, no generic patterns)

---

## Consolidated dry-run findings: Simcare + 360dungarvan B2, 2026-06-11

B2 dry-run walk with two real organizations (Simcare and 360dungarvan) exposed four findings:

- [pre-c0, HIGH] Transactional email junks on Outlook. Docs-ready notification landed in junk for an Outlook recipient, inboxed on Gmail. Target market is Microsoft-heavy. Action: SPF/DKIM/DMARC alignment audit on the Resend sending domain (margenticos.com, Resend EU), then re-test against an Outlook mailbox. From-address confirmed: "MargenticOS <notifications@margenticos.com>" (Production scope Vercel env).

- [pre-c0, HIGH] ICP agent industry mislabel. 360dungarvan is a primary schools business (education sector) but the ICP agent labeled it "Management Consulting." Root cause: TAXONOMY GAP. The canonical industry list (src/lib/agents/icp-filter-spec.ts, CANONICAL_INDUSTRIES) has 25 categories, all consulting/professional services. No education sector exists. When the ICP agent (docs/prompts/icp-agent.md line 369: "If a relevant industry is not on this list, use the closest match") falls back, it lands on "Management Consulting." Recommended fix: (1) Add 3 education-sector categories to CANONICAL_INDUSTRIES (Primary/Secondary Education, Higher Education, Education Services). (2) Add education examples to the ICP agent prompt to sharpen non-consulting business recognition. (3) Rerun 360dungarvan ICP after taxonomy fix.

- [VERIFIED 2026-06-11] Green Flag provenance — database investigation complete. The 360-bia-og (not 360dungarvan) strategy documents contain 50+ references to "Green Flag" and "Green Schools," appearing in ICP, Positioning, and Messaging generated content. Database scan results: (a) intake_responses: zero matches for "Green Flag" or "Green Schools"; (b) intake_website_pages: zero matches; (c) prospect_research_results: zero matches in synthesis_reasoning or trigger_text. Conclusion: UNSOURCED in client data. "Green Flag" appears ONLY in generated output, never in stored inputs. This represents an agent synthesizing plausible business context (Irish school sustainability program) without grounding in actual intake/research data. The ICP, Positioning, and Messaging agents all reference Green Flag as though it were client-provided, when it is pure generation. Addresses the architectural gap: agents should flag thin/absent context rather than filling gaps with plausible fiction.

- [VERIFIED 2026-06-11] Em-dash verification — database scan complete. Query: emdash counts on strategy_documents for 360-bia-og and simcare organisations. Result: ZERO em-dashes found across all document types (ICP v1, Positioning v1, TOV v1, Messaging v1, and Simcare ICP v1-v2). Plain text fields all null (expected). JSON content fields: emdash_count = 0 on all rows. Verification confirms: assertNoDashes gate is functioning correctly on ICP, Positioning, TOV agents. Messaging agent scrubAITells runtime scrub is also working. All documents stored without em-dash contamination.

- [post-B2 decision, deferred] Document cascade: regenerated ICP or positioning should set a staleness indicator on the messaging document, never auto-regenerate downstream content. Awaiting operator sign-off on 360dungarvan ICP refresh before implementing cascade logic.

- [pre-c1] Operator per-client intake-form view, read-only, small standalone build, elevated priority per operator. Does not wait for full OPS-1. Operator needs visibility into submitted intake data (what the client entered) to cross-check ICP output against the source.

- [pre-c1] Agent quality batch:
  (a) Industry taxonomy expansion per root cause 2 above (add education sectors, rerun 360dungarvan, validate across 3 clients).
  (b) ICP and positioning agents over-index on margin/monetization pain points; rebalance across pain dimensions for non-consulting verticals.
  (c) TOV formality clamp: cold email brevity and conversational register override client brand formality as expressed within channel constraints.

- [pre-c1, research first] Break-up email (Email 4) analysis. Variants are near-identical across conditions; review whether variation is intended. Client preference for hyperlinked company name in final email requires deliverability research; default remains no links in cold email bodies.

- [note] B2 validated: outsider auth, cold intake, doc generation, revision loop, and approvals on two real orgs end-to-end. Compose and mock-dispatch leg not exercised in B2; covered by the 2026-06-04 lap on the reference org. Returning-user login leg for 360dungarvan pending one confirmation.

- [pre-c1, product framing] Strategy documents land as impressive but clients are unsure of their purpose. Add framing copy in UI and onboarding positioning the documents as the engine that powers campaigns. No feature build.

---

## Post-Tier-1 items

- [post-tier1-B] Uptime monitoring (2026-04-24)
  Sentry catches application errors but not infrastructure downtime (Vercel, Supabase, DNS).
  Lightweight monitor needed before 3+ paying clients. Options: UptimeRobot (free tier sufficient)
  or Vercel's built-in monitoring. ~30 min to set up. Not urgent pre-c0 but add before Tier 1.

- [DONE 2026-04-29] Drop voice_samples column from intake_responses
  Eligibility check returned zero rows (MargenticOS org backed by 3 intake_files, extraction complete).
  Row deleted via Supabase MCP: DELETE FROM intake_responses WHERE field_key = 'voice_samples'.

- [post-tier1] Per-client ICPFilterSpec approval UI (per ADR-015)
  Operator can review generated filter spec before it's used for sourcing.
  Allows manual tightening of fields that drift on LLM regeneration — e.g.
  company_headcount_max occasionally exceeds the ICP's own Tier 3 disqualifier
  zone due to LLM variance. Manual approval step catches and corrects.
  Trigger: after 3+ client runs, or earlier if drift is observed.

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

## Group 4 (Reply Routing + Orchestrator) deferred items (2026-05-02)

- [DONE 2026-05-02] signals_signal_type_check constraint does not include 'reply_received'
  RESOLVED. Migration 20260502163646_signals_signal_type_constraint applied 2026-05-02.
  Constraint now includes reply_received, email_bounced, lead_unsubscribed, and 10 anticipated
  types. Verified live DB 2026-05-21 as part of Prompt 3A pre-build check. Sentry alerting
  on signal write failures also added in Prompt 3A Commit 3 (writeSignal in polling/instantly.ts).

- [monitor] DRAFT_FAILURE_CIRCUIT_BREAKER threshold may need tuning (2026-05-02)
  Currently set to 3 failures in 24h. At client-zero volume (20–30 replies/week) this
  may be too aggressive — 3 Anthropic API timeouts in a burst could suppress all drafting.
  Tune after first 30 days of live data. Consider raising to 5 and adding a Sentry alert
  when the circuit breaker fires so it's visible without log-diving.

- [phase2] process-reply.ts cron concurrency — no protection against overlapping runs (2026-05-02)
  Current guard: 55s function timeout < 5min cron interval (by design).
  If cron interval is shortened or the function runs long, two instances can overlap.
  The orchestrator's idempotency check (reply_drafts by signal_id) protects against
  duplicate drafts, but the action row insertion is not idempotent across two concurrent
  processes. Post-Group-4: assess whether the 55s/5min margin holds as batch sizes grow.

- [DONE 2026-05-07] Drafter null return loses the signal permanently
  RESOLVED. orchestrateDraft() now throws instead of returning log_only when draftReply()
  returns null (src/lib/reply-handling/draft-orchestrator.ts lines ~287-300). The caller's
  existing try/catch in processOneSignal() handles the throw: logs the error, returns 'error',
  leaves the signal unprocessed. Next cron run retries. After DRAFT_FAILURE_CIRCUIT_BREAKER
  (3) failures in 24h, the circuit breaker writes a draft_failed placeholder for operator
  triage. No schema change needed — agent_runs failure count IS the retry counter.
  Commit: see fix(reply-handling) commit from session 2026-05-07.

- [phase2] sender_first_name sourced from organisations.founder_first_name (2026-05-02)
  The campaigns table has no sender_first_name field. The orchestrator and drafter use
  organisations.founder_first_name as a proxy. This is correct for single-operator orgs
  but breaks when MargenticOS sends on behalf of a team member who is not the founder.
  Fix: add sender_first_name to campaigns table so it can be set per-campaign.
  No urgency at client-zero stage (single operator per org). Flag before multi-operator.

- [phase2] NULL outbound body backfill for existing signals (2026-05-02)
  Signals ingested before Group 4 was deployed have NULL original_outbound_body.
  These will route to manual_required. No backfill is planned — the field is best-effort
  and the operator handles these as manual. Note for future: if volume of
  manual_required with reason='original_outbound_not_captured' is persistently high,
  consider a batch backfill script against Instantly API (feasible, not urgent).

- [DONE 2026-05-12] Group 7 — FAQ curation UI (extraction queue + knowledge base).
  Commits: 3d2412f (initial ship: RLS migration, 6 API routes, ExtractionCard, FaqRow,
  FaqCurationView, page.tsx, OperatorSidebar nav entry); 917b95f (fix: POST select
  expanded to return full FaqListItem — blank card bug on Add FAQ resolved).

- [DONE 2026-05-03] Group 5 — send-on-approval wiring (ADR-020 sign-off, approve/reject endpoints,
  send-approved-draft orchestrator, Sentry alerts). Commits: feat(reply-handling):
  deterministic sign-off and Calendly substitution; feat(reply-handling): send-approved-draft
  orchestrator; feat(api): approve and reject endpoints for reply-drafts;
  fix(reply-handling): update Phase 1 auto-Calendly sign-off per ADR-020;
  feat(monitoring): Sentry alerts for send failures; docs: ADR-020 + design.md + agents.md
  + BACKLOG updates.

- [phase2] Retry endpoint for send-failed drafts (2026-05-03)
  POST /api/reply-drafts/[id]/retry — re-attempt the send without requiring operator to
  re-approve. Only valid when draft.status='send_failed'. Useful when failure was
  transient (Instantly timeout, network blip). Should call sendApprovedDraft directly
  after flipping status back to 'approved' with an UPDATE WHERE status='send_failed'.
  Gate: operator role + org scoping required (same pattern as approve endpoint).

- [phase2] Regenerate endpoint for operator-rejected/failed drafts (2026-05-03)
  POST /api/reply-drafts/[id]/regenerate — discard the current draft body and trigger
  a new AI draft for the same signal. Useful when operator rejects draft quality rather
  than the send itself. Should create a new reply_drafts row (not overwrite the existing
  one, so the rejection history is preserved). Requires reply-draft-agent to be callable
  from an API route with a known signal_id and tier.
  NOTE: draft-orchestrator.ts:168 idempotency check returns kind='drafted' for
  rejected/send_failed drafts (treating the existing draft as still valid). This is
  intentional while no regenerate path exists — revisit and adjust when this endpoint
  is built, so the orchestrator does not skip regeneration requests.

- [phase2] Scenario 2 thread detection — multi-turn positive_direct_booking (2026-05-03)
  Currently positive_direct_booking (≥ 0.90 confidence) triggers Phase 1 auto-Calendly
  regardless of thread depth. A multi-turn thread where the prospect is booking after
  exchanging several messages may warrant a warmer, more contextual response than the
  standard "grab a slot" template. Consider: if thread has > 2 prior turns, route to
  Tier 2 (operator draft) even at high booking confidence. Requires thread-depth signal
  in the raw_data or a secondary classification step.

- [post-build] Schema-action coupling discipline — write-after-act pattern (2026-05-02)
  When an action row records an outcome that depends on a downstream call (orchestrator,
  drafter, external API), the action row must EITHER be written after the downstream call
  succeeds, OR use a distinct in-flight value that the idempotency check does not treat
  as terminal. Caught in Group 4 review pass (2026-05-02): the original code wrote a
  log_only action row before calling orchestrateDraft. A throw left a terminal-looking row
  that caused the next cron run to log "signal already handled" and mark the signal
  processed — permanently losing it. Fixed in same session (Option A: row written after
  orchestrateDraft returns; throw leaves no row; signal retries cleanly).
  Pattern to apply for any future code that splits "decide" from "act."

---

## ADR-001 channel/source agnosticism — pending decision (2026-04-29)

Four findings from the Phase 1 code review. The reply-handling layer works correctly
for Instantly today. These gaps only matter when a second reply source (Lemlist, GHL)
is integrated. Refactor cost: ~2-4 hours. Decision: fix now or defer to Phase 2.

- [pending-decision] Finding C3-1 — resolveInstantlyLeadId inside the processor
  process-reply.ts:103-125 calls https://api.instantly.ai/... directly.
  ADR-001 violation: Instantly API calls belong only in handler files.
  Fix: move to reply-actions.ts as resolveLeadId(raw, apiKey, fromEmail). Processor
  calls handler function, not the Instantly URL.

- [pending-decision] Finding C3-2 — suppressLead / sendThreadReply imported by name into processor
  process-reply.ts:34-35 imports from handlers/instantly/reply-actions directly.
  Adding a second source requires dispatch branching in processOneSignal.
  Fix: capability-based dispatch — getReplyHandler(source).suppress(...) — so the
  processor has zero awareness of which source it is handling.

- [pending-decision] Finding C3-3 — instantlyApiKey threaded as a named primitive through the call stack
  route.ts:56, process-reply.ts:235 and :562. Multi-source system resolves credentials
  via the capability registry inside the handler, not as a vendor-named string parameter.
  Fix: getCredential(capability) inside the handler; processReplies(supabase) takes no key.

- [pending-decision] Finding C3-4 — raw_data field extraction uses Instantly V2 schema
  process-reply.ts:293-295, :338-344. from_address_email, body.text, eaccount are
  Instantly-specific field names. A Lemlist signal's raw_data would have different fields;
  extraction silently returns undefined and the processor proceeds with empty body and null fromEmail.
  Fix: source-aware field extractors keyed by signal.source — one per integration source.

  Defer trigger for all four: immediately before any non-Instantly reply source is integrated.
  If deferred, add a code comment at each violation site pointing to this BACKLOG entry.

---

## Phase 2 deferred items (from ADR-011, ADR-013, ADR-014, ADR-015, ADR-017)

- [monitor] FAQ_USE_THRESHOLD tuning — watch first 50 drafts before adjusting (2026-05-01)
  Current threshold: 0.65 (Jaccard score). Below this score an FAQ is ignored even if passed in.
  This value was set conservatively. If operators consistently see good FAQs being ignored, lower
  to 0.55. If hallucinated FAQ content appears in drafts, raise to 0.70.
  Trigger: after 50 real drafts have been reviewed via test-drafter output or production agent_runs.
  Location: src/lib/agents/reply-draft-agent.ts — FAQ_USE_THRESHOLD constant.

- [phase2] Multilanguage reply handling — currently downgrades to Tier 3 (2026-05-01)
  The reply-draft-agent detects non-English replies and downgrades to Tier 3 with an ambiguity_note
  stating the language. This is correct behaviour for now. In Phase 2 (if international clients are
  onboarded), consider: (a) operator-declared language preference per campaign, (b) language-matched
  draft generation, (c) explicit suppression of non-target-language replies.
  Do not build until a real client with non-English replies exists.

- [pre-c0] Group 4 caller must pre-check tierHint before invoking reply-draft-agent (2026-05-01)
  reply-draft-agent returns null if tierHint=3 and the model returns tier=2 (tier mismatch guard).
  The Group 4 reply handler (not yet built) must handle this null gracefully — log it as
  skipped_idempotent or flagged_tier_mismatch in agent_runs, not as an error.
  Reminder: the drafter does NOT write to reply_drafts or agent_runs — the caller does.
  Also: if >5% of Tier 2 inputs produce Tier 3 outputs in the first week of live traffic,
  review coherence check rules in docs/prompts/reply-draft-agent.md.

- [monitor] Group 5 sign-off reminder — reply_drafts.final_sent_body must be signed by operator first name (2026-05-01)
  The reply-draft-agent generates drafts but does NOT enforce the sign-off rule.
  The Group 5 send step must verify that the final_sent_body ends with the operator's first name
  on its own line before sending. This is a CLAUDE.md requirement: "Sign as [Client Company Name] Team"
  is the rule for automated replies; the agent uses senderFirstName as the sign-off in drafts.
  Reminder set here so Group 5 spec explicitly validates sign-off before send.

- [phase2] Deferred-followup handling system (2026-05-02)
  Trigger: 5+ deferred-followup replies received OR first paying client onboards.
  Some prospects reply with timing pushbacks naming a specific future window ("reach out
  in 3 months", "circle back after Q3", "ping me when we hire our marketing lead").
  Currently these route to Tier 3 operator queue with no scheduled follow-up — relies on
  operator memory or external CRM tracking. Manageable for client zero; will not scale
  past 5 active deferred prospects without a system.
  What's needed:
    - New classifier intent: defer_followup (or similar)
    - Schema: scheduled_followups table (prospect_id, deferred_until_date,
      original_signal_id, status, original_thread_context)
    - Date extraction: parse natural-language timeframes from replies
      ("3 months" → date), with operator override
    - Scheduled job: daily check for due follow-ups, surfaces to operator queue with
      a pre-drafted re-engagement message that references the original thread
    - Re-engagement message generator: similar to reply-draft-agent but with
      thread-resumption framing
  Reasoning for deferring: building this without real defer-reply data risks designing
  wrong abstractions. Different prospects use different formats. Phase 2 routes these
  to operator queue manually for now. Decide build scope when first client has 5+
  deferred prospects.

- [phase2] Re-engagement protocol for prospects who completed sequence without response (2026-04-24)
  Trigger: 60–90 days post-sequence completion with zero reply.
  Scope: re-research for fresh signal, possible re-tier-classification, different copy framing
  for "second contact" (acknowledge they heard from us, show something has changed).
  Do not build until client zero produces real sequence completion data.

- [phase2] Per-client Apify actor configuration for LinkedIn research (2026-04-24)
  The v2 research agent uses shared Apify actors via a single operator API key.
  At higher client counts, consider per-client actor runs or separate API keys for
  billing separation and rate limit management.
  Trigger: 3+ paying clients running concurrent research batches.

- [phase2] Research-specific config overrides when ICP/TOV docs aren't sufficient (2026-04-24)
  Trigger: an actual gap emerges during real client research runs (e.g. industry-specific
  search terms, persona-specific signal weights, non-standard geography configs).
  Do not build speculatively. Note the gap if it surfaces and scope it then.

- [phase2] Explicit qualification checkpoint between sourcing and research (2026-04-24)
  Trigger: unqualified prospects slip through sourcing into the research queue, OR client reports
  mismatched targeting that wasn't caught by the TAM gate / ICP filter spec.
  Design: deterministic rule-based pre-screen step before a prospect enters the research queue.
  Not needed until the pattern is observed in real data.

- [phase2] Re-evaluate signal processing agent and warnings engine build readiness
  Deferred from pre-c0 on 2026-04-23. Signal processing and warnings only produce value
  once sends are landing and reply signals are flowing. Re-evaluate after 30 days of
  client zero operation, once real signal volume and shape are known. Do not build
  speculatively against a schema.

- [phase2] Hard-cap company_headcount_max in deriveFilterSpec() derivation logic
  If the approval UI (above) exists, this becomes redundant. If UI is deferred,
  deterministic clamp prevents drift from reaching Apollo. E.g. clamp at
  max(tier3_disqualifier_threshold - 1) or hardcoded 12 for consulting ICPs.
  Location: src/lib/agents/icp-filter-spec.ts, deriveFilterSpec().

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

- [phase2, trigger: 30+ extractions produced and operators flagging "should have been extracted" cases in curation] Tune filler-detection thresholds in src/lib/faq/filler-detection.ts.
  Currently: 20-word floor, filler-prefix list, Jaccard 0.95 unedited-draft threshold.
  Known documented limitation: answers of exactly 18-19 substantive words are skipped by Rule 1
  (see fixture 07). Tune based on what operators actually flag as missed — not speculatively.
  Location: src/lib/faq/filler-detection.ts constants at top of file.

- [phase2, trigger: 5+ clients OR extraction adds noticeable Tier 3 send latency] Move extraction from synchronous post-send to queued background job.
  Currently runs synchronously after Tier 3 send (Group 4 wiring). Acceptable at founding-client
  volume. At 5+ clients with concurrent Tier 3 sends, this could add measurable latency to the
  send path. Move to Vercel Queues or pg_cron background job when the trigger fires.

- [phase2, trigger: operators routinely heavily editing Tier 2 drafts before sending] Build edit-aware FAQ refinement extraction.
  Currently: Tier 2 sent replies are not extracted. They already used an FAQ and sending them
  does not expand the knowledge base. If operators consistently heavily edit Tier 2 drafts before
  sending, the heavy edits suggest the FAQ could be refined — the extraction agent could compare
  the Tier 2 draft to the final sent body and extract the delta as a FAQ update candidate.
  Do not build until the pattern is observed in real production data.

- [pre-c1] Reconcile ADR-017 with implementation reality (2026-05-13)
  ADR-017 specifies sourced_tier on prospects governing research path,
  composition template, and sending domain. The column was never added.
  The actual implementation branches on has_dateable_signal + signal_relevance
  (compose-sequence.ts:422–424) and only chooses whether to add a bridge
  sentence — none of the other ADR-017 behaviours exist.

  Two paths to reconcile:
  (a) Update ADR-017 to reflect actual implementation as the canonical spec
      (the simpler truth). Done as part of the 13 May 2026 doc update —
      ADR-017 now reflects reality but preserves the original spec.
  (b) Build the Sourcing Orchestrator + implement the original ADR-017
      behaviours properly. This is multi-day work and blocked on the
      Sourcing Orchestrator design, which has never been formally scoped.

  Decision required before client one IF the tier-based routing has
  commercial value — i.e., if c0 evidence suggests that differentiating
  prospect quality at sourcing time would meaningfully improve results.

  Trigger: Sourcing Orchestrator scoping session, OR c0 evidence that
  current single-path composition is leaving meaningful pipeline on the
  table.

- [pre-c1] Add covering index on campaigns(organisation_id) (2026-05-21)
  Audit (2026-05-21) flagged campaigns_organisation_id_fkey has no covering index.
  Performance advisor warning. Low impact at single-digit orgs but worth fixing before scale.
  Single migration: CREATE INDEX IF NOT EXISTS idx_campaigns_organisation_id ON campaigns(organisation_id);

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

- [phase2, trigger: multiple operators active simultaneously OR sub-30s reply latency becomes a competitive differentiator] Consider swapping reply-drafts polling to Supabase Realtime (2026-05-05)
  Current: TriageQueue.tsx polls GET /api/reply-drafts every 30 seconds. Works correctly for
  single-operator usage at client-zero volume.
  Supabase Realtime (postgres_changes subscription on reply_drafts INSERT/UPDATE) would give
  instant push updates and eliminate polling latency entirely.
  Trigger (a): multiple operators working the triage queue simultaneously — polling causes each
  operator to see stale data between 30s intervals, creating approval races on the same draft.
  Trigger (b): sub-30s reply response time becomes a measurable client-facing differentiator.
  Do not build speculatively. The 30s polling interval is adequate for client zero.

- [phase2] Human pre-call qualification protocol (Layer 3)
  Option A: Doug manually qualifies first 5-10 meetings per client to build
  intuition, then automate via reply handling agent.
  Option B: hire an SDR/ops person once volume justifies.
  Target: 60-70% positive-reply-to-qualified-held conversion (tier-1 agency benchmark).

- [phase2] Qualified meeting guarantee language in founding-client contracts
  Decide: replacement policy, credit policy, or noise-as-overhead.
  Industry norm: replacement or credit for unqualified meetings.

- [phase2, Decision 2 resolved 2026-05-12] Tune name-detection false positives.
  Decision: UI-layer warnings only — detection layer (faq/name-detection.ts) untouched.
  ExtractionCard shows an amber warning with flagged tokens; operator dismisses false
  positives visually and can edit after approving. Remaining phase2 work: tune detection
  heuristics to reduce noise (single-letter "I", "AI-*" compound terms) once real
  extraction data from client zero exists to calibrate against.

---

## Phase 3 deferred items

- [SUPERSEDED 2026-05-01 by ADR-019] AI reply handling for information requests (with human override). Delivered as Phase 2 tier model: Tier 2 AI drafts for operator approval, Tier 3 starting-point with operator rewrite required. See ADR-019.
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
- [x] Auth email routes via Resend custom SMTP — login@margenticos.com (verified domain), 10/hr
      rate limit, OTP-code fallback on login screen. DONE 2026-06-05. No further action needed.

---

## Lessons learned

- [lesson] Next.js 15 App Router does not propagate API route handler errors as
  unhandled exceptions. Sentry's default integration will not capture them.
  Fix: export `onRequestError` from instrumentation.ts using
  Sentry.captureRequestError (available in @sentry/nextjs v10+). This applies
  to every Next.js 15+ project; stock Sentry tutorials predating Next.js 15
  do not cover it. Took one diagnostic session to isolate.

- [lesson] Vercel Hobby rejects sub-daily cron schedules at build time (2026-04-29)
  vercel.json crons with schedules that fire more than once per day (e.g. "0 * * * *" = hourly)
  cause Vercel to reject the build entirely on Hobby plan. The rejection happens silently —
  GitHub pushes succeed, the webhook fires, but Vercel refuses to build. No email, no dashboard
  alert, no build log. The previous production deploy continues serving indefinitely.
  This caused 6 days of commits to go undeployed.
  Fix: remove sub-daily cron entries from vercel.json entirely. Use pg_cron for all sub-daily
  scheduling (Supabase pg_cron + pg_net → Vercel endpoint is the established pattern here).
  Daily crons (once per day or less) work on Hobby.

- [lesson] Supabase Hobby tier: pg_cron config vars via ALTER DATABASE SET blocked (2026-04-29)
  `ALTER DATABASE postgres SET "app.*"` requires supabase_admin role.
  The Supabase SQL editor runs as the postgres role — permission denied.
  `current_setting('app.*', true)` therefore returns NULL, and pg_net fails with a
  NOT NULL constraint on the url column of http_request_queue.
  All cron.job_run_details entries showed status "succeeded" (pg_net queued the request)
  but the actual HTTP call never fired — silent failure for 10+ runs.
  Fix: hardcode URL and CRON_SECRET directly in the cron.schedule() command string.
  Pattern documented in both migration files. CRON_SECRET in plaintext in cron.job.command
  is acceptable for low-impact trigger tokens; not acceptable for higher-value credentials.

- [lesson] Sentry serverless flush requirement — always await flush before returning (2026-04-30)
  Sentry.captureCheckIn (and any other SDK event call: captureException, captureMessage) enqueues
  an async HTTP request rather than sending immediately. In a Vercel serverless function, the
  container is frozen the instant the handler returns. Any buffered events queued after the last
  await are dropped — the outgoing HTTP request never fires.
  Symptom: the in_progress check-in reaches Sentry (it had time to flush while the function was
  doing async work), but the ok/error check-in is dropped (called immediately before return),
  causing Sentry to fire a timeout alert on every single run.
  Fix: after every Sentry.captureCheckIn / captureException / captureMessage call that immediately
  precedes a return, add: `try { await Sentry.flush(2000) } catch {}`
  The try/catch is mandatory — a Sentry network timeout must never block the endpoint from
  responding to pg_cron. Sentry is a side-effect, never a blocker.
  Applied: instantly-poll/route.ts (2 flushes) and process-replies/route.ts (3 flushes).
  Commit: f657baa. Applies to any new serverless route that uses Sentry SDK calls.

- [lesson] Sentry issue alert rules with multiple filters use AND logic — use one filter per rule (2026-05-01)
  When creating Sentry issue alert rules via the REST API, multiple `filters` entries are AND'd:
  ALL filter conditions must match a single event simultaneously. Two message-contains filters
  targeting different error strings can never both match one event — the rule can never fire.
  The `filterMatch: 'any'` field appears to be ignored or unsupported in the API despite what
  scripts may set. The Sentry UI does support "any of" filter logic, but this is not reliably
  exposed through the API.
  Fix: one filter per rule. If two message strings share the same conditions and actions, create
  two rules. The redundancy is worth having rules that actually fire.
  Script reference: scripts/fix-sentry-alert-rules.ts (shows correct single-filter pattern).

- [lesson] send.ts captureException has no flush — add before next production email route (2026-05-01)
  src/lib/email/send.ts:43 calls Sentry.captureException() in the sendTransactionalEmail failure
  path, with no Sentry.flush() before it returns. The same serverless drop problem applies.
  Currently safe: the only caller is the dev-gated /api/resend-test route.
  Fix required: add `try { await Sentry.flush(2000) } catch {}` in sendTransactionalEmail()
  before any production API route calls it for the first time.

- [lesson] pdf-parse v2 is a class-based API; Turbopack cannot resolve its internal path (2026-04-29)
  pdf-parse changed its API between v1 (function: `pdfParse(buffer)`) and v2 (class: `new PDFParse({ data })`).
  The internal-path workaround (`pdf-parse/lib/pdf-parse.js`) that bypassed the v1 startup
  test-file issue does not resolve under Turbopack and causes a build failure.
  Fix: add `serverExternalPackages: ['pdf-parse']` to next.config.ts (tells Turbopack to leave
  the package to Node.js at runtime), and use the current class API: `new PDFParse({ data: buffer }).getText()` which returns `{ text: string }`.
  Location: next.config.ts, src/lib/intake/extract-text.ts.

- [lesson] Completed-claim-vs-reality miss: RESEND_FROM_EMAIL domain flip (2026-06-05)
  The 2026-06-04 batch summary reported item 6 — "flip RESEND_FROM_EMAIL from
  notifications.margenticos.com to margenticos.com sending domain" — as DONE.
  Discovered 2026-06-05 (live-path audit): RESEND_FROM_EMAIL was still set to
  notifications@notifications.margenticos.com in both Vercel production and .env.local.
  The intent was recorded; the actual env var update was never executed.
  Resolution 2026-06-05: updated to "MargenticOS <notifications@margenticos.com>" in
  Vercel production, Vercel preview, and .env.local. Will take effect on the next deploy.
  Also: [post-c0-polish] Configure Vercel Preview environment variables (2026-05-12 entry)
  is partially resolved by this change — RESEND_FROM_EMAIL is now present in both scopes.
  Pattern to prevent recurrence: any session summary item marked DONE that involves a
  config-layer change (env var, DNS record, Supabase setting) must include a read-back
  verification step (`vercel env ls | grep NAME`, dashboard screenshot, etc.) before
  the DONE claim is written. Intent ≠ execution for config changes.

---

## Application-layer notes

- [reminder] Application queries against organisations for client-facing views must never
  SELECT payment_status, contract_status, or engagement_month. RLS filters rows, not columns.
  App layer is responsible.

- [reminder] Prospect-facing copy must never quote precise system timings. (2026-05-05)
  "We'll respond within 30 minutes" / "same business hour" / "within X minutes" must never
  appear in prospect-facing emails, auto-replies, OOO holding messages, or agent-generated
  copy that reaches a prospect. These create contractual-feeling expectations that break
  silently if the system is offline, delayed, or the operator is away.
  Operator-facing UI (e.g. triage queue documentation, CLAUDE.md guidelines) can and should
  reference timings — that is for internal process clarity, not prospect expectations.
  Applies to: reply-handling templates, positive reply auto-response, holding messages,
  any future marketing copy generated by agents.

- [reminder] Every new migration must enable RLS AND add at least one policy in the same migration file. (2026-05-05)
  Enabling RLS with zero policies locks out ALL authenticated users silently — no error is
  returned, just empty rows. This was observed in Group 6 testing: reply_drafts and faqs had
  RLS enabled with no policies, causing the triage queue to show "Queue is clear" despite
  5 seed rows existing in the database.
  Rule: never ship a migration that runs ALTER TABLE ... ENABLE ROW LEVEL SECURITY without
  a corresponding CREATE POLICY in the same file. If the policy is "operators only", use the
  is_operator() pattern. If the policy is "service role only", add an explicit restrictive
  policy for authenticated callers. Review migration files before applying.

- [reminder] CRON_SECRET stored plaintext in cron.job.command — acceptable for this low-impact trigger token; not a pattern for high-value credentials. Use Supabase Vault for those.

- [reminder] Vercel Hobby silently rejects sub-daily cron schedules at build time — all scheduling for sub-daily jobs uses pg_cron. vercel.json crons entry must be empty or daily-only.

- [documentation] Two by-design Supabase advisor warnings (2026-05-21)
  authenticated_security_definer_function_executable will remain flagged for get_my_organisation_id()
  and is_operator() after the May 2026 REVOKE FROM PUBLIC fix. These cannot be cleared without
  breaking RLS policies — 24 policies depend on both functions being callable by authenticated users.
  Switching to SECURITY INVOKER would cause infinite recursion in users-table RLS (is_operator()
  queries users, which has RLS policies that call is_operator()). The real security risk was anon
  access, which is closed. Do not "fix" these warnings — they are by design. Future audits should
  explicitly note this.

- [post-c0-polish] Mutable search paths on append_faq_variant and set_updated_at (2026-05-13)
  Per RLS verification report 13 May 2026 P1. Cosmetic, no security implication at current
  exposure level. Add SET search_path TO 'public' to both function definitions to match the
  pattern already used in approve_document_suggestion. See P1-3 in
  /docs/discovery/2026-05-13-rls-verification.md.

- [DONE 2026-05-21] send-approved-draft.ts used process.env.INSTANTLY_API_KEY (env var) — was broken
  RESOLVED in Prompt 3A Commit 4. The function used process.env.INSTANTLY_API_KEY which was never
  set in Vercel (confirmed via `vercel env ls`). Any call to sendApprovedDraft() in production
  would have failed with "INSTANTLY_API_KEY not set". Went undetected because no live campaign has
  produced real reply drafts yet (no real traffic pre-c0). Fixed by replacing env-var lookup with
  getInstantlyApiKey(organisationId) helper (DB-based, consistent with the two cron routes).
  Note: this slipped past Prompt 2 audit because send-approved-draft.ts wasn't in the inline
  credential review scope at that time. Lesson: any function that calls Instantly must use the
  integration_credentials table, never a standalone env var.

- [post-c0-polish] integrations_registry api_handler_ref paths wrong in all 7 existing rows (2026-05-21)
  All seed rows in supabase/migrations/20260420_seed_integrations_registry.sql point to
  src/lib/handlers/<tool> but actual handler files live at src/lib/integrations/handlers/<tool>/.
  The api_handler_ref column is not resolved at runtime (registry is config-only — no dispatcher),
  so this causes no functional breakage. Fix before building a runtime dispatcher: update all
  7 rows to the correct paths. New rows added in Prompt 3A (can_upload_leads, can_order_mailboxes)
  use the correct src/lib/integrations/handlers/ path.

- [DONE 2026-06-02] Operator nav-context drop on intra-page navigation (2026-05-21)
  When an operator navigates between sidebar links while viewing a client via
  /dashboard/operator/clients/[id], any ?client= query param (or equivalent context state)
  is dropped, causing pages to load the operator's own org data instead of the viewed client's.
  Fixed by appendClientParam: all OperatorSidebar nav links now carry ?client= so the param
  persists across navigation. Resolved as part of ADR-022 closure (2026-06-02).

---

## Security — deferred from /cso audit 2026-06-01

### ~~[post-c0-paid-tier] Migrate CRON_SECRET from Postgres GUC to Supabase Vault~~
- SUPERSEDED 2026-06-05: expanded scope (both CRON_SECRET + SUPABASE_PENDING_REVIEW_WEBHOOK_SECRET),
  reclassified to [pre-c1] (Vault API available on Free tier), URL repoint included.
  See "[pre-c1] Supabase Vault: move two DB-stored secrets out of plaintext" in the
  Live-path / config audit section at the bottom of this file.

### [post-c0-polish] Flip CSP from report-only to enforcement
- Shipped 2026-06-02 in commit 65d077f as Content-Security-Policy-Report-Only
- Action: change header name from `Content-Security-Policy-Report-Only` to `Content-Security-Policy` in next.config.ts (single-word change)
- Prerequisites: 2 weeks of clean violation logs from real usage (c0 + early founding clients)
- Risk if flipped too early: blocks legitimate requests (Sentry, Supabase realtime, fonts) and breaks app subtly
- Trigger: 2 weeks of real-usage browser console with no CSP-would-have-blocked warnings

### [post-c0-polish] Configure CSP report-uri to Sentry endpoint
- Currently CSP violations only visible via browser console (manual check)
- NOT NEEDED at <10 clients — manual checking is sufficient
- Becomes valuable as automated monitoring infrastructure when client count grows
- Trigger: approaching 10 paying clients OR before flipping CSP to enforcement, whichever first

### ~~[post-c0-polish] Rotate SUPABASE_PENDING_REVIEW_WEBHOOK_SECRET~~
- SUPERSEDED 2026-06-05: audit found this secret also stored as plaintext in the DB trigger
  action statement, not just in the original chat context. Migration approach (Vault) covers
  rotation by construction. See "[pre-c1] Supabase Vault" entry in Live-path / config audit
  section below.

### [discipline-not-task] No flat-file prospect data in repo
- Finding #6 from /cso 2026-06-01-cso.json
- Resolved 2026-06-02 by moving dogfood-prospects-batch-1.csv to ~/Documents/
- Reminder: prospect/PII data belongs in the database (RLS-protected), never in a flat file in the repo directory — even if gitignored

---

## Segment-aware sending path — deferred items (June 2026)

### [post-c0] Set is_default=true in the "create org" path
- When a new org is created (intake flow or operator-created), the first segment must
  have is_default=true set at insert time.
- Currently the backfill migration handles all existing orgs. Any new org created after
  2026-06-03 without is_default=true set will have no primary segment and all
  resolveOrgPrimarySegment() calls will return null, causing the ICP/messaging fallback
  to silently produce no documents.
- Trigger: before onboarding the first new paying client post-c0.

### [post-c0] Multi-segment UI — operator segment management
- The data model now supports multiple named segments per org (each with their own
  ICP, messaging doc, and prospect set), but there is no UI for creating or managing
  segments beyond the default one.
- Concretely: to create a second segment, change the is_default flag, or rename a
  segment, an operator must currently run SQL directly.
- Trigger: first client who explicitly needs separate ICPs for two distinct buyer types.

### [post-c0] Second-segment ICP + messaging generation flow
- The agent routes for ICP and messaging both resolve a single segment per run. There
  is no orchestration to run generation for all segments of a given org in one call.
- When a client has two segments, an operator must trigger the ICP agent twice (once
  per segment) by passing segment_id explicitly in the request body.
- Trigger: first multi-segment client.

### [post-c0] Part C prospect stamping for sourcing pipeline
- The research agent stamps segment_id on first run for any NULL-segment prospect
  (Part C). This handles manually-created prospects and the dogfood batch.
- When a proper Apollo/sourcing pipeline exists and inserts prospects programmatically,
  that pipeline should stamp segment_id at insert time rather than relying on the
  research agent to backfill it. Currently no automated sourcing pipeline exists.
- Trigger: when a sourcing pipeline is built that writes to the prospects table.

### [note] process-replies + instantly-poll are pg_cron jobs — do NOT add to vercel.json
- Added 2026-06-03. Corrected 2026-06-03.
- Both routes are Supabase pg_cron jobs by design, not Vercel Cron jobs.
  They expose POST-only handlers; Vercel Cron sends GET — they would 405.
- Verified: cron.job rows 2 (instantly-poll, */15) and 4 (process-replies, */5) exist,
  are active, and have been firing successfully (status: succeeded, confirmed via
  cron.job_run_details on 2026-06-03).
- Do NOT add these to vercel.json. They are correctly scheduled and running.

### ~~[approval-gate] composeSequence has no callers — gate it when it is wired up~~
- RESOLVED 2026-06-03 (content pipeline build).
- Bug fixed: all three strategy_documents fetches inside compose-sequence.ts now require
  both `status='active'` AND `client_approval_status='approved'`. Messaging throws loudly
  if absent; ICP and Positioning fall back to safe defaults (never unapproved content).
- composeSequence is now wired via handleUploadLeads in actions.ts.
- Unit tests confirm the approval gate: compose-sequence.test.ts tests (a), (b), (c).

### ~~[style] actions.ts error message names "Instantly" above the integration handler layer~~
- RESOLVED 2026-06-03 (content pipeline build).
- actions.ts was rewritten as part of the compose-at-upload work; the Instantly reference
  was removed. No capability-layer references to tool names remain in actions.ts.

### [build] Pre-existing Sentry warnings in production build
- Added 2026-06-03.
- Two warnings appear every build:
  1. No global-error.js handler — React rendering errors not reported to Sentry.
     Fix: add app/global-error.tsx with Sentry.captureException.
  2. Deprecated sentry.client.config.ts — should be renamed instrumentation-client.ts.
     Fix: rename file (or move content) as Sentry docs instruct.
- Neither affects runtime error reporting for non-render errors (Sentry is wired for API errors).
- Trigger: Sentry configuration pass before first paying client.

### [data-model] status='approved' is unreachable in strategy_documents queries and RLS policy
- Added 2026-06-03.
- The clients_read_own_active_strategy_docs RLS policy and several page/helper queries
  filter `status IN ('active', 'approved')`. No code ever writes status='approved' to a
  strategy_documents row — promote_strategy_doc_version always writes 'active'.
- Functional impact: none (the dead condition is never matched).
- Cleanup: remove 'approved' from the RLS policy USING clause and from app-code selects
  that check status IN ('active', 'approved') to keep them accurate.
- Trigger: next migration touching strategy_documents schema.

### [scale] Background job queue for compose-at-upload when batch volumes exceed ~50
- Added 2026-06-03 (content pipeline build).
- handleUploadLeads processes composition in chunks of COMPOSE_CHUNK_SIZE=50. At typical
  client zero volumes this fits within a Next.js server action request. At higher volumes
  (~500+ prospects per upload) the synchronous request would time out.
- Fix: move compose-at-upload to a Vercel background job (or Supabase Edge Function queue)
  so the operator gets an immediate "queued" response and a later notification when done.
- Trigger: when a single upload batch regularly exceeds 100 prospects, OR when Vercel
  function timeouts start appearing in Sentry for handleUploadLeads.

### [config] Configurable per-campaign delay schedule in syncSequenceShell
- Added 2026-06-03 (content pipeline build).
- syncSequenceShell uses a hardcoded default: step 1 = day 0, step N = (N-1)*3 days.
  This is a reasonable cold-email default but different clients may want different cadences
  (e.g. faster follow-up for high-intent segments, longer gaps for enterprise targets).
- Fix: add an optional `delays` field to ShellSyncInput; fall back to defaultDelays() when
  absent. Expose a delay-schedule UI in the campaign settings panel.
- Trigger: when a client explicitly requests a different follow-up cadence.

### [smoke] Costa Rica live-smoke spec — content pipeline verification before client one
- Added 2026-06-03 (content pipeline build).
- When running the first real upload after content pipeline is live, verify:
  (a) Custom variables render correctly: Instantly shows the composed subject and body in
      the preview, not the raw {{m_subject_1}} / {{m_body_1}} template variables.
  (b) Zero raw {{...}} leakage: no prospect email contains an unresolved {{m_*}} marker.
      If any marker appears verbatim, the shell step count does not match the doc step count.
  (c) Line breaks render correctly: \n\n paragraph breaks produce visible paragraph spacing
      in the email client; single \n produces a line break. Check in both Gmail and Outlook.
  (d) Instantly undefined-variable behaviour: upload one lead with only m_subject_1/m_body_1
      and observe whether Instantly shows a blank or an error for the missing step 2 variable.
      Document the behaviour — this informs whether assertCompleteVariables is the right guard
      or whether partial sets should be silently excluded earlier.
- Trigger: first real upload to a live campaign after client one onboards.

### [pre-c0] Verify SUPABASE_SERVICE_ROLE_KEY is set in Vercel production environment
- Added 2026-06-04.
- handleUploadLeads calls getComposeServiceClient() which explicitly throws if
  SUPABASE_SERVICE_ROLE_KEY is absent. This was the most likely root cause of the
  error boundary crash seen during staging on 2026-06-03.
- The fix (top-level try/catch in handleUploadLeads + handleSyncSequenceShell) prevents
  future crashes from this. But the key must still be set so composition actually works.
- How to verify: Vercel dashboard → margenticos-platform → Settings → Environment Variables.
  Confirm SUPABASE_SERVICE_ROLE_KEY appears under Production scope. If missing, add it now.
  Value is in .env.local locally. Never echo the value in chat or logs.
- Trigger: before attempting the first real upload post-fix.

### [lesson] Server action unhandled throw → React error boundary (2026-06-04)
- Any exception that escapes a Next.js server action propagates to the React error boundary.
  The page crashes visually instead of returning an inline error.
- Fix pattern: every server action must wrap its entire business logic in try/catch and
  return { ok: false, error: message } — never let raw exceptions escape.
  Auth redirect() calls (redirect('/login'), redirect('/dashboard')) must remain OUTSIDE
  the try/catch — they work by throwing a special error that Next.js catches internally.
  Wrapping them would intercept the redirect and turn it into an { ok: false } return.
- Applied to: handleUploadLeads and handleSyncSequenceShell in actions.ts (2026-06-04).
- Apply this pattern to any new server action that calls code which can throw.

### [resilience] Schema-drift sweep: strategy_documents content JSON consumers (item g)
- Added 2026-06-04.
- Every file that reads strategy_documents.content and unpacks fields (ICP document,
  positioning document, TOV guide, messaging document) was written at different times
  and may carry different shape assumptions (e.g. field presence, nesting, optional keys).
- Risk: a promoted document with a slightly different content shape silently drops fields
  in the UI or causes a runtime error in an agent that expects strict field presence.
- Fix: audit all consumers, centralize normalization in a single doc-load helper that
  validates and fills defaults before any consumer touches the content. Emit a Sentry
  warning if a field is absent that the consumer requires.
- Scope: read all files that call supabase.from('strategy_documents').select() and trace
  how they unpack content. Centralize into src/lib/docs/load-strategy-doc.ts (or similar).
- Trigger: before adding any new document type or new agent that reads document content.

### [resilience] Render fallback for malformed strategy_document content (item i)
- Added 2026-06-04.
- If strategy_documents.content is null, an unexpected shape, or missing a required key,
  the current document rendering components propagate the error to the React error boundary,
  crashing the full page rather than showing an inline message.
- Fix: each document section component should catch the shape error at the field level and
  render a yellow "Content unavailable — contact support" banner inline instead of throwing.
  This is a UI resilience fix, not a data fix — it makes bad data visible rather than
  catastrophic.
- Trigger: next touch of any document display component, or before first paying client
  onboarding (whichever comes first).

---

## Items added 2026-06-04 (lap closeout / Costa Rica prep)

### [feature] FAQ seed agent — post-c0, pre-c1 blocker
- Added 2026-06-04. Bucket: pre-c1 (blocker).
- An FAQ seed agent pre-populates a per-client FAQ store from the intake questionnaire,
  ICP doc, and positioning doc so that inbound reply handlers and client-facing touchpoints
  have a knowledge base to draw from.
- This is a pre-c1 blocker: without it, the reply handling agent has no client context to
  ground positive-reply responses in, and the risk of generic AI-flavored replies is high.
- Trigger: before onboarding the first paying client (c1).

### [feature] B-3A light client content approval panel — pre-c1
- Added 2026-06-04. Bucket: pre-c1.
- The current approval flow (cold_email, linkedin_post, linkedin_dm) is sequence-level.
  B-3A specifies a lighter approval panel for individual content items (e.g. a single
  composed email or LinkedIn post draft) so clients can review and approve one piece
  without seeing the full sequence context.
- Relevant PRD section: 08-approval.md (B-3A subsection).
- Trigger: before first paying client is onboarded; the current flow is operator-only.

### ~~[quality] Em-dash / AI-tell cleanup on 4 doc-gen agents + composed copy QA — pre-c1~~
- DONE 2026-06-05. Agent quality pass (Phases 0–3) complete.
- All four agent prompts reworked with shared voice spec (7 rules + 3 exemplars).
  scrubAITellsDeep() + assertNoDashes() gate wired to ICP, positioning, TOV agents.
  13-unit Vitest test suite passing. Branch: worktree-agent-ae91d40d71b6a63b8.
- Still pending: composed copy QA step (re-run validator on stored composed copy).
  Deferred — add as separate BACKLOG item once post-Phase 4 TOV is confirmed clean.

### [post-build] ADR-019: In-prompt self-checks are not gates — log as formal ADR
- Added 2026-06-05. Bucket: post-build housekeeping.
- Evidence: TOV v1 output contained four phrases explicitly listed in the tov-agent.md
  banned-phrases self-check ("casual confidence", "relaxed language carrying serious
  points", "bounces back fast", "treats setbacks as transitions"). The self-check
  exists in the prompt but failed under generation. This is the general case, not a fluke.
- Architectural conclusion: LLM self-checks are not enforcement. They are hints. The only
  reliable gate is deterministic code: scrubAITellsDeep() + assertNoDashes() wired at the
  agent output layer, throwing before any database write.
- Action: formalise this as ADR-019 ("In-prompt self-checks are advisory; deterministic
  post-generation gates are the enforcement layer") in docs/ADR.md. Update CLAUDE.md
  ADR reference list.

### [integration] H-3 polling + M-3 per-client Instantly key — pre-c1
- Added 2026-06-04. Bucket: pre-c1.
- H-3: the instantly-poll cron currently uses a single global Instantly API key stored in
  integration_credentials. When multiple clients are active, it polls a shared Instantly
  workspace. Per-client key isolation (M-3) requires each client to have their own key
  stored per organisation_id, and the polling loop to iterate over all active client keys.
- Both items are deferred until the second client is near onboarding, but must be
  designed and implemented before c1 goes live to avoid data leakage between clients.
- Trigger: before onboarding c1 (first paying client).

### [resilience] M-4 dispatch retry with backoff — low priority
- Added 2026-06-04. Bucket: low-priority / post-c1.
- The current uploadLeads and syncSequenceShell handlers throw immediately on network
  errors, rate limits (429), and transient server errors (5xx). There is no retry logic.
  The server action (handleUploadLeads) returns { ok: false } and the operator must
  manually re-trigger.
- Fix: wrap the fetch call in an exponential backoff retry (2–3 attempts, caps at 30s)
  for 429 and 5xx responses. Network errors should remain immediate-fail since they
  likely indicate a persistent connectivity issue.
- Trigger: when retry failures are observed in Sentry logs at a rate that creates
  operational friction (not worth building speculatively before that point).

### [pre-c1] Regenerate TOV after agent quality pass

- Updated 2026-06-05. Agent quality pass (Phases 0–3) complete. Phase 4 pending approval.
- Phases 1–3 are in worktree-agent-ae91d40d71b6a63b8, awaiting Gate 1 review and merge.
- Phase 4 (TOV regeneration for org 74243c62-f42d-4f3f-b93e-bd5e51f0b6c0) runs only after
  Doug approves the Gate 1 diff and the worktree is merged to main.
- Trigger: Doug approves Gate 1 → merge → run Phase 4 → present TOV for Gate 2 approval.

### ~~[security] Webhook secret rotation — post-c0 polish~~
- SUPERSEDED 2026-06-05. Confirmed duplicate of the above entry. Rotation is now
  handled by construction in the Vault migration. See "[pre-c1] Supabase Vault" entry
  in Live-path / config audit section below.

### [audit] gstack audits scheduled — Costa Rica + pre-c1
- Added 2026-06-04. Bucket: see sub-items.
- Three gstack audits are planned:
  1. /cso (chief security officer audit): before Costa Rica activation. Review auth flow,
     RLS policies, operator-route guards, and integration credential storage for gaps
     that could affect the first live campaign.
  2. /design-review: pre-c1. Full dashboard UI review for inconsistencies, missing states,
     and the double-sidebar layout issue (two sidebars visible simultaneously on some
     operator views — fold this into the design-review audit rather than fixing ad hoc).
  3. /qa (QA audit): pre-c1. End-to-end scenario coverage for the intake → strategy →
     approval → upload → poll → reply-handling pipeline.
- These are planned audits, not yet run. Schedule /cso before leaving for Costa Rica.

---

## Security — items deferred from 2026-06-04 CSO batch fix

### [security] NEXT_INTERNAL_SECRET rotation policy — pre-c1
- Added 2026-06-04. Bucket: pre-c1.
- NEXT_INTERNAL_SECRET is the shared secret that allows internal server-to-server calls
  (e.g. agent dispatch via x-internal-secret header) to bypass the operator session check.
  It carries the same blast radius as a service-role key: a leaked value lets any caller
  trigger unbounded LLM agent runs for any org.
- Action: (a) ensure it is generated with at least 32 bytes of randomness (openssl rand -hex 32);
  (b) store in Vercel env vars only — never committed; (c) rotate on suspected exposure with
  the same urgency as rotating SUPABASE_SERVICE_ROLE_KEY or a third-party API key.
- A comment was added to src/app/api/agents/icp/route.ts as a code-level reminder.
- All other agent routes that check x-internal-secret should receive the same comment in a
  future pass (positioning, tov, messaging agent routes).

### [security] postcss transitive CVE in next — GHSA-qx2v-qp2m-jg93 — monitor
- Added 2026-06-04. Bucket: monitor / low urgency.
- next@16.2.7 bundles postcss@8.4.31 internally. The fix requires postcss >=8.5.10.
- npm audit fix --force would downgrade next to 9.3.3 — not viable.
- The vulnerability is PostCSS XSS via unescaped </style> in CSS stringify output.
  This only applies if user-controlled CSS is processed through postcss. In Next.js,
  postcss runs at build time only — there is no runtime attack surface in production.
- Action: monitor next.js release notes for a patch that bumps the internal postcss.
  When next ships a version with postcss >=8.5.10 internally, upgrade and close this item.
- Do NOT use npm audit fix --force for this CVE.

---

## Dashboard chrome / design review — items from 2026-06-04 route-group session

### [pre-c1] M-1 Responsive sidebar
- Added 2026-06-04. Bucket: pre-c1 design task.
- Both the client Sidebar (brand-green, w-[210px]) and the OperatorSidebar
  (brand-green-operator, w-[210px]) are fixed-width with no responsive
  behaviour. On viewports narrower than ~800px the sidebar is clipped by the
  flex layout and the main content area has no usable width.
- Fix required before a paying client opens the dashboard on a laptop or tablet.
- Design decision needed: hamburger collapse, hidden-on-mobile with slide-in, or
  icon-only collapsed state. Decide before building. ADR if the decision is
  non-obvious.
- Trigger: before c1 onboarding. This is a visual/UX pre-c1 gate.

### [pre-c1] C-3 Chrome-mode decision: operator working on a client vs. view-as-client split
- Added 2026-06-04. Bucket: deferred — decide after chrome route-group refactor ships.
- Context: now that (client) and operator/ are separate layout trees, there are two
  clearly distinct chrome modes available to operators: (a) operator/ chrome with the
  full OperatorSidebar + client selector, and (b) (client) chrome with the green
  Sidebar + OperatorViewingBanner. Currently, visiting strategy or results routes via
  ?client= lands the operator in (client) chrome — the "view as client" experience.
- The open question: when an operator is working on a client's strategy documents
  (editing, approving, regenerating), should they be in operator/ chrome (with operator
  tools visible) or in (client) chrome (pure client perspective)? The current design
  uses (client) chrome for both use cases.
- Options to evaluate:
    A) Keep current: all ?client= routes use (client) chrome. Simple, fewer layout trees.
    B) Add an /dashboard/operator/strategy/[type] route under operator/ chrome for the
       operator-working mode. Client chrome remains for genuine view-as-client.
    C) Operator chrome everywhere, banner indicates "viewing as client" but nav stays
       operator-green.
- First-use evidence (2026-06-04): first time navigating to a client strategy doc via
  the View button, operator instinct was to expect teal/operator chrome to stay — "should
  stay operator chrome here." This is concrete pressure supporting Option B (separate
  operator-working route under operator/ chrome). Not yet a decision; logged for when
  the trigger fires.
- Trigger: decide before operator workflow is used heavily or before adding operator-only
  strategy tools (e.g. force-approve, regenerate buttons visible to operators only).
  Do not build speculatively — decide when the use case pressure is concrete.

### [pre-c1] Part 3 client-role verification checklist — design review
- Added 2026-06-04. Bucket: pre-c1.
- Verifies that a real client user (non-operator role) cannot see operator chrome,
  operator nav items, or the OperatorViewingBanner. Must be manually verified with a
  live client-role account before c1 onboarding.
- Checklist (6 items — manual, requires a non-operator Supabase user):
  1. Log in with a client-role account (users.role != 'operator').
  2. Visit /dashboard → green Sidebar renders; no OperatorSidebar, no amber "Operator
     mode" pill, no client-selector dropdown.
  3. Visit /dashboard/strategy/icp → client chrome persists; sidebar shows Results +
     Strategy sections only; no "Operator only" nav section visible.
  4. OperatorViewingBanner is absent — the amber "You are viewing the client experience"
     banner must not render (it only renders when isOperator=true in the layout).
  5. Navigate between /dashboard and /dashboard/strategy/* using sidebar links → no
     chrome flicker, no stale operator chrome bleeds through.
  6. The "Viewing" label in the sidebar shows the client's own org name — not an
     operator's org name, and no ?client= param logic fires.
- Trigger: before the /qa audit run that gates c1 onboarding.

### [EXECUTED 2026-06-04] P1–P4 design findings batch — batched fix pass complete
- Added 2026-06-04. Executed 2026-06-04 in the batched fix pass session.
- All design-review findings from the pre-chrome-refactor /design-review run were
  addressed in a single batched fix pass alongside two operator-side findings.
- Findings addressed:
    S-1 (DocApprovalControls): 'operator' source label → 'Approved by MargenticOS';
        'auto' label → 'Auto-approved after the review window'
    S-2 (DocApprovalControls): focus-visible rings added to Approve and Request changes
        buttons
    S-3 (SegmentTabStrip): role="tablist" on container, role="tab" aria-selected on
        each Link
    S-4 (SegmentTabStrip): gap-0 → gap-2 on tab strip container
    S-5 (strategy/[type]/page.tsx): empty string subtitle fallback → 'Not yet generated'
    M-2 (IntakeForm): section tab buttons min-h-[36px] → min-h-[44px]
    B-1 (BenchmarksView): "Instantly's 2025 cold email report" → "a 2025 cold email
        industry report"
    O-5 (OperatorSidebar): Approvals moved from Results section to Operator only section
    Item 1 (AllClientsView): dead View button href fixed → /dashboard?client=<id>
    Item 2 (SetupStatusPanel): campaigns status row replaced with auto-derived read-only
        pill; derivation from registered campaigns + lead upload activity
    Item 3 (ADR-001 sweep): Instantly/registry column name references removed from
        CampaignRegistrationPanel, LeadUploadPanel, MailboxOrderPanel, SetupStatusPanel
- M-1 (responsive sidebar) explicitly excluded — pre-c1 design task, separate item above.

### [decision] Setup-status definition — campaigns auto-derived, LinkedIn manual
- Added 2026-06-04. Bucket: decision record (not a to-do).
- Pending = no campaign registered in the campaigns table with a non-null external_id.
- In progress = campaigns registered but shell unsynced (shell_synced_at IS NULL on all)
  OR no leads have been uploaded yet (prospects with non-pending upload_status = 0).
- Complete = campaigns registered + at least one shell synced + leads uploaded.
- "Complete" is distinct from "live" — email warmup separately gates campaigns going live.
  A client can be Setup=Complete while still in the warmup period.
- LinkedIn status stays manual: no system signal exists that reliably indicates LinkedIn
  content is configured and active. An operator sets it manually on the client detail page.
- Implementation: deriveCampaignsStatus() in src/lib/dashboard/derive-setup-status.ts.
  11 unit tests in src/lib/dashboard/__tests__/derive-setup-status.test.ts.

### [product-decision] LinkedIn content card in DocumentsActiveState — keep or pull
- Added 2026-06-04. Bucket: Doug's call, no build.
- The "LinkedIn content" card in DocumentsActiveState.tsx promises delivery of LinkedIn
  content to the client. The card currently reflects a manual setup-status value (operator
  sets it on the client detail page).
- Open question: is LinkedIn content delivery in scope for the near term? If the operator
  is actively delivering LinkedIn posts (manual Taplio queue), the card is accurate and
  should stay. If LinkedIn content is not being delivered yet, the card makes a promise
  the system cannot currently fulfill.
- Options: (a) keep the card — display "Pending" status until operator manually marks it
  ready; (b) pull the card entirely until LinkedIn delivery is active and automated;
  (c) keep but rename to "LinkedIn setup" and soften the promise language.
- Trigger: Doug's call before c1 client onboarding. Do not change without a decision.

### [architecture] Route placement constraint — no bare routes under dashboard/
- Added 2026-06-04. Bucket: architecture rule (also in CLAUDE.md).
- Routes must never be placed directly under src/app/dashboard/ outside (client)/ or
  operator/. The dashboard/layout.tsx is a bare passthrough (no auth gate, no chrome).
- A route directly under dashboard/ would be served with no authentication check and no
  sidebar. This would be a silent security hole — the page would load but any Supabase
  query would return empty (RLS blocks unauthenticated reads) rather than redirecting.
- All new routes: place under (client)/ for client-facing pages, or operator/ for
  operator-only pages. The route-group parentheses are invisible to URLs.
- This is also enforced in CLAUDE.md Anti-patterns section.

---

## Live-path / config audit — 2026-06-05

Findings from full read-only audit: codebase dependency inventory, Vercel env vars, Supabase
live schema, pg_cron job state, integrations_registry. No code changes in this session.

### ~~[pre-c1] Auto-approve cron: investigate → decide → wire~~ — DONE 2026-06-05

- Wired 2026-06-05 via vercel.json cron at `0 * * * *`.
- TOV held suggestion was rejected 2026-06-05; DB is clear of stale pending rows.
- Hourly Vercel cron entry added (vercel.json). First tick will process 0 rows; subsequent
  ticks will auto-approve any suggestions past their auto_approve_window_hours.
- Prior investigation detail: see git history for the original entry above.

### [pre-c1] Supabase Vault: move two DB-stored secrets out of plaintext

- Added 2026-06-05 (live-path audit). Reclassified from post-c0-paid-tier.
  Supersedes the two stale entries marked above (Vault migration 2026-06-01 and
  webhook secret rotation 2026-06-04). Both are now struck through.

- Two secrets are stored as plaintext inside Supabase database objects:
  1. CRON_SECRET — embedded as a Bearer token in both cron.job command strings
     (instantly-poll and process-replies). Readable via SELECT on cron.job.
  2. SUPABASE_PENDING_REVIEW_WEBHOOK_SECRET — embedded in the users-pending-review-notify
     trigger action statement. Readable via SELECT on information_schema.triggers.
  Neither secret appears in any committed migration file (confirmed 2026-06-05).
  Access requires Supabase dashboard or SUPABASE_SERVICE_ROLE_KEY — an already-privileged
  position. Reclassified to pre-c1 because Supabase Vault (pgsodium) is available on the
  Free tier; the Hobby limitation in the original entry no longer applies.

- **One atomic migration, five changes:**
  1. Add both secrets to vault.secrets using vault.create_secret() with fresh values.
  2. Rewrite both cron.job command strings to read vault.decrypted_secrets at runtime
     instead of embedding the literal value. Use a DO block for idempotency.
  3. Rewrite the users-pending-review-notify trigger action to read from Vault.
  4. Fresh secret values are minted during the migration — rotation is included by
     construction. No separate rotation step needed.
  5. Repoint both pg_cron job URLs from margenticos-platform.vercel.app to
     https://app.margenticos.com in the same edit.

- **Vercel update required after migration:** update CRON_SECRET and
  SUPABASE_PENDING_REVIEW_WEBHOOK_SECRET in Vercel production to the newly minted values.
  Do this before re-enabling the pg_cron jobs post-migration.

- **Apply-confirmation step** (migrations have been committed-but-unapplied before):
  After applying, verify all three callers work with the new values:
  (a) POST /api/cron/instantly-poll manually with new CRON_SECRET — confirm 200.
  (b) POST /api/cron/process-replies manually — confirm 200.
  (c) Insert a test row into users_pending_review and confirm the trigger fires — check
      Supabase dashboard → Logs → Edge Functions for the http_request call.
  Verify applied state: Supabase dashboard → SQL Editor → check supabase_migrations table.

### [pre-c1] Explicit maxDuration on all four agent routes — queue after /qa clears

- Added 2026-06-05 (live-path audit). Bucket: pre-c1, low urgency. No deploy until /qa done.
- /api/agents/icp, /api/agents/positioning, /api/agents/tov, /api/agents/messaging
  do not export maxDuration. They rely on the Vercel platform default (currently 300s on
  all plans). 300s is sufficient for Opus 4.6 generation at current intake sizes.
- The absence of an explicit setting means a future Vercel plan change or default change
  could silently shorten the timeout without a code alert.
- Fix: add `export const maxDuration = 300` to each of the four route files.
  One-line change per file, no behaviour change at current defaults.
- Queue after /qa session clears. Do not deploy in the current /qa window.

### [done-now] Four 2-minute dashboard checks — complete before closing this session

- Added 2026-06-05. Doug checking now. Not Costa Rica items.

  1. **Anthropic spend cap** — console.anthropic.com → Billing → Limits.
     Confirm a spend cap is set. Without a cap, a dispatch bug (idempotency guard
     fails on re-submit) could trigger unbounded Opus generation. At ~$2–5 per full
     4-agent onboarding, a loop would accumulate quickly.
     If no cap is set: add one before client-zero campaigns go live.

  2. **Resend plan and daily headroom** — resend.com → account dashboard.
     Free plan = 100 emails/day, 3,000/month. All emails route through Resend: auth magic
     link, OTP codes, client welcome, intake-complete notification, doc-ready notifications
     (4 per onboarding), pending-user alerts. 100/day is reachable on a heavy onboarding
     or auth-troubleshooting day.
     If on Free: upgrade to Resend Pro ($20/month) before c1 onboarding.

  3. **Vercel cron last run — strategy-doc-auto-approve** — Vercel dashboard →
     margenticos-platform → Settings → Crons.
     Confirm last execution timestamp and no error state. The route is in vercel.json
     at 0 6 * * * and is the only daily Vercel cron in the system. If it has never fired
     or shows an error, investigate before c1 clients rely on the 3-day approval window.

  4. **Supabase backup tier** — Supabase dashboard → Settings → Backups.
     Free tier = daily snapshots, 7-day retention. Pro = PITR, 30-day retention.
     At client-zero scale: daily snapshots are acceptable. Upgrade to Pro before first
     paying client if your SLA commitment to that client requires PITR.

### [pre-c1-smoke] Client welcome email delivery — verify on dry-run

- Added 2026-06-05. Bucket: pre-c1, rides the founding-client dry-run.
- sendTransactionalEmail() is called in clients/new/actions.ts when an operator creates
  a new client. Template: src/lib/email/templates/client-welcome.ts. Sends to the
  client's email address via Resend.
- This path has not been confirmed exercised in production config. All prior client
  creation was development/staging, or predated the Resend custom SMTP wiring.
- Smoke check: create a test client via the operator dashboard using a real address
  (e.g. doug+testclient@margenticos.com), confirm the welcome email arrives and the
  subject, body, and link are correctly formatted.
- Trigger: during the founding-client dry-run walkthrough before c1 onboarding.

---

### [pre-live-sends] Reply visibility UI — operator surface for process-replies cron

- Added 2026-06-05.
- The process-replies cron (`/api/cron/process-replies`) ingests inbound replies from
  Instantly and classifies them (positive / negative / OOO / info request). It runs on
  a schedule and writes results to the database. There is currently no operator surface
  to read classified replies, take action on information requests, or review the reply
  queue.
- The four stub nav items removed in this session (Reply queue, FAQ curation, Agent
  activity, Signals log) were routing to 404 pages. They are removed from the sidebar
  until real views exist.
- Before live sends begin: build the Reply queue view so Doug can see classified replies
  and action information requests in time. The 72-hour escalation path (system holding
  message) cannot be effectively managed without this surface.
- Priority: must exist before Costa Rica trip / before campaign sends go live.

---

### [pre-c1] Operator Settings — wire to live data

- Added 2026-06-05.
- `src/components/dashboard/operator/SettingsView.tsx` renders from `PLACEHOLDER_SETTINGS`
  (hardcoded const, lines 24–37). It is not connected to the database.
- Required when real: query `integrations_registry` for capabilities + connection status
  per client org; query `organisations` or a `client_settings` table for per-client
  approval toggles and booking URL.
- TODO comment on line 21 of SettingsView.tsx captures the scope.
- Currently shows a visible amber notice banner so the state is obvious to the operator.

---

### [monitor] Tripwire — "column client_id does not exist"

- Added 2026-06-05.
- One occurrence logged at 16:15:45 BST. Catalog sweep found no DB-side origin
  (pg_policies, pg_proc, pg_views, pg_matviews, trigger functions all clean).
  Closed as unattributed single occurrence. Not recurring as of close of session.
- `agent_runs` is the only table in the schema using `client_id`; all other 18
  tables use `organisation_id`. This naming inconsistency is the structural root.
- **Tripwire for any dry-run or watcher session:** if this error appears again,
  capture: (1) exact timestamp, (2) all concurrent Postgres activity within ±60s
  (from `get_logs`), (3) which page/action the operator was performing at that moment.
  Do not close as "transient" a second time — two occurrences means a live path.
- Longer-term fix (see rename entry below): migrate `agent_runs.client_id` →
  `agent_runs.organisation_id` to eliminate the inconsistency entirely.

---

### [post-build] Consolidate requireOperator into a shared lib helper

- Added 2026-06-05.
- `requireOperator(sessionClient, serviceClient)` is currently duplicated in two files:
    `src/app/api/operator/faqs/route.ts` (definition + 2 call sites)
    `src/app/api/operator/documents/force-approve/route.ts` (definition + 1 call site)
- Both copies are identical after the two-client split fix (commit 317dbfd). Any future
  change (e.g. adding audit logging to operator checks) requires updating both files.
- Consolidate to: `src/lib/supabase/require-operator.ts` — export a single
  `requireOperator(sessionClient, serviceClient)` async function.
- Both route files import from there. No behaviour change, just DRY.
- Trigger: next time either file is touched for any other reason.

---

### [pre-c1] Supabase Pro — PITR backups before first paying client

- Added 2026-06-05.
- Free tier has daily snapshots with 7-day retention only. No point-in-time recovery (PITR).
- Upgrade to Pro ($25/month) before first paying client signs. Pro gives PITR with
  30-day retention and scheduled backups to your own storage.
- Also needed for: Supabase Vault (encrypted secret storage), log retention beyond 1 day.
- Upgrade path: Supabase dashboard → Organization Settings → Billing → Upgrade to Pro.
- Note: can do a manual pg_dump at any time for a one-off snapshot. Requires DB password
  from Settings → Database → Connection info (password only shown once at creation, but
  can be reset there). Command:
    /opt/homebrew/opt/libpq/bin/pg_dump \
      "postgresql://postgres:[PASSWORD]@db.hjpvnvjryxdjcfdsfhzy.supabase.co:5432/postgres" \
      -f .backups/production-YYYYMMDD.sql
  .backups/ is gitignored.

---

### ~~[pre-c0] ApprovalCard renderer audit — ICP DONE; Positioning/TOV/Messaging verified (2026-06-06)~~

- Added 2026-06-06. **ICP: RESOLVED 2026-06-08 (commit dfd474e).**
- Root cause: `renderGeneric()` filtered `Object.entries()` to `string | number` only, losing
  every nested object. ICP had no dedicated renderer — ~80% of the payload was invisible
  to the operator at approval time.
- **ICP fix (S3 reopen, dfd474e):** `IcpTierCard` component built, rendering all tier fields:
  `company_profile` (stage, revenue_range, headcount, geography, business_model, industries),
  `buyer_profile` (title, seniority, day_to_day, identity), `four_forces` (collapsible pull/push/
  habit/anxiety), `triggers` with `evidence_to_find`, `switching_costs`, `disqualifiers`.
  `renderUnknownFields` fallback added at tier level so future fields cannot silently vanish.
  34 tests assert nested content strings (not just envelope counts).
- **S2 fix-pass (commit 3c46944):** all four doc-type renderers rebuilt against real DRY RUN schemas.
  Positioning, TOV, Messaging renderers confirmed complete against real fixture data.
  crash-class dead (renderCrashFallback added as belt-and-suspenders).
- **Visual proof needed:** IcpTierCard visual confirmation is part of the S3 re-verify walk
  (step 11: open ICP suggestion after it lands, confirm four_forces/triggers/switching_costs
  are visible in the approval card UI).
- Context: Finding #6 from the 2026-06-06 onboarding dry-run session.

---

### [phase-b] Dispatch trigger redesign — intake completion to cascade (2026-06-06)

- Added 2026-06-06.
- **D1 (FIX 2) — RESOLVED 2026-06-08 (commit 50fd685):**
  `POST /api/intake/complete` was dispatching all 4 agents in parallel. Positioning +
  messaging failed immediately (no upstream docs yet), corrupting the completion logic.
  Fix: intake now dispatches ICP + TOV only. Positioning and Messaging are staged
  via `triggerCascadeIfEligible`. Confirmed in code: lines 178-181 of intake/complete/route.ts.
- **D2 (FIX 3) — RESOLVED 2026-06-08 (commit 50fd685):**
  `notifyIfAllDocsComplete()` was present in the ICP route and fired as soon as ICP
  completed, sending a false "all documents ready" email. It was already removed from
  positioning, tov, and messaging in the original S3 commit but was missed in icp/route.ts.
  Fix: removed from icp/route.ts. Confirmed: no `notifyIfAllDocsComplete` in any agent route.
- **ICP route false email (RESOLVED 2026-06-08):** The false `docs_complete` email was
  confirmed to have fired to `RESEND_OPERATOR_EMAIL` in the S3 WALK TEST. D2 fix prevents recurrence.
- Cascade helper (`triggerCascadeIfEligible`) + four callers shipped in S3 (commit dd098a1).
  Idempotency index on `document_suggestions(org_id, doc_type) WHERE pending` is the backstop.
- **S4 — RESOLVED 2026-06-08 (commit 2b0170e):** Four email templates built and wired.
  `suggestion-ready` fires from each agent SUCCESS path after suggestion row written.
  `agent-failure` fires from each agent ERROR path (all errors, including 422 pre-flights).
  `client-revision-notify` and `messaging-revision-staged` built as stubs for S5 wiring.
  Cascade TODO comment replaced with design-decision comment (notification fires from agent
  route success path, never at dispatch time). All stale "Last-agent-finished" comments
  removed from TOV/positioning/messaging route headers.
- Phase B items 4-5 (operator failure alerts, client-approval interplay) — DONE in S4.

---

### [prompt-fix] Positioning agent invents client quotes — Rule 8 added (2026-06-06)

- Added 2026-06-06. Fix applied this session.
- The positioning agent for PartScale produced: "One client described it as the first time
  someone showed them what was actually broken instead of selling them the fix." No such
  quote exists in intake data, the PartScale website (Home + About checked), or web research
  (search returned nothing). The quote was fabricated.
- Fix applied: Rule 8 added to `shared-voice-spec.md` and synced to all four document
  generation agent prompts (icp-agent.md, positioning-agent.md, tov-agent.md,
  messaging-agent.md). Rule: proof points must trace to intake, website, or research
  results; never invent client quotes or testimonials. Expected outcomes written
  forward-looking, not as retrospective invented quotes.
- Quality checklist item also added to positioning-agent.md's "Quality self-check before
  returning" section.
- The PartScale positioning suggestion `8541c08c` was approved despite the defect. If
  PartScale is ever re-generated, this quote should be removed or replaced with real
  client evidence when available.

### [prompt-fix] Messaging agent: peer-group framing over unverifiable recipient specifics (2026-06-06)

- Added 2026-06-06. Not yet applied. Batch with JTBD pin and Rule 8 as the next messaging
  agent prompt update.
- The agent must never assert unverifiable specifics about the individual recipient
  ("every holiday you haven't taken got cancelled because someone needed a decision only
  you could make"). These read as fake personalisation when wrong, and they are usually
  wrong. Wrong specifics break trust faster than generic copy.
- Rule: frame pain as peer-group pattern observations drawn from the prospect's
  company stage, team size, or industry — not as claimed knowledge of the recipient's
  personal experience. Example rewrite:
  - Wrong: "every holiday you haven't taken got cancelled because someone needed a
    decision only you could make"
  - Right: "most founders at your size haven't taken a real holiday in over a year"
- The distinction: the right version is falsifiable in the same way but signals research
  into the peer group, not surveillance of the individual. The prospect can agree without
  feeling surveilled.
- Where to add: messaging-agent.md, in the email copy rules section (same block as the
  em-dash and opener restrictions). No shared-voice-spec.md update needed — this rule
  is messaging-specific, not universal across all document types.

### [log] ICP A geographic scope claim vs source site (2026-06-06)

- Added 2026-06-06. Revise-later example, no immediate action required.
- Active ICP A (strategy_document v2 for org a2b621fc) claims "Northern England and
  Midlands concentration" as part of geographic targeting.
- PartScale's website presents the firm as UK-wide with no regional restriction.
- This is a minor over-specificity in the ICP, not a hallucination — the intake may
  have implied regional concentration from founder location or client examples. But it
  contradicts the public-facing positioning.
- Action if PartScale requests a refresh or the ICP is revisited: flag this for the
  client to confirm whether regional focus is intentional or whether UK-wide is the
  correct scope.

---

### [pre-c0] Stale card in approvals queue after approval — outcome TBD (2026-06-06)

- Added 2026-06-06. Outcome to be confirmed before priority is set.
- After approving the positioning suggestion, the card remained visible in the
  approvals queue. Outcome on hard refresh not yet confirmed.
- **If card disappeared on hard refresh:** the approve flow is missing a
  post-success revalidation/router.refresh() call. The mutation completes but the
  client-side cache is not invalidated. Fix: call `router.refresh()` or
  `revalidatePath('/dashboard/operator/approvals')` after a successful approval
  POST. Priority: normal pre-c0.
- **If card survived hard refresh:** the queue query is not filtering to
  `status = 'pending'` — approved suggestions are showing as unapproved.
  Priority: BLOCKER before C0. Check the query in
  `src/app/dashboard/operator/approvals/page.tsx` — it should have
  `.eq('status', 'pending')` on the `document_suggestions` select.
- Confirm outcome and update this entry with the correct diagnosis and priority.

### [discipline] Shared-voice-spec drift verification script (2026-06-06)

- Added 2026-06-06.
- Rule 7 body text already drifts between `shared-voice-spec.md` and the four
  embedded copies in agent prompts (shared-voice-spec.md has a "Wrong final
  sentence" example that the agent prompts omit). Any Rule edit risks silent
  divergence because the sync is manual.
- Build a script in the same family as `check-use-server-exports`:
  extract the `## Shared voice rules` block from each of the four agent prompts,
  strip heading-level differences (## vs ###), and diff against
  `docs/prompts/shared-voice-spec.md`. Fail with a clear message if any block
  does not match the canonical source.
- Wire to CI or run as a pre-commit check alongside the existing TypeScript gate.
- Trigger: next time any agent prompt is edited, or before C0.

### [revise-later] Messaging variants converge at Email 2 (2026-06-06)

- Added 2026-06-06. No action needed before C0 — monitor signal data first.
- In the first PartScale messaging run (suggestion a894972a), three of four
  variants (A, B, D) use the same core narrative at Email 2: founder hires ops
  manager, gives them the title, back in every room within six months. The
  framing differs slightly but the story is the same.
- Strongest differentiation between variants is at Email 1 only (subject lines
  and opener angle vary: "still the bottleneck" × 2, "founder still in every
  room", "the ops manager won't fix it").
- For the next refresh: prompt guidance should explicitly require that each
  variant's Email 2 uses a distinct mechanism or proof point — not the same
  story retold differently. The ops-manager failure narrative is strong; it
  should belong to one variant only.

### [phase-b] Finding #7: revision path gaps — policy decided (2026-06-06)

- Added 2026-06-06. Feeds Phase B proposal. Policy set by Doug.
- **Empirically confirmed in dry-run**: client submitted request-changes on ICP (v2→v3,
  Engineering→Distribution Consulting) and Messaging (v1→v2, Variant A Email 1 opener).
  Both revisions rendered correctly in the client UI with accurate change summaries and
  surgical edits. New versions created via `update_trigger='client_revision'`,
  `client_approval_status='pending'`, prior versions archived. Verified.
- **Gap 1 confirmed**: zero `document_suggestions` rows created by either revision.
  The revised content goes directly to `strategy_documents` as an active new version,
  bypassing the operator review queue entirely.
- **Gap 2 confirmed**: zero `agent_runs` entries for either revision. The revision agent
  (`runDocumentRevisionAgent`) does not call `startAgentRun`. Operator has no visibility
  into revision requests, not even in the run log — only the strategy_document version
  history records that a revision occurred.
- **Gap 3 confirmed**: no operator notification fired. No notification step exists in
  `POST /api/documents/revise`.

**Policy decisions (Doug, 2026-06-06) — implement in Phase B:**

a. **Operator notification on every client revision, all doc types.** Fire immediately
   on POST /api/documents/revise success. Notification must include: org name, doc type,
   the revision note verbatim, and a link to the updated document.

b. **Messaging revisions enter operator review before going live.** icp/positioning/tov
   revisions go live immediately (notify-only). Messaging revisions must be staged as a
   `document_suggestion` (pending) and go through the operator approvals queue before
   becoming active. The client UI must set the expectation: "Messaging changes are
   reviewed by your outbound team before going live."
   Implementation note: the revise route must branch on `document_type === 'messaging'`
   — write to `document_suggestions` instead of calling `promote_strategy_doc_version`
   directly. The existing operator approvals queue handles the rest.

c. **Revision agent conflict rule (all types).** When the client's revision note conflicts
   with voice rules, output validators, or outbound constraints, the agent must:
   - Honor the note's intent as fully as the constraints allow
   - Produce the best compliant version, not a literal obedience that would fail a gate
   - Never silently ignore the note
   - Explain the mediation clearly in `change_summary` (e.g. "Your note asked for X;
     the outbound length constraint required shortening to Y — the intent is preserved")

d. **Revision path must run the same deterministic validators as initial generation.**
   Currently unverified — the revision agent's output is not gated by the same
   post-processor that messaging generation uses. Audit `runDocumentRevisionAgent` to
   confirm validators run. Define the failure UX: a gate rejection must never surface to
   the client as a raw 500 — it must return a human message and log the violation detail
   for the operator. Proposed UX: "We couldn't apply this change while keeping the
   content within your outbound guidelines. Your outbound team has been notified and
   will review it manually."

**Empirical proof from stress test (messaging v2 → v3, 2026-06-06):**

Client submitted a long credentials paragraph requesting insertion into Email 1 of all four
variants. The revision agent obeyed literally. Confirmed violations in the resulting v3:
- Em-dashes in the body (rule violation — Rule 5 / assertNoDashes gate). The change_summary
  itself also contains an em-dash ("introducing PartScale — covering…"), written by the
  same unvalidated agent.
- Email 1 word count: 178 words. Hard limit is 40–90 words. Gate never ran.
- Credentials paragraph inserted across all four variants — the request said "the first
  email" which could reasonably mean Variant A only, but the agent applied it to all four
  without mediation or explanation.
- None of this was caught: `scrubAITellsDeep`, `assertNoDashes`, `validateEmails`, and the
  sequence validator are **never invoked** in the revision path. The revision agent
  (`src/lib/agents/revision/run-revision.ts`) is a raw LLM call + JSON parse, nothing else.
- Duration: ~60s (revision agent does not call `startAgentRun`; exact timing not in DB).

**Phase B revision protocol spec (Doug, 2026-06-06) — implement in Phase B:**

1. **Submit → immediate UI acknowledgment + progress state.** Show "Revising — usually
   under two minutes" from the moment the POST fires. The change_summary arrives as the
   success state of that indicator.

2. **The agent MEDIATES — never obeys blind, never ignores.** Honor the note's intent
   within the voice/outbound rules. Where the request conflicts with the rules, the
   client's wish is still taken into account: implement the closest compliant version AND
   relocate content that doesn't fit to a legitimate home (later email in the sequence,
   signature, website suggestion). The change_summary must state what was honored, what
   wasn't, why, and where it went instead. A client request is never silently discarded.

3. **Revision output runs the SAME deterministic gates as generation.** On gate failure:
   one automatic retry with failure context injected into the prompt; still failing →
   route to operator with a friendly client-facing message. A raw error never reaches the
   client. Proposed client-facing message: "We couldn't apply this change while keeping
   the content within your outbound guidelines. Your outbound team has been notified and
   will review it manually."

4. **Messaging revisions land as pending-operator-review with operator notification, not
   live.** icp/positioning/tov go live immediately, notify-only. Client-facing copy in
   DocApprovalControls sets the expectation: "Messaging changes are reviewed by your
   outbound team before going live."

5. **LOG additions (no separate action items needed — tracked here):**
   - Revision progress-indicator UX: wire the existing `loading === 'revising'` state
     in DocApprovalControls to show "Revising — usually under two minutes" copy, not
     just a spinner. Currently shows "Revising your document…" which is fine but
     does not set a time expectation.
   - No version-revert control on either side (operator or client). Revision is the
     only restore path for either party. Accepted as-is; note for onboarding docs.
   - DocApprovalControls post-approval gap: tracked separately as [pre-c1] above.

6. **Revision runs tracked in `agent_runs` like generation runs.** Currently the revision
   agent does not call `startAgentRun`, so every revision is invisible in the run log.
   Duration, failure reason, and org attribution are unrecoverable after the fact.
   Fix: call `startAgentRun` at the top of `runDocumentRevisionAgent`, call `run.complete`
   on success (with change_summary as output_summary), and call `run.fail` on any thrown
   error. Agent name: `'document-revision'` or `'<doc_type>-revision'` (TBD).

7. **Operator-initiated revisions on active client documents.** Today the operator cannot
   revise an active client document: `POST /api/documents/revise` resolves the org from the
   caller's session (`users.organisation_id`), so any request from an operator account
   returns null and the route 404s. The operator's only lever is the comment→suggestion
   path, which is one step removed and does not trigger the revision agent directly.
   Phase B adds: the operator can initiate a revision on any active client document,
   operator-attributed, using the same mechanism and the same gates (validators, mediation
   rule, operator review for messaging). The route must accept an explicit `organisation_id`
   parameter for operator callers and verify that the caller has `role = 'operator'` before
   bypassing the session-based org lookup. The change_summary must record
   `update_trigger = 'operator_revision'` so the audit trail is clear.

- Trigger: Phase B design approval before any implementation.

### [pre-c1] Request changes unavailable after client approval — DocApprovalControls (2026-06-06)

- Added 2026-06-06. Must fix before first paying client.
- `DocApprovalControls.tsx` renders the Approve + Request changes block only when
  `isPending === true` (line 115). Once a document is approved, that block is replaced
  entirely by a green dot + approval label. The "Request changes" button is gone.
- The revise route (`POST /api/documents/revise`) has no approval-status guard — it
  accepts revisions on any active document regardless of `client_approval_status`. The
  route works. Only the UI is broken.
- Real-world impact: clients will need post-approval revisions within weeks of go-live
  ("our pricing changed", "new service line", "we've stopped serving that vertical").
  With no UI entry point, they'd have to contact the operator who would need to manually
  reset `client_approval_status = 'pending'` to restore the controls.
- Fix: render a lower-priority "Request an update" text link (or collapsed secondary
  button) in the `!isPending` block, alongside the approval indicator. Submits to the
  same `POST /api/documents/revise` route. Does NOT need to reset `client_approval_status`
  first — the revise route creates a new version with `client_approval_status='pending'`,
  which naturally restores the pending controls on the next render.

### [revise-later] Messaging subject char-count discrepancy — likely trailing space (2026-06-06)

- Added 2026-06-06. Cosmetic, no send impact.
- Variant A Email 1 reports `subject_char_count: 20` for "still the bottleneck".
  Variant B Email 1 reports `subject_char_count: 19` for what appears to be
  identical text.
- Most likely cause: a trailing space in one variant's subject_line string that
  the model included but the eye cannot see in the dump.
- No send impact (email clients trim subject whitespace). But the char-count
  validator is counting it, which means the validator is correct and the model
  introduced a trailing space. Add a `.trim()` to the subject_line field in the
  post-processor to prevent this class of off-by-one in validator counts.

---

## Post-approval dashboard audit — 2026-06-06

### [pre-c0] Client sidebar missing "Overview" nav entry (2026-06-06)

- Added 2026-06-06. Must fix before client zero goes live.
- The client's primary status page (`/dashboard`) has no entry point in the sidebar nav.
  The sidebar starts at Pipeline (locked) and Benchmarks under the Results group, then
  strategy sub-pages. There is no "Overview" item.
- The wordmark ("MargenticOS") in the sidebar header is a plain `<span>` — confirmed not
  a link. `src/components/dashboard/Sidebar.tsx` lines 76-81. The client has no in-nav
  way to return to the overview after navigating into a strategy sub-page without using
  browser back or retyping the URL.
- Fix: add `{ label: 'Overview', href: '/dashboard' }` as the first item in the
  `RESULTS_ITEMS` array (or a new top-level group) in `Sidebar.tsx`. Active state logic
  should match exactly `/dashboard` — not startsWith, since every page starts with it.
  Optionally convert the wordmark `<span>` to a `<Link href="/dashboard">` as a secondary
  affordance, but the nav item is the minimum fix.

### [pre-c0] LinkedIn mentions sweep — all client-facing surfaces behind one toggle (2026-06-06)

- Added 2026-06-06. Supersedes and extends the [product-decision] entry above
  (LinkedIn content card in DocumentsActiveState — keep or pull, 2026-06-04).
  That entry asked a binary keep-or-pull question. This entry settles it:
  **hide ALL client-facing LinkedIn mentions until the LinkedIn channel launches.**
  Do not patch one surface at a time as they are discovered.
- **Confirmed client-facing surfaces as of 2026-06-06:**
  1. `DocumentsActiveState.tsx:97` — detail text: "Email sequences and LinkedIn content
     being configured" (embedded in the email outreach setup step description)
  2. `DocumentsActiveState.tsx:101` — card label: "LinkedIn content"
  3. `DocumentsActiveState.tsx:104` — card detail: "First posts being drafted for your
     approval"
  4. `IntakeIncompleteState.tsx:22` — Messaging card description: "Email and LinkedIn
     outreach frameworks"
  5. `IntakeIncompleteState.tsx:41` — setup checklist item detail: "Email and LinkedIn
     channels configured for your campaigns"
- The `linkedin` setup-status key in `DocumentsActiveState.tsx` drives the entire
  LinkedIn card (key, label, statusLabel, done). The whole card should be conditionally
  rendered behind a `linkedinChannelEnabled` toggle (defaults false).
- The toggle should live on the organisation record or in a feature-flags config so it
  can be turned on per-client when LinkedIn delivery is actually active.
- Operator-only references to LinkedIn (SetupStatusPanel.tsx) are unaffected — the
  operator must still be able to see and set LinkedIn status.
- **Do not sweep these individually** as they are noticed. Build the toggle once and
  gate all surfaces in the same commit.

### [pre-c0] Warmup progress % and launch date not anchored to real warmup state (2026-06-06)

- Added 2026-06-06. Must fix before client zero goes live — this is a client-facing date
  promise.
- **Confirmed derivation**: `DocumentsActiveState.tsx` uses `contract_start_date + 42 days`
  for both the launch date string (line 55) and `warmupProgressPercent` (lines 61-67).
  `contract_start_date` is entered by the operator in `CreateOrgForm` at client creation.
  The pipeline page (`/dashboard/(client)/pipeline/page.tsx` lines 23-28, 162) uses the
  same function. For the DRY RUN PartScale org, `contract_start_date` aligns with org
  creation date, making the displayed "4% / 17 July" read as "2 days elapsed / 6 weeks
  from org creation."
- **The problem**: `contract_start_date` is a form field, not a warmup signal. Email
  warmup does not start until the client's mailboxes are connected to Instantly and
  warmup is activated. A client can complete intake the same day the org is created yet
  have mailboxes that haven't warmed at all. The 6-week clock and the client-facing
  launch date are a hard promise derived from form-completion, not from technical reality.
- **Required fix**: introduce `warmup_started_at` as a nullable timestamp on the
  `organisations` table. The operator sets it manually when Instantly warmup is confirmed
  active for the client's mailboxes. When `warmup_started_at IS NULL`:
  - Hide the warmup progress bar entirely ("Warming up — your outbound team will confirm
    when campaigns are ready to launch" or similar).
  - Show no launch date. A client-facing launch date must never appear until warmup is
    actually underway.
  When `warmup_started_at IS NOT NULL`: derive progress as `(now - warmup_started_at) / 42 days`
  and launch date as `warmup_started_at + 42 days`.
- **Future state** (Phase B or later): replace `warmup_started_at`-based calculation with
  live Instantly warmup analytics API (`GET /api/v2/accounts/warmup-analytics`) when
  mailbox accounts are registered in the system. The API returns actual warm-up health
  per mailbox, which is a better signal than elapsed time regardless of anchor.
- Surfaces to update: `DocumentsActiveState.tsx` (progress bar + launch date), pipeline
  page `estimateLaunchDate` and `MomentumBlock`/`MeetingsListCard` empty states.

---

## Items added / confirmed 2026-06-08 (Phase B mid-flight handover session)

### [note] founder_first_name is required by the add-client form — not a blocker (2026-06-08)

- Added 2026-06-08. Informational — no build action needed.
- The S3 WALK TEST org was created via direct DB insert, which did not populate
  `organisations.founder_first_name`. The messaging cascade therefore had no name to
  sign the generated copy with, causing the messaging agent to fail in that test.
- This is NOT a system gap: the operator add-client form (`CreateOrgForm`) requires
  `founder_first_name` at line 56 and the `create-org` server action (`actions.ts` line 147)
  enforces it. Any org created via the UI will always have this populated.
- Reminder: direct DB insert for test orgs must set `founder_first_name`. The S3 re-verify
  uses the operator add-client form precisely to ensure this is populated automatically.

### [pre-c0] S6: Intake UX fixes — four items (2026-06-08)

- Added 2026-06-08. Must fix before client-zero goes live.

**S6-A: False-green progress pills (ROOT CAUSE confirmed)**
- Sections with zero required fields report complete before being touched.
- "Your voice" and "Existing assets" showed green ticks on a fresh org in the S3 WALK TEST.
- Root cause: `IntakeForm.tsx` derives section completion from `criticalFields` filtered to
  that section. A section with no critical fields has `completeness = NaN` or `1` (divide by
  zero edge case), which passes the green threshold.
- Fix: if `criticalFields.length === 0` for a section, that section should report
  `not_applicable` (no pill) or `incomplete` (empty pill), never `complete`.
- File: `src/components/intake/IntakeForm.tsx` — section completion derivation logic.

**S6-B: Em-dash sweep of intake question copy and confirmation/overview copy**
- Known instances confirmed in the S3 WALK TEST UI pass:
  - Dictation nudge: "speak your answers -" (uses a hyphen that should be a comma or period)
  - Tab close hint: "close this tab -" (same)
  - Voice samples hint: "anything showing your voice -" (same)
  - Confirmation/overview state copy may also carry instances.
- Sweep: grep all IntakeForm copy strings, the TOV section label/description, and any
  overview/confirmation state strings in `IntakeIncompleteState.tsx` and `IntakeForm.tsx`
  for ` - ` (space-hyphen-space used as an em-dash substitute) and true em-dashes.
  Replace with periods, commas, or sentence restructuring per CLAUDE.md style rules.

**S6-C: Flip TOV tab default to "Type your voice" primary, "Upload files" secondary**
- Current state: the TOV section in IntakeForm opens with "Upload files" as the active tab.
- Required: "Type your voice" should be the default active tab. Upload is a secondary option
  for clients who have existing writing samples they want to attach.
- File: `src/components/intake/IntakeForm.tsx` — TOV section tab initial state.

**S6-D: Remove stray required asterisk from optional Voice-samples upload field**
- The Voice-samples file upload field shows a required asterisk (*) despite being optional.
- A client who sees the asterisk may feel blocked from submitting without uploading a file.
- Fix: remove the asterisk from the label or wrapper. The field is not in the 12 critical
  fields that gate the Generate button.
- File: `src/components/intake/IntakeForm.tsx` — Voice-samples upload field label.

### [DONE 2026-06-08] S3 re-verify — fresh org — ALL STEPS PASS

- Added 2026-06-08. RESOLVED 2026-06-08.
- Org: S3 Reverify (`0b636e90`), created via operator add-client form, `founder_first_name: Alex`.
- D1 fix confirmed: `agents_dispatched_at` stamped once; ICP (112s) + TOV (75s) runs only;
  positioning_runs=0; messaging_runs=0; `docs_complete_notification_sent_at=null`; no false email.
- IcpTierCard visual proof confirmed by Doug: four_forces (collapsible), triggers with evidence
  bullets, switching_costs, disqualifiers, buyer_profile (seniority/day_to_day/identity),
  company_profile (stage/geography/business_model) all rendered. No content gaps.
- S6 polish item identified: buyer_profile fields and company_profile fields render as a flat
  labelled list with no subheading. Add "Buyer profile" and "Company profile" section
  subheadings so groupings are visually obvious. Not a content gap — purely presentational.
  See S6-E entry below.

### [pre-c0] S6-E: IcpTierCard — add Buyer profile + Company profile subheadings — RESOLVED 2026-06-08 (commit 059036c)

- Added 2026-06-08. Identified during S3 visual proof walk. Fixed same session.
- Added `font-semibold` uppercase 10px section labels at the top of each block,
  consistent with "Four forces" / "Triggers" style.
- File: `src/components/approvals/ApprovalCard.tsx` — `IcpTierCard` component.

### [MUST-FIX-BEFORE-B2] F-1: Magic link scanner consumption — blocks real client onboarding (2026-06-08)

- Added 2026-06-08. Elevated from logged to MUST-FIX-BEFORE-B2.
- **Confirmed break:** welcome email magic link (type=invite, action_link) consumed by
  Gmail/corporate-gateway link prefetch before user clicks. Client sees "Invalid link.
  Please request a new one." This breaks first-time client login on the welcome email.
- **Also breaks B2:** the 360dungarvan dry-run walk (Doug's father clicks welcome email)
  fails on this exact path if unfixed.
- **Research required before building** (primary sources, not assumption):
  - Does Supabase PKCE flow prevent scanner consumption? For sign-in flows (user initiates
    from browser), PKCE stores a code_verifier in localStorage that the scanner lacks.
    For INVITE links (no prior browser session), PKCE verifier cannot be pre-stored — need
    to verify whether Supabase's admin generateLink supports PKCE and what happens when
    a scanner follows the link without the verifier.
  - Alternative: OTP-code-only welcome email. Send a 6-8 digit code; no URL to prefetch.
    User goes to app, enters email + code. The login OTP path already exists for sign-in.
    Needs: welcome email template rewrite + /welcome or /login code-entry extended for
    first-time users.
  - Supabase docs to check: Authentication > Magic links > PKCE flow; Email OTP;
    `supabase.auth.admin.generateLink` options.
- **Decision gate:** confirm which approach Supabase supports for invite/welcome links
  specifically, then implement. Do not build until approach is decided.
- Files affected: `src/lib/email/templates/client-welcome.ts`, `src/app/login/actions.ts`

### [MUST-FIX-BEFORE-B2] F-1: Magic link scanner consumption - RESOLVED 2026-06-09

- Resolved 2026-06-09 by the F-1 OTP work this session. Shipped the OTP-code-only
  approach listed as the alternative: the Magic Link template now shows the token
  code only (no ConfirmationURL), so there is no consumable URL for a scanner to
  prefetch. Both auth legs (invite and returning-user) verified clean. OTP set to
  8 digits, 86400s expiry. Double-submit race fixed via useFormStatus. Unblocks B2.

### [pre-c1] REV-2: Revision agent ignores explicit positional targets (2026-06-09)

- Added 2026-06-09. Observed during S5 verification. Client note said "in variant A,
  email 1, the first line is confusing, make it simpler." The agent left the first
  line untouched and rewrote the second sentence (the part it judged jargon-heavy).
- **The problem:** when a client names a specific location (the first line, email 2,
  the subject), the agent treats it as a hint and substitutes its own judgment of
  what to change instead of honoring the named target.
- **The fix:** in the mediation prompt, an explicit location is a binding target.
  Change THAT location to satisfy the intent; do not relocate the change elsewhere.
- **Caution:** do not over-correct into a literal transcriptionist. It must still
  mediate intent, just within the named target. Verify with a re-run after editing.
- File: `run-revision.ts` (mediation prompt).

### [pre-c1] REV-2: Revision agent ignores explicit positional targets - RESOLVED 2026-06-09

- Resolved 2026-06-09. The "Named Locations Are Fixed Targets" section was added to
  the mediation prompt in `src/lib/agents/revision/run-revision.ts`. When a client's
  note names a specific location (the first line, email 2, the subject line, the
  opening, the closing), that location is now a binding target: the change must happen
  at that exact spot. The agent still decides HOW to satisfy the intent within the
  named location; it no longer substitutes a different passage it judges to be the
  real problem. Verified present in the prompt builder at the "Named Locations Are
  Fixed Targets" section of `buildRevisionPrompt()`.

### [deferred] REV-1: update_trigger mislabel on promoted client revisions (2026-06-09)

- Added 2026-06-09. Cosmetic. Identified during S5 build. Deliberately deferred.
- **What:** approve_document_suggestion hardcodes update_trigger = 'signal_suggestion'
  on promotion, so an approved staged messaging revision lands labeled signal_suggestion
  in strategy_documents instead of client_revision.
- **Why deferred:** SECURITY DEFINER change, belongs with the deferred operator-initiated
  revisions phase. Correctness does not depend on it: the rate limiter was made type-aware
  specifically so this label is purely cosmetic. The client-facing "what changed" copy is
  driven by suggestion_reason, not update_trigger, so it reads correctly.
- File: `approve_document_suggestion` (Postgres function).

### [DONE 2026-06-12] OPS-1: Operator client-detail view

- Added 2026-06-09. Brainstormed during S5 closeout. Not blocking B2; wanted before
  onboarding founding clients.
- **Status: COMPLETE** — shipped 2026-06-12 as part of operator ergonomics batch.
- **Fields delivered:** company name (organisations.name), founder/primary contact
  (organisations.founder_first_name), login email (users.email), last login (users.last_seen_at),
  the four document statuses (strategy_documents), warmup/launch state
  (campaigns + organisations.warmup_started_at), dispatch mode (live/mock),
  date onboarded (organisations.created_at), "Waiting on you" block (pending suggestions).
- **Fields with no schema backing:** industry, pricing/contract value, revenue range,
  contract start date, segments, outcomes — deferred as these would require additional
  schema columns or are sourced from intake_responses as unstructured data.
- **Split build:** Phase 1 (2026-06-12) delivered the "what's waiting on you" block
  plus client profile section. Phase 2 can extend outcomes (prospects, sent, replies,
  meetings) once campaign analytics/signals mature.

### [pre-b2] OPS-2: Test-automation harness (2026-06-09)

- Added 2026-06-09. Scope before B2, where repeated full-journey walks start to pay off.
- **What:** automated drive of the full client journey (onboard, generate, approve,
  request changes, dispatch in mock mode) for regression safety as the surface grows.
- **The crux:** OTP login is the one hard part for either Playwright-MCP or API-level.
  Solve once: capture generateLink's email_otp, read auth.one_time_tokens with the
  service role, or mint a service-role session. Everything else is easy after that.
- **Decision gate:** Playwright-MCP vs API-level after scoping the login solution.

### [pre-c1] SEC-1: Sign-in enumeration leak (2026-06-09)

- Added 2026-06-09. Low severity (invite-only B2B). Identified during F-1 work.
- **What:** signInWithOtp with shouldCreateUser:false returns 422 otp_disabled for
  non-existent emails vs success for existing ones, revealing whether an account exists.
- **The fix:** show one neutral message for both ("if that email is registered, a code
  has been sent") and route to code-entry regardless.
- File: `src/app/login/actions.ts`.
  (or new `/welcome` route), `src/app/dashboard/operator/clients/new/actions.ts`.

### [pre-c1] SEC-1: Sign-in enumeration leak - RESOLVED 2026-06-09

- Resolved 2026-06-09. Both branches of `sendMagicLink` in `src/app/login/actions.ts`
  now redirect to `/login?sent=true&email=...` regardless of whether the email is
  registered. The 422 response (shouldCreateUser:false, otp_disabled) is caught,
  logged at info level, and treated identically to a successful OTP send. No error
  page, no different message, no distinguishing response. Verified in code: the
  `isUnknownEmail` branch (lines ~46-53 of `actions.ts`) falls through to the same
  `redirect()` call as the success path.

---

## Security findings from /cso audit 2026-06-09

- [pre-c1] Dead /auth/callback route (src/app/auth/callback/route.ts)
  The route is a leftover from the previous magic-link flow. It has zero references
  in src/ and is unreachable under the current OTP-code flow (no emailRedirectTo is
  set in sendMagicLink). It contains an unvalidated next-parameter redirect at line 27
  that would be an open redirect IF the route were ever made reachable.
  
  Recommended action: delete the route (preferred, removes the latent risk entirely),
  or if it must be kept for a planned magic-link path, add an internal-path guard
  inside the route itself. Note that a naive next.startsWith('/') check is
  insufficient: it must also reject protocol-relative URLs (leading double slash) and
  backslash variants, which browsers can treat as external.
  
  Not exploitable today. Severity: low while unreachable.

- [pre-c1] BACKLOG provenance correction: Fix 6 (commit 1b6ae3d, 2026-05-06)
  That entry claims an open-redirect guard "must start with /" was implemented on the
  magic-link callback. No such guard exists in src/app/auth/callback/route.ts.
  
  The actual protection in the live flow is the safeNextPath allowlist in
  src/app/login/actions.ts lines 13-18 (restricts to /dashboard/, blocks
  /dashboard/operator, defaults otherwise), which is sound.
  
  Recording this so the discrepancy is not mistaken for a missing fix later.

- [pre-c1] Worktree branch reintroduces unguarded callback (.claude/worktrees/agent-ae91d40d71b6a63b8/src/app/login/actions.ts)
  The in-progress branch sets emailRedirectTo to /auth/callback at line 32, making the
  route reachable on that branch. It is currently safe only because the caller
  pre-validates next via safeNextPath (lines 12-18).
  
  If that branch merges, the route must carry its own guard (per first entry above)
  before or at merge time, because a future refactor of the caller would otherwise
  open a real redirect hole.
  
  Flag to review at merge time.

- [RESOLVED 2026-06-09] Documentation: reply-drafts routes access model corrections
  Corrected header comments in src/app/api/reply-drafts/route.ts and src/app/api/reply-drafts/[id]/route.ts
  to accurately reflect the actual implementation: operator cross-org access per ADR-021, not org-scoped per ADR-003.
  Comments now state clearly that endpoints are cross-org, returning/querying drafts from all organisations.
  Changed "Three auth checks" to "Two auth checks" and removed misleading org-scoping claims.
  Shipped in commit: (pending - see git diff).

- [RESOLVED 2026-06-09] Client dashboard data visibility: removed operator-only columns
  Removed engagement_month from two client-facing queries:
  1. src/app/dashboard/(client)/page.tsx line 105: removed engagement_month from organisations SELECT
  2. src/app/dashboard/(client)/pipeline/page.tsx line 71: removed engagement_month from organisations SELECT
  Also removed engagement_month property from DocumentsActiveState component (src/components/dashboard/empty-states/DocumentsActiveState.tsx)
  and updated UI text from "Month X" to "Ready" / "Pipeline" to reflect that engagement data is operator-only.
  RLS filters rows, not columns; app layer must prevent SELECT of sensitive fields.
  Shipped in commit: (pending - see git diff).

---

## Consolidated dry-run findings: Simcare + 360dungarvan B2, 2026-06-11

Investigation scope: ICP industry mislabel, Green Flag provenance, docs-ready email path, em-dash verification.
Code audit completed 2026-06-11.

- [pre-c0, HIGH] Transactional email junk-folder rate on Outlook
  Evidence: docs-ready notification landed in junk for an Outlook recipient (inboxed on Gmail).
  Target market is Microsoft-heavy (consulting firms, founders). SPF/DKIM/DMARC misalignment causes
  Outlook to distrust Resend subdomain. Root cause likely: transactional mail from notifications.margenticos.com
  but SPF/DKIM only configured on margenticos.com apex. Resend requires subdomain SPF/DKIM records.
  Investigation 3 finding: docs-ready notifications use sendTransactionalEmail() in
  src/app/api/intake/complete/route.ts (lines 114-118), from-address from RESEND_FROM_EMAIL env var.
  Action: (a) Audit SPF/DKIM/DMARC alignment on the Resend sending domain, verify subdomain DNS records;
  (b) re-test against an Outlook mailbox after fix; (c) include the actual from-address found in env vars.

- [pre-c0, HIGH] ICP agent industry mislabel — primary-schools business tagged as "Management Consulting"
  Root cause: canonical industries taxonomy gap. Investigation findings:
  (a) ICP agent prompt (docs/prompts/icp-agent.md line 353-369) enforces canonical NAICS-derived
      industries list from icp-filter-spec.ts. List includes 25 categories across consulting,
      accounting, legal, HR, IT, and others — but NO education-sector categories.
  (b) Canonical list (src/lib/agents/icp-filter-spec.ts lines 14-40) lacks education-related names.
      No "Education Consulting", "K-12 Services", "Primary Education", "Educational Services",
      or any school-sector category exists.
  (c) Prompt rule (line 369): "If a relevant industry is not on this list, use the closest match.
      Do NOT invent a new name." This forces a default to "Management Consulting" when a
      primary-schools business (Education sector) is encountered.
  Fix options: (1) Add education-sector categories to CANONICAL_INDUSTRIES and update the prompt
  to reference the extended list, OR (2) Tighten the "closest match" fallback logic to warn/flag
  when defaulting rather than silently accepting the mismatch. Recommend option (1) — education
  is a major B2B vertical and the ICP agent is industry-agnostic. Categories to add:
  "Education Consulting", "Training and Development" (already exists), "K-12 Services",
  "Higher Education Services" (or "Academic Consulting").
  
  When fixed: regenerate ICP for affected org to validate new category is applied.

- [pre-c1, RESEARCH] Green Flag provenance — source identified or agent hallucination?
  The 360dungarvan messaging agent output references a "Green Flag initiative" the client
  reports they never provided in intake. Cannot verify database state without live connection.
  Investigation needed: (a) Check if company_url was populated + ingestion ran successfully;
  (b) Query intake_website_pages for "Green Flag" or "Green Schools" text; (c) if found in
  website content, mark as website-ingestion win; (d) if NOT found, log as agent hallucination
  and add grounding rule to messaging agent (never synthesize external initiatives without
  evidence in ICP/positioning/TOV documents).
  Severity: low at client-zero volume; high signal for eval at scale if pattern repeats.

- [pre-c1] Operator per-client intake-form view, read-only (OPS-1 dependency)
  Status: Small, high-value standalone build, elevated priority per operator feedback.
  Allows operator to review client's raw intake responses (text, files, website fetch results)
  at any time. Helps debug agent output quality and verify data provenance.
  Does not wait for full OPS-1 client-detail view — can ship independently.

- [pre-c1] Agent quality batch — three coordinated fixes
  (a) Industry taxonomy: add education-sector categories per finding above.
  (b) ICP and positioning output: over-indexes on margin + efficiency pain; rebalance across
      all pain dimensions discovered in client intake (delivery, retention, growth pipeline,
      team retention, founder burnout, etc).
  (c) TOV formality clamp: cold email brevity and conversational register must override client
      brand-voice formality guideline. Currently TOV guide may instruct formal register that
      kills reply rate in cold context. Channel constraints (email length limit, opener risk)
      override brand preference in outbound.

- [pre-c1, RESEARCH] Break-up email near-identical across variants — intent verification needed
  Four-email sequence Email 4 (break-up) is near-identical across the A/B variants in generated
  copy. Review whether intended (economics suggest yes — final touch is final), or whether copy
  variation was lost in template rendering. If the former, document as architecture note.
  If the latter, review copy-generation prompt for variant-awareness.
  Also: client preference for hyperlinked company name in final email. Deliverability research
  required (links in cold-email body increase spam-filter risk). Default policy: no body links.

- [post-B2 decision] Document cascade staleness: regeneration should flag staleness, never auto-regen
  When a client requests ICP or positioning refresh, the downstream messaging and TOV documents
  should be marked as stale (new flag or status change) rather than auto-regenerating. Operator
  should see the cascade and choose whether to also refresh downstream docs or hold them.
  Awaiting operator sign-off on workflow, then implement as pre-c1 quality gate.

- [note] B2 dry-run validation checkpoint: what shipped, what was covered, what pending
  **Shipped end-to-end:** outsider auth (cold signup), intake form completion, document generation
  (ICP, positioning, TOV, messaging), document approval with revision requests, dispatcher routing.
  **Mocked in B2:** email composition and mock-dispatch (not live sending). Both exercised in
  2026-06-04 reference-org lap; reusable for B2.
  **Pending:** returning-user login flow for 360dungarvan (one confirmation still needed).
  **Em-dash verification (Investigation 4):** cannot be run without live database connection.
  Query strategy_documents for both orgs, count em-dashes per document_type. Expected result: zero
  (all em-dashes should be stripped by assertNoDashes gate in icp-generation-agent.ts line 176).
  
- [pre-c1, PRODUCT FRAMING] Strategy documents: client confusion about purpose
  Clients receive four impressive strategy documents (ICP, Positioning, TOV, Messaging) but
  are unsure what they are for or how they power campaigns. Add framing copy in:
  (a) Dashboard intro/contextual help: position docs as "the engine that powers all your outreach"
  (b) Onboarding UI: brief explainer of each doc's role in campaign generation
  (c) Document approval/revision UI: header explaining how each document informs agent output
  No feature build required — copywriting + UI text changes only.

- [note] Em-dash verification result (Investigation 4) — REQUIRES DATABASE ACCESS
  Could not run without live Supabase connection. Should execute as separate task once
  operator confirms 360dungarvan and Simcare org IDs. Query: SELECT COUNT(content::text),
  for each organisation's strategy_documents where status='active', search content for
  em-dash character (—) in all eight document types (ICP, Positioning, TOV, Messaging x2,
  etc). Expected: zero per document if assertNoDashes gate is working.

---

## Prospect sourcing Phase B — Deferred items (2026-06-12)

Phase B delivered: schema migration (icp_filter_spec, sourced_tier, qualified_at columns), 
spec persistence (persistIcpFilterSpec helper called post-promotion), sourcing orchestrator 
(PRD-15 steps 1-4), types/contracts. Mock dispatch ON; no live API calls.

- [phase2] Backfill pre-existing approved ICPs with NULL icp_filter_spec (2026-06-12)
  Three organisations have approved ICPs that were migrated with NULL icp_filter_spec:
  - DRY RUN TEST (version 3, approved 2026-06-06)
  - MargenticOS (version 5, approved 2026-06-03)
  - Simcare (version 2, approved 2026-06-10)
  Decision: backfill spec for these three to unblock sourcing when the handler goes live,
  OR treat NULL as a gate requiring re-promotion. Deferred pending first real sourcing flow.
  If backfill chosen: run persistIcpFilterSpec manually against these three document IDs,
  or build a backfill SQL + batch runner.

- [phase2] Apollo sourcing handler: POST /api/v1/mixed_people/api_search (2026-06-12)
  Next build step. Orchestrator currently fails loudly at step 2 (no active handler for 
  can_source_prospects) - correct current behaviour.
  
  Handler implementation scope:
  1. Implement adapter-apollo.ts (SourcingHandler interface)
  2. Translate ICPFilterSpec to Apollo mixed_people/api_search query payload (mapping canonical 
     industries to Apollo taxonomy, building seniority+job_title query, geography filters)
  3. Batch search calls (max 100 results per call) to reach target_batch_size
  4. Response parsing: normalise Apollo response shape to ProspectCandidate array
  5. Return candidates (not yet tier-routed: that's step 6)
  
  Note: Apollo endpoint is master API (POST /api/v1/mixed_people/api_search, master API key required, 
  plan-gated above free, confirmed live 2026-06-12). The legacy mixed_people/search endpoint is not 
  the build target.
  
  Enable in orchestrator: update integrations_registry.is_active = true after handler 
  implementation + testing.

- [phase2] Complete sourcing steps 5-9: tier routing, dedup, DB writes, uploads (2026-06-12)
  PRD-15 steps 5-9 currently throw NotImplemented in orchestrator.
  
  Step 5: Tier routing (assign sourced_tier per prospect based on ICP comparison)
  Step 6: Prospect deduplication (check if prospect already exists in DB)
  Step 7: Database writes (insert new prospects, update sourced_tier + qualified_at)
  Step 8: Outbound upload (push to Instantly via can_upload_leads handler)
  Step 9: Batch approval (toggle campaign.sourced_batch_ready for operator approval)
  
  Trigger: after Apollo handler ships and is tested.

- [phase2, pre-c1] Candidate-level sourcing review gate (2026-06-12)
  REJECTED 2026-06-12: campaign-level sourced_batch_ready boolean.
  Replaced with prospect-level sourcing_review_status column (pending_review / approved / rejected).
  Operator approves per candidate or per batch BEFORE enrichment spend (Phase B).
  Gate position: after orchestrator deduplication, before enrichment, before sending.
  Design: prospects.sourcing_review_status enum, indexed per organisation.
  Rejection reason: campaign-level boolean was wrong granularity (all-or-nothing).
  Prospect-level allows operator to cherry-pick candidates before costly enrichment.

- [pre-c1] 360 Bia Og ICP approval status investigation (2026-06-12)
  Query result at Phase A Amendment 7: 360 Bia Og has two ICP documents (v1 archived, v2 active)
  but both have client_approval_status = 'pending'. Expected to hold an approved ICP.
  Operator action: review why client approval is pending (approval_source NULL, approved_at NULL).
  Did the approval get stuck, or is this org still in ICP generation/review phase?
  Not a build blocker — informational flag for operator review.

---

## Identity rule reversal — founder-name signing (2026-06-12)

- [pre-c1] REVERSED: outbound and replies now signed with founder name and title, not Team
  ADR-020 updated (May 2026 → June 2026). Rationale: founder reviews and approves all operator-reviewed 
  outbound and replies, so signing with their name and title is accurate and warm.
  
  Commit abb07f9: design.md, reply-handling.md, prd/09-reply-handling.md, new migration and types.
  
  Build complete:
  - organisations table: added founder_last_name and founder_title (nullable text columns)
  - Signature convention documented in design.md: plain text block, no links except Calendly in replies
  - Instantly account-level signatures NOT used (signatures composed at send time — deliberate decision)
  
  Onboarding requirement (pre-c1): PandaDoc contract template must include consent clause.
  Client founder explicitly consents to their name and title appearing on all outbound and replies
  before campaign goes live. Required for first paid client onboarding.
  
  Next action: update PandaDoc contract draft with consent clause before shipping.
