# sections/14-phasing.md — Phase One Through Four with Deliverables
# MargenticOS PRD | April 2026
# Read prd/PRD.md first, then this section for build sequencing and scope decisions.
# Phases are a guide, not a contract. Priorities shift as the build progresses.
# When scope changes, update this file and note the change date.
# Last meaningful update: April 2026 — sourcing pipeline architecture added (ADR-015, 016, 017, 018).

---

## Phase one — Foundation

Goal: A working system that can run MargenticOS as client zero and onboard 3 founding clients.

### Infrastructure
  - [x] Next.js project initialised, TypeScript configured, Tailwind configured
  - [ ] Git repository set up with three-environment branching (dev / staging / prod)
  - [ ] Vercel deployment configured for all three environments
  - [ ] Sentry error monitoring connected
  - [x] Supabase project created, local dev environment connected
  - [x] Supabase MCP installed and configured

### Database
  - [~] All tables created with RLS policies verified before any application code
  - [x] Tables: organisations, users, strategy_documents, document_suggestions,
               intake_responses, signals, patterns, integrations_registry,
               campaigns, prospects, meetings
  - [x] document_suggestions includes all fields:
               signal_count, confidence_level, ab_variant, conflicting_suggestion_id
               (schema only — processing logic deferred to phase two, per ADR-011)
  - [x] integrations_registry populated with all phase one tools
  - [x] Hunter.io registered with is_active = false (capability reserved, not built)

### Schema additions — sourcing pipeline (new Phase 1 work, per ADR-015/016/017)
  - [ ] strategy_documents: add icp_filter_spec jsonb column (populated when document_type='icp')
  - [ ] organisations: add tam_status (text: green/amber/red/override)
  - [ ] organisations: add tier_3_enabled (boolean, default false)
  - [ ] organisations: add send_velocity_per_day (integer)
  - [ ] prospects: add sourced_tier (text: tier_1/tier_2/tier_3)
  - [ ] prospects: add qualified_at (timestamptz, when passed qualification into DB)
  - [ ] integrations_registry: add supported_fields manifest per sourcing handler

### Authentication
  - [x] Supabase Auth with magic link
  - [x] Operator and client roles
  - [x] Three-check auth on every API route
  - [x] Operator route protection

### Intake
  - [x] Questionnaire UI with all five sections
  - [x] 80% completeness threshold enforcement (critical fields)
  - [x] Follow-up prompts for under-answered critical fields (<20 words)
  - [ ] File upload (Supabase Storage)
  - [ ] Website URL ingestion (homepage + 3 inner pages)
  - [ ] Buyer self-descriptor field (pre-first-non-consulting-client requirement — see BACKLOG.md)

### Document generation agents
  - [x] ICP generation agent (claude-opus-4-6)
  - [x] Positioning generation agent (claude-opus-4-6)
  - [x] TOV generation agent (claude-opus-4-6)
  - [x] Messaging playbook agent (claude-sonnet-4-6 per ADR-013, four variants per ADR-014)
  - [x] All agents isolated by client_id
  - [x] Documents written to strategy_documents with versioning
  - [ ] ICP agent extended to output structured icp_filter_spec (ADR-015)

### Sourcing pipeline (new Phase 1 work, per ADR-015/016/017)

  - [ ] ICPFilterSpec schema defined and documented (13 filter fields + meta)
  - [ ] NAICS-derived canonical industry taxonomy committed (internal reference file)
  - [ ] Apollo handler exports supported_fields manifest
  - [ ] Apollo handler consumes ICPFilterSpec, translates to People API Search params
  - [ ] Apollo handler verifies canonical industries → Apollo industries translation table
  - [ ] Sourcing Orchestrator (deterministic, no LLM): reads spec, checks handler support,
        calls handler, applies tier classification, writes qualified prospects to DB
  - [ ] Inventory Monitor scheduled job (deterministic, daily): counts unused qualified
        prospects per client, compares to send velocity, triggers sourcing if below floor
  - [ ] Tier classification logic (deterministic): Tier 1 full match, Tier 2 loosened,
        Tier 3 further loosened; loosening rules configured per client at onboarding
  - [ ] Composition handler extended to branch on sourced_tier (Tier 1 full research,
        Tier 2 light research, Tier 3 templated only)
  - [ ] Per-tier signal indexing so metrics can be sliced by tier
  - [ ] Per-tier quality warning (Tier 3 qualified rate < 40% while Tier 1 > 70%)
  - [ ] Instantly B2B Lead Finder registered in integrations_registry as is_active=false
        (reserved capability, no handler built)

### Prospect qualification and research
  - [x] Prospect research agent — partially built, Step 1 (Apollo) blocked on paid plan
  - [ ] Prospect research agent — tier-aware routing (runs only for Tier 1 and Tier 2)
  - [ ] Prospect research agent — re-verified against Apollo Basic plan after upgrade

### TAM report and gate (new Phase 1 work, per ADR-016)
  - [ ] TAM Operator Tool dashboard page (calls Apollo People API Search, returns count)
  - [ ] TAM report generation (post-intake, runs against full filter spec)
  - [ ] Three-state classification (green/amber/red) with thresholds enforced
  - [ ] Red state blocks automatic sourcing activation without operator override
  - [ ] Operator override flow (recorded reason, auditable)

### Dashboard — client view
  - [x] Empty state view (months 1–2) — first-class view, not a fallback
  - [x] Strategy document view (read-only)
  - [x] Pipeline view (post-unlock)
  - [x] Approvals view
  - [x] Phased unlock logic (2 months OR 5 meetings)

### Dashboard — operator view
  - [x] Operator sidebar with amber badge and client selector
  - [x] All clients overview
  - [~] Warnings rail
  - [~] Agent activity log
  - [x] Per-client settings (thresholds, toggles, booking URL)
  - [ ] Prospects tab in operator view (new, per ADR-015/016/017):
        per-client tier breakdown (% and count in Tier 1, 2, 3), sourcing status,
        last sourcing run, next projected run based on inventory floor, TAM flag
  - [ ] TAM Tool operator page (new, per ADR-016)
  - [ ] Tier filter on signals log (new, per ADR-017)
  - [ ] Daily operator digest email (summary of agent runs, warnings, approvals)

### Integrations (phase one)
  - [ ] Instantly: sequences, webhook receipt, suppression push
  - [ ] Taplio: content delivery model (approved post notification to Doug — no API)
  - [ ] Lemlist: DM sequences, webhook receipt (verify API before building)
  - [x] Apollo: prospect enrichment (step 1 in research sequence — needs paid plan activated)
  - [ ] Apollo: TAM count queries via People API Search (new, no credit cost)
  - [ ] Apollo: handler built against ICPFilterSpec (new, ADR-015)
  - [ ] GoHighLevel: meeting outcome webhook
  - [x] Calendly: booking URL stored per client, used in positive reply emails
  - [ ] Resend: approval notifications, 90-day refresh email, escalation reminders

### Sending infrastructure (covered by runbook, not a build item)
  - [x] /docs/runbooks/sending-setup.md operator runbook created
  - [ ] Tier 3 pool provisioning decision per client at onboarding
  - [ ] Deliverability Monitor agent (deterministic daily job, reads Instantly
        metrics, writes warnings for bounce/spam/reply-rate anomalies)

### Agents (phase one)
  - [ ] Prospect research agent (Trigger-Bridge-Value, 3-step sequence, no scraping)
        — partially built, tier-aware routing still needed
  - [ ] Reply handling agent (positive, information request, negative/opt-out, OOO)
  - [ ] Signal processing agent (logging and classification only — no threshold evaluation)
  - [ ] Pattern aggregation agent (built but runs infrequently — patterns will be sparse)

### Approval system
  - [~] cold_email: sequence-level approval, batch sample, 3-day auto-approve (auto-approve portion only — item stays [~] to reflect that manual approval works but auto-approve has no scheduler)
  - [~] linkedin_post: toggle, 24-hour auto-approve, content delivery notification to Doug
  - [~] linkedin_dm: sequence-level approval, 3-day auto-approve
  - [ ] Notification emails via Resend (T+0, T+15h, T+48h, T-12h for 3-day; T+0 for 24h)
  - [ ] Doug notified for all rejections and auto-approvals

### Warnings engine
  - [ ] Reply rate (green/amber/red thresholds)
  - [ ] Bounce rate (green/amber/red, auto-pause above 3%)
  - [ ] Spam complaint rate
  - [ ] Open rate (directional flag)
  - [ ] Meeting quality (consecutive unqualified, no-show rate)
  - [ ] Per-tier meeting quality (new, per ADR-017)
  - [ ] Document staleness operator flag (60 days)
  - [ ] 90-day client refresh email (Resend)

### Pre-client-zero gates (must resolve before MargenticOS runs live campaigns)
  - [ ] Haiku critic pass on document suggestions (quality gate before approval queue)
  - [ ] Lean Marketing conflict of interest — commercial decision recorded
  - [ ] ICP filter spec validated against MargenticOS's own ICP (client zero dogfood)
  - [ ] TAM report green/amber/red validated against MargenticOS's own TAM
  - [ ] Sending infrastructure provisioned for MargenticOS (2+ domains, 6 mailboxes, warming complete)

### Phase one complete when
  MargenticOS has run as client zero with:
    - Intake completed
    - Four strategy documents generated AND ICP filter spec produced and approved
    - TAM report run and classified green/amber/red (must not be red)
    - Sourcing pipeline run end-to-end (inventory triggered, prospects sourced,
      tier-classified, written to DB, routed through tier-appropriate enrichment)
    - At least one live campaign running (cold email or LinkedIn) with prospects
      from the sourcing pipeline (not manual CSV import)
    - At least one webhook event processed
    - Dashboard showing real data including per-tier metrics and inventory status

  NOT complete until client zero has run live campaigns using the sourcing pipeline.
  Synthetic data is not sufficient. Manual CSV imports are not sufficient.

---

## Phase two — Intelligence

Goal: Signal processing, A/B testing, pattern library, and advanced outbound.
Begins after MargenticOS client zero is validated and at least one paying client is active.

### Signal threshold processing (deferred from phase one per ADR-011)
  - [ ] 3-signal threshold evaluation → low-confidence suggestion generation
  - [ ] 5-signal threshold evaluation → A/B test variant generation
  - [ ] 10-signal + winner → high-confidence suggestion generation
  - [ ] Conflict resolution UI (competing suggestions for same document field)

### A/B testing framework (deferred from phase one per ADR-011)
  - [ ] OVAT test tracking (subject line → opening line → CTA → sequence length)
  - [ ] Variant performance tracking (200 prospects minimum per variant)
  - [ ] Winner evaluation (15–30% relative lift, 5–7 business day minimum)
  - [ ] Pattern library begins aggregating meaningful cross-client insights

### Feedback loop agents
  - [ ] Suggestion generation agent (populates document_suggestions with confidence scoring)
  - [ ] Pattern aggregation agent running on schedule (not just manually)

### Sourcing pipeline — Phase 2 extensions
  - [ ] Instantly B2B Lead Finder handler built (activated when Apollo credit ceiling hit)
  - [ ] Signal-based ICPFilterSpec fields added (intent data, hiring signals, recent tech changes)
  - [ ] Clay handler evaluation (if sourcing scale demands it)

### LinkedIn DM (if Lemlist API verified)
  - [ ] Full LinkedIn DM sequence pipeline

### Email validation
  - [ ] Hunter.io integration activated (can_validate_email)

### Operator tooling
  - [ ] More sophisticated agent activity monitoring
  - [ ] Cross-client signal analytics
  - [ ] Daily operator digest email refinement based on real usage

---

## Phase three — Scale

Goal: More automation, more sophisticated reply handling, nurture sequences.

  - [ ] AI reply handling for information requests (with human override)
  - [ ] Nurture sequence automation for warm leads
  - [ ] Multi-campaign coordination per client
  - [ ] More sophisticated pattern library with confidence scoring
  - [ ] Document refresh suggestions driven by signal patterns
  - [ ] Expanded onboarding — more client types, more verticals
  - [ ] Sourcing infrastructure: evaluate Cognism or ZoomInfo or custom data
        pipeline as primary sourcing when client count and credit economics justify

---

## Phase four — Autonomy

Goal: Auto-approve for trusted clients, near-autonomous document updates.

  - [ ] Auto-approve logic: add confidence_threshold field + one condition to queue processor
        (This is additive — no architectural change. Same queue, same table, one new field.)
  - [ ] High-confidence document updates with reduced human review
  - [ ] Referral tools
  - [ ] SEO components
  - [ ] Expanded capability registry (new tools as they emerge)

---

## What is never built

Regardless of phase:
  - Email sending infrastructure (Instantly)
  - LinkedIn scheduling engine (Taplio handles content delivery after dashboard approval)
  - LinkedIn DM tooling (Lemlist)
  - CRM (GoHighLevel)
  - Prospect database (Apollo primarily, with swappable alternatives)
  - Booking system (Calendly or client's existing tool)
  - Email signatures (configured in Instantly per client)
  - LinkedIn scraping (see ADR-005)
