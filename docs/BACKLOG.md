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

- [monitor] signals_signal_type_check constraint does not include 'reply_received' (2026-05-02)
  The signals table check constraint only allows the original Phase 1 signal types.
  The polling code in instantly.ts inserts signals with signal_type = 'reply_received', which
  violates the constraint. This means all reply signal inserts currently fail silently.
  Fix: run a migration adding 'reply_received' (and 'email_bounced', 'lead_unsubscribed' if not
  already there) to the signals_signal_type_check constraint.
  Impact: blocking — no reply signals will be written until fixed.
  Priority: next session before Group 4 can be tested end-to-end.

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

- [phase2] Drafter null return loses the signal permanently (2026-05-02)
  When draftReply() returns null, the orchestrator returns log_only and the caller marks
  the signal as processed. No retry occurs. For transient Anthropic failures (timeout, 529),
  this means the reply goes unanswered without even a manual_required placeholder.
  Fix options: (a) write a manual_required placeholder when drafter returns null, or
  (b) leave signal unprocessed (don't call markSignalProcessed) so it retries next cron.
  Either requires changing both orchestrateDraft() and the caller's mark-processed logic.
  Deferred to post-Group-4 when we have live failure data to decide the right policy.

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

- [phase2] Group 5 sign-off — reply-draft-agent prompt + operator triage UI (2026-05-02)
  Group 4 ships the orchestrator and routing. Group 5 is the operator triage view where
  drafted replies are reviewed, edited, and sent. Without Group 5, Tier 2/3 drafts write
  to reply_drafts but the operator has no UI to action them.
  This is the next group to build. The reply_drafts table is the queue; Group 5 reads it.

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

- [phase2, trigger: Group 7 curation UI build] Tune name-detection false positives.
  Current detection flags single-letter capitals ("I"), compound technical terms
  ("AI-assisted", "AI-written"), and likely other non-name capitalised tokens.
  At Group 7 build time, decide: filter at detection layer (faq/name-detection.ts)
  or at UI display layer. Premature to choose now without knowing the curation UI surface.

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

---

## Application-layer notes

- [reminder] Application queries against organisations for client-facing views must never
  SELECT payment_status, contract_status, or engagement_month. RLS filters rows, not columns.
  App layer is responsible.

- [reminder] CRON_SECRET stored plaintext in cron.job.command — acceptable for this low-impact trigger token; not a pattern for high-value credentials. Use Supabase Vault for those.

- [reminder] Vercel Hobby silently rejects sub-daily cron schedules at build time — all scheduling for sub-daily jobs uses pg_cron. vercel.json crons entry must be empty or daily-only.
