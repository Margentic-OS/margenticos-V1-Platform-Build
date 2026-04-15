# sections/14-phasing.md — Phase One Through Four with Deliverables
# MargenticOS PRD | April 2026
# Read prd/PRD.md first, then this section for build sequencing and scope decisions.
# Phases are a guide, not a contract. Priorities shift as the build progresses.
# When scope changes, update this file and note the change date.

---

## Phase one — Foundation

Goal: A working system that can run MargenticOS as client zero and onboard 3 founding clients.

### Infrastructure
  - [ ] Next.js project initialised, TypeScript configured, Tailwind configured
  - [ ] Git repository set up with three-environment branching (dev / staging / prod)
  - [ ] Vercel deployment configured for all three environments
  - [ ] Sentry error monitoring connected
  - [ ] Supabase project created, local dev environment connected
  - [ ] Supabase MCP installed and configured

### Database
  - [ ] All tables created with RLS policies verified before any application code
  - [ ] Tables: organisations, users, strategy_documents, document_suggestions,
               intake_responses, signals, patterns, integrations_registry,
               campaigns, prospects, meetings
  - [ ] document_suggestions includes all fields:
               signal_count, confidence_level, ab_variant, conflicting_suggestion_id
               (schema only — processing logic deferred to phase two, per ADR-011)
  - [ ] integrations_registry populated with all phase one tools
  - [ ] Hunter.io registered with is_active = false (capability reserved, not built)

### Authentication
  - [ ] Supabase Auth with magic link
  - [ ] Operator and client roles
  - [ ] Three-check auth on every API route
  - [ ] Operator route protection

### Intake
  - [ ] Questionnaire UI with all five sections
  - [ ] 80% completeness threshold enforcement (critical fields)
  - [ ] Follow-up prompts for under-answered critical fields (<20 words)
  - [ ] File upload (Supabase Storage)
  - [ ] Website URL ingestion (homepage + 3 inner pages)

### Document generation agents
  - [ ] ICP generation agent (claude-opus-4-5)
  - [ ] Positioning generation agent (claude-opus-4-5)
  - [ ] TOV generation agent (claude-opus-4-5)
  - [ ] Messaging playbook agent (claude-opus-4-5)
  - [ ] All agents isolated by client_id
  - [ ] Documents written to strategy_documents with versioning

### Dashboard — client view
  - [ ] Empty state view (months 1–2) — first-class view, not a fallback
  - [ ] Strategy document view (read-only)
  - [ ] Pipeline view (post-unlock)
  - [ ] Approval view
  - [ ] Phased unlock logic (2 months OR 5 meetings)

### Dashboard — operator view
  - [ ] Operator sidebar with amber badge and client selector
  - [ ] All clients overview
  - [ ] Warnings rail
  - [ ] Agent activity log
  - [ ] Per-client settings (thresholds, toggles, booking URL)

### Integrations (phase one)
  - [ ] Instantly: sequences, webhook receipt, suppression push
  - [ ] Taplio: content delivery model (approved post notification to Doug — no API)
  - [ ] Lemlist: DM sequences, webhook receipt (verify API before building)
  - [ ] Apollo: prospect enrichment (step 1 in research sequence)
  - [ ] GoHighLevel: meeting outcome webhook
  - [ ] Calendly: booking URL stored per client, used in positive reply emails
  - [ ] Resend: approval notifications, 90-day refresh email, escalation reminders

### Agents (phase one)
  - [ ] Prospect research agent (Trigger-Bridge-Value, 3-step sequence, no scraping)
  - [ ] Reply handling agent (positive, information request, negative/opt-out, OOO)
  - [ ] Signal processing agent (logging and classification only — no threshold evaluation)
  - [ ] Pattern aggregation agent (built but runs infrequently — patterns will be sparse)

### Approval system
  - [ ] cold_email: sequence-level approval, batch sample, 3-day auto-approve
  - [ ] linkedin_post: toggle, 24-hour auto-approve, content delivery notification to Doug
  - [ ] linkedin_dm: sequence-level approval, 3-day auto-approve
  - [ ] Notification emails via Resend (T+0, T+15h, T+48h, T-12h for 3-day; T+0 for 24h)
  - [ ] Doug notified for all rejections and auto-approvals

### Warnings engine
  - [ ] Reply rate (green/amber/red thresholds)
  - [ ] Bounce rate (green/amber/red, auto-pause above 3%)
  - [ ] Spam complaint rate
  - [ ] Open rate (directional flag)
  - [ ] Meeting quality (consecutive unqualified, no-show rate)
  - [ ] Document staleness operator flag (60 days)
  - [ ] 90-day client refresh email (Resend)

### Phase one complete when
  MargenticOS has run as client zero with:
    - Intake completed
    - Four strategy documents generated
    - At least one live campaign running (cold email or LinkedIn)
    - At least one webhook event processed
    - Dashboard showing real data

  NOT complete until client zero has run live campaigns. Synthetic data is not sufficient.

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

### LinkedIn DM (if Lemlist API verified)
  - [ ] Full LinkedIn DM sequence pipeline

### Email validation
  - [ ] Hunter.io integration activated (can_validate_email)

### Operator tooling
  - [ ] More sophisticated agent activity monitoring
  - [ ] Cross-client signal analytics

---

## Phase three — Scale

Goal: More automation, more sophisticated reply handling, nurture sequences.

  - [ ] AI reply handling for information requests (with human override)
  - [ ] Nurture sequence automation for warm leads
  - [ ] Multi-campaign coordination per client
  - [ ] More sophisticated pattern library with confidence scoring
  - [ ] Document refresh suggestions driven by signal patterns
  - [ ] Expanded onboarding — more client types, more verticals

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
  - Prospect database (Apollo)
  - Booking system (Calendly or client's existing tool)
  - Email signatures (configured in Instantly per client)
