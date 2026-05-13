# ADR Spot-Check — 2026-05-13

Read-only verification pass. No code changes. Purpose: confirm which ADRs Prompt 3
depends on are correctly implemented, which have documented drift, and which have
undocumented drift that Prompt 3 must account for.

Six ADRs checked: 001, 003, 005, 019, 021, 023.

---

## ADR-001 — Tool-agnostic capability registry

### Claims

1. `integrations_registry` table maps capabilities (e.g. `can_send_email`) to tools, with `api_handler_ref` pointing to the handler file.
2. Handlers are the only code that may reference tool names. No agent or component outside `src/lib/integrations/` may reference a tool name directly.
3. Swapping a tool requires only: update registry row + write new handler.

### Verification

**Claim 1 — Registry table exists and is populated:**
Confirmed. `supabase/migrations/20260420_seed_integrations_registry.sql` seeds 7 rows:
`can_send_email/instantly`, `can_schedule_linkedin_post/taplio`, `can_send_linkedin_dm/lemlist`,
`can_enrich_contact/apollo`, `can_book_meeting/calendly`, `can_track_meeting/gohighlevel`,
`can_validate_email/hunter(inactive)`.

**api_handler_ref path drift:** The `api_handler_ref` column values point to
`src/lib/handlers/instantly/...` but the actual handler files live at
`src/lib/integrations/handlers/instantly/...`. The registry table references non-existent
paths. This does not currently break anything (the refs are not resolved at runtime) but
will matter when/if any code uses the registry to dynamically load handlers.

**Claim 2 — Tool names only in handler layer:**
DRIFT (known, documented). `src/lib/reply-handling/process-reply.ts` has four explicit
ADR-001 violations, each annotated with a BACKLOG deferral tag:

- `C3-1` (line 107): `resolveInstantlyLeadId()` calls `https://api.instantly.ai/api/v2/leads/list`
  directly inside the processor — not via a handler.
- `C3-2` (line 31–35): `suppressLead` and `sendThreadReply` imported directly from
  `@/lib/integrations/handlers/instantly/reply-actions` — handler imported by vendor name
  rather than via capability dispatch.
- `C3-3` (line 251): `instantlyApiKey` passed as a named primitive — belongs in handler
  via `getCredential(capability)`.
- `C3-4` (lines 322, 368): `body.text` and `eaccount` are Instantly V2–specific field names
  used directly in the processor — need source-aware extractors keyed by `signal.source`.

Additional minor drift:
- `src/components/dashboard/operator/SettingsView.tsx` (lines 31–35): hardcoded tool names
  `Instantly`, `Taplio`, `Lemlist`, `Apollo`, `Calendly` in mock UI display data. Display-only;
  no handler routing involved. Low severity, but ADR-001 applies to all code.
- `src/agents/messaging-generation-agent.ts` (lines 1137, 1145): references Instantly-specific
  merge tag constraint (`{{first_name}}` is the only tag Instantly supports) inside the agent
  prompt code. This is a tool-specific assumption baked into an agent — ADR-001 violation.

**Claim 3 — Swap = registry + handler only:**
Not yet achievable. The `resolveInstantlyLeadId()` function in `process-reply.ts` and the
direct `suppressLead`/`sendThreadReply` imports mean swapping the email tool would also
require edits to `process-reply.ts`. Achievable once C3-1 through C3-4 are resolved.

### Drift Summary

| Finding | Type | Risk |
|---|---|---|
| `api_handler_ref` paths wrong in seed SQL | Undocumented drift | Low (not runtime-resolved yet) |
| 4 violations in `process-reply.ts` (C3-1 to C3-4) | Known, BACKLOG-tagged | Medium — Prompt 3 must not add more violations |
| `SettingsView.tsx` hardcoded tool names (display) | Minor undocumented drift | Low |
| `messaging-generation-agent.ts` Instantly merge tag | Undocumented drift | Low (functional, but fragile on tool swap) |

---

## ADR-003 — Three-level agent isolation

### Claims

1. **DB level:** RLS enabled on every table. No table exists without a policy.
2. **App level:** Explicit `client_id`/`organisation_id` filter on every Supabase query.
3. **Prompt level:** No agent prompt references data outside the current client context.
4. **Patterns table:** Written ONLY by a dedicated pattern aggregation agent. No other
   agent or application code writes to it directly.

### Verification

**Claim 1 — RLS on every migration-defined table:**
Every table created in `supabase/migrations/` has a corresponding `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`:
`agent_runs`, `intake_files`, `prospect_research_results`, `integration_credentials`,
`polling_cursors`, `reply_handling_actions`, `faqs`, `reply_drafts`, `faq_extractions`,
`users_pending_review` — all have RLS enabled in the same migration that creates them. ✓

**Gap:** The core tables (`organisations`, `users`, `prospects`, `campaigns`, `signals`,
`intake_responses`, `strategy_documents`, `document_suggestions`, `patterns`) have no
migration file in `supabase/migrations/`. They were created before the migrations folder
was established. Their RLS status cannot be confirmed from code alone — requires a live
DB inspection via MCP or Supabase dashboard.

**Claim 2 — Explicit `organisation_id`/`client_id` on every agent query:**
Verified across active agents:
- `prospect-research-agent-v2.ts`: `.eq('organisation_id', client_id)` on prospect fetch (line 163), on research results store (line 138), on personalisation_trigger update (line 340). ✓
- `reply-draft-agent.ts`: `.eq('organisation_id', organisationId)` (line 122). ✓
- `faq-extraction-agent.ts`: `.eq('client_id', organisationId)` (line 105), cross-reference guard on faq/extraction rows (lines 314–342). ✓
- `icp-generation-agent.ts`, `positioning-generation-agent.ts`, `tov-generation-agent.ts`: all use `organisation_id` filters confirmed in earlier session reads.

**Claim 3 — Prompt-level isolation:**
Cannot be mechanically verified without reading all LLM prompt strings. The agent files pass
`client_id` as an explicit parameter and all source queries are filtered — the data that
reaches the prompt is isolated. No cross-client prompt contamination was found in the files
inspected, but this requires human review of each prompt template.

**Claim 4 — Patterns table written only by dedicated aggregation agent:**
DRIFT (unimplemented). No patterns aggregation agent exists anywhere in `src/agents/` or
`src/lib/agents/`. The patterns table is read by `icp-generation-agent.ts` (line 295),
`positioning-generation-agent.ts` (line 295), and `tov-generation-agent.ts` (line 291) —
all correctly read-only (`SELECT` only, no `INSERT`/`UPDATE`). But the write side (the
dedicated aggregation agent) was never built. The table exists in `database.ts` and is
in-scope per the TypeScript types, but is never written to in application code.
This is consistent with ADR-011's deferral of signal threshold processing to Phase 2.

### Drift Summary

| Finding | Type | Risk |
|---|---|---|
| Core table RLS status unverifiable from migrations | Structural gap | High — must verify via live DB before Prompt 3 adds data paths |
| Patterns aggregation agent does not exist | Undocumented drift (by design — ADR-011 defers this) | Low for Prompt 3 |

---

## ADR-005 — Research fallback chain

### Claims

1. Four sources in sequential fallthrough order: Apollo (primary) → targeted web search
   (secondary) → direct company website fetch (tertiary) → role-based pain proxy (last resort).
2. Apollo 401 (no key) and 403 (free tier blocked) must be treated as documented failure
   modes — not unhandled errors.
3. When all sources fail, `personalisation_trigger` remains null; compose-sequence.ts
   uses the role-based pain proxy as the last resort.

### Verification

**Claim 1 — Sequential fallthrough order:**
DRIFT. The active agent (`prospect-research-agent-v2.ts`) runs all four sources in
**parallel** via `Promise.all()` (confirmed in prior session; source files
`src/lib/agents/research/sources/apollo.ts`, `website-source.ts`, `web-search.ts`,
`pain-proxy.ts` are all invoked simultaneously). The old v1 agent
(`prospect-research-agent.ts`) was sequential as the ADR specifies, but v2 replaced it
with parallel execution.

The outcome is architecturally equivalent: all sources produce results, the synthesis step
selects the best, and `personalisation_trigger` is null when none succeed. The sequential
model the ADR describes is not how the code works.

**Claim 2 — Apollo 401/403 as documented failure modes:**
PARTIAL. `src/lib/agents/research/sources/apollo.ts` line 63: 429 → `available: false`.
Lines 66–68: any other non-2xx → `available: false, error: 'Apollo API error: ${status}'`.
A 401 or 403 returns `available: false` which causes fallthrough — functionally correct.
However, the error string does not distinguish 401 (no key configured) from 403 (free
tier blocked) from 5xx (network error). ADR-023 identifies this as "requires implementation
discovery" and flags it as a Prompt 3A sub-task.

**Claim 3 — Pain proxy fallback when trigger is null:**
Confirmed. `src/lib/agents/icp-filter-spec.ts` confirms pain proxy is used as fallback.
`compose-sequence.ts` branches on `has_dateable_signal + signal_relevance` for personalised
trigger, falling back to role-based copy when absent. ✓

### Drift Summary

| Finding | Type | Risk |
|---|---|---|
| v2 runs all sources in parallel, not sequential fallthrough | Undocumented drift | Low (outcome equivalent; ADR-023 acknowledges "discovery required") |
| Apollo 401/403/5xx not distinguished in error handling | Undocumented drift | Medium — Prompt 3 must add this distinction |

---

## ADR-019 — FAQ compounding loop

### Claims

1. Three-tier routing model: `tier_1_handled` (already actioned), `tier_2` (AI-drafted,
   operator approves), `tier_3` (AI starting point, operator rewrites). Implemented in a
   routing table function.
2. FAQ matching is deterministic (no LLM), using similarity scoring.
3. When `information_request_generic` scores ≥ 0.65 against approved FAQs, routes to Tier 2.
   Below 0.65 routes to Tier 3.
4. FAQ extraction triggers on sent Tier 3 reply bodies.
5. Three tables: `faqs`, `faq_extractions`, `reply_drafts`.
6. Signal threshold logic (3/5/10 tiers) and A/B variant generation: schema-only in Phase 1.

### Verification

**Claim 1 — Routing table function:**
Confirmed. `src/lib/reply-handling/route-intent.ts` implements exactly the ADR tier model.
`KNOWN_INTENTS` set defines all 8 intent types. Switch statement maps each to a routing
decision. Unknown intents → `log_only` with a warning. ✓

**Claim 2 — Deterministic FAQ matching:**
Confirmed. `src/lib/faq/matcher.ts` implements Jaccard similarity (|intersection|/|union|
on normalised question tokens). No LLM call. Scores approved FAQs and optionally pending
`faq_extractions`. Returns scored array sorted descending. ✓ (Per ADR-018.)

**Claim 3 — 0.65 threshold for Tier 2 routing:**
Confirmed. `route-intent.ts` line 23: `FAQ_TIER2_THRESHOLD = 0.65`. Matches
`FAQ_USE_THRESHOLD = 0.65` in `reply-draft-agent.ts` line 24. Both files explicitly
cross-reference each other with a "must match — do not change independently" comment. ✓

**Claim 4 — FAQ extraction triggers on sent Tier 3:**
Confirmed. `src/lib/reply-handling/send-approved-draft.ts` line 291: calls `extractFaq()`
after a successful send (line 305 writes to `faq_extractions`). The extraction agent
(`src/lib/agents/faq-extraction-agent.ts` line 2) explicitly states: "Extracts FAQ
candidates from sent Tier 3 reply bodies." ✓

**Claim 5 — Three tables exist:**
All three confirmed in `supabase/migrations/20260501_reply_handling_phase2.sql`. ✓

**Claim 6 — Signal threshold logic schema-only:**
Confirmed consistent with ADR-011 deferral. The `reply_drafts` table schema includes
`faq_match_count` and related fields but no threshold-processing or A/B generation
logic is implemented in application code. ✓

### Drift Summary

No drift found. All ADR-019 claims verified as implemented. This ADR is fully live.

---

## ADR-021 — Operator cross-org scope

### Claims

1. Operator endpoints: auth check selects only `role` from `users` table. No
   `organisation_id` filter on the query. Operator can act across all organisations.
2. Client endpoints: always filter by `organisation_id`. A client can only read their
   own organisation's data.

### Verification

**Claim 1 — Operator endpoints select only `role`, no org filter:**

`GET /api/reply-drafts/route.ts` (operator endpoint):
- Line 67: `.select('role')` — role only. ✓
- Line 81: explicit comment "ADR-021: operator endpoints are cross-org — no organisation_id filter here." ✓

`GET /api/operator/faqs/route.ts` (operator endpoint):
- Line 42: `.select('role')` — role only. ✓
- Line 4: comment "Operator-only. ADR-021: operator endpoints are cross-org." ✓

**Minor inconsistency (comment only, not a code bug):** The header comment block of
`/api/reply-drafts/route.ts` (lines 8–9) says "User role is 'operator'" and "All rows
are scoped to the operator's own organisation_id (ADR-003)." The second line is incorrect
as a description — the code is intentionally cross-org per ADR-021. The *implementation*
is correct; the header comment is stale/misleading.

**Claim 2 — Client endpoints filter by `organisation_id`:**
Confirmed across agent routes. Every Supabase query in agent code includes an explicit
`organisation_id` or `client_id` filter. `src/app/api/intake/complete/route.ts` resolves
`organisation_id` from the authenticated user's `users` row on every request, then uses
it to gate all operations. ✓

### Drift Summary

| Finding | Type | Risk |
|---|---|---|
| `/api/reply-drafts` header comment says "scoped to own org_id" but code is correctly cross-org | Stale comment | None (code is correct) |

---

## ADR-023 — Onboarding automation (Prompt 2 shipped items)

### Claims

ADR-023 declares these items shipped in Prompt 2:

1. Operator UI: Create-organisation form
2. Intake-completion handoff route (`/api/intake/complete`) — auto-triggers four agents in parallel
3. Four Resend templates: `intake-complete`, `all-docs-generated`, `multi-user-signup-attempt`, `client-welcome`
4. `users_pending_review` migration + trigger (`handle_new_user()` on `auth.users AFTER INSERT`)
5. Sentry flush fix in `src/lib/email/send.ts`
6. `agents_dispatched_at` and `docs_complete_notification_sent_at` columns on `organisations`

### Verification

**Item 1 — Create-org form:**
Confirmed. `src/app/dashboard/operator/clients/new/actions.ts` — `createOrganisation()` server
action exists. Writes `organisations` row, fires `supabase.auth.admin.inviteUserByEmail()`,
sends client-welcome email, compensating deletes on failure. ✓

**Item 2 — `POST /api/intake/complete`:**
Confirmed. `src/app/api/intake/complete/route.ts` — atomic dispatch guard on
`agents_dispatched_at IS NULL`, 80% threshold defense-in-depth check, `after()` dispatches
all four agents in parallel with 8s timeout, operator notification via Resend. ✓

**Item 3 — Four Resend templates:**
Confirmed. All four files exist in `src/lib/email/templates/`:
`intake-complete.ts`, `all-docs-generated.ts`, `multi-user-signup-attempt.ts`, `client-welcome.ts`. ✓

**Item 4 — `users_pending_review` migration + trigger:**
Confirmed. `supabase/migrations/20260512221142_users_pending_review.sql` — creates table,
`users_one_client_per_org` partial unique index, `handle_new_user()` trigger function on
`auth.users AFTER INSERT`. FK cascade added in follow-up
`20260512230916_users_pending_review_fk_cascade.sql`. ✓

**Item 5 — Sentry flush fix:**
Confirmed. `src/lib/email/send.ts` line 55: `try { await Sentry.flush(2000) } catch {}` ✓

The fix is in `send.ts` as the ADR specifies. The agent routes (`/api/agents/icp`, etc.)
do not have their own `Sentry.flush()` calls, but they call `sendTransactionalEmail()` only
at the end of the `notifyIfAllDocsComplete()` function which routes through `send.ts` —
so the flush is covered transitively.

**Item 6 — Column additions:**
Confirmed. `supabase/migrations/20260512220938_org_dispatch_columns.sql` adds both
`agents_dispatched_at timestamptz` and `docs_complete_notification_sent_at timestamptz`
to `organisations`. ✓

### Prompt 3 items — current status

ADR-023 Prompt 3 scope items are NOT yet implemented (as expected — this is the pending build):

| Item | Status |
|---|---|
| Register Instantly campaign UI (validate + write `campaigns` row) | Not built |
| Setup status panel UI (`setup_status` column exists; UI pending) | Column exists; UI not built |
| Instantly lead upload (`outreach.upload_leads` capability) | Not built; `prospects` table missing `instantly_lead_id` and `upload_status` |
| Instantly DFY mailbox ordering (`outreach.order_mailboxes`) | Not built |
| Apollo graceful degradation (401/403/5xx distinction) | Partially implemented — non-2xx → `available: false`, but errors undistinguished |

### Drift Summary

All Prompt 2 items confirmed shipped. No undocumented drift in ADR-023 Prompt 2 scope.
Prompt 3 scope correctly reflects unbuilt state.

---

## Overall Findings

### What is solid

- **ADR-019** (FAQ compounding): fully implemented, no drift.
- **ADR-021** (operator scope): correctly implemented, minor stale comment.
- **ADR-023 Prompt 2**: all six items confirmed shipped.
- **ADR-003 app-level isolation**: all agent queries verified filtered.
- **ADR-003 RLS on migration-defined tables**: 100% compliance for all tables in `supabase/migrations/`.

### What Prompt 3 must account for

1. **Core table RLS gap (ADR-003):** The tables created before the migrations folder
   (`organisations`, `users`, `prospects`, `campaigns`, `signals`, etc.) have no RLS
   migration to inspect. Before Prompt 3 adds data paths that touch these tables, their
   RLS status should be confirmed via MCP `list_tables` or Supabase dashboard. If any
   core table lacks RLS, that is a P0 blocker before any Prompt 3 data work.

2. **ADR-001 violations in `process-reply.ts` (C3-1 to C3-4):** These are explicitly
   BACKLOG-deferred and must not be replicated in Prompt 3. Any new Instantly API surface
   built in Prompt 3 (lead upload, DFY mailbox) must go through a proper handler rather
   than repeating the inline-API pattern.

3. **ADR-001: `api_handler_ref` paths wrong in seed SQL:** The registry table's
   `api_handler_ref` column points to `src/lib/handlers/` which does not exist. If Prompt 3
   adds new capabilities to the registry, it must use the correct path
   `src/lib/integrations/handlers/`.

4. **ADR-005 Apollo distinction gap:** Prompt 3's Apollo graceful degradation sub-task
   (ADR-023 Prompt 3 item 5) requires distinguishing 401 (unconfigured) from 403 (tier
   blocked) from 5xx (network error). The current code collapses all non-2xx to
   `available: false`. This is the sub-task referenced in ADR-023.

5. **ADR-001: `messaging-generation-agent.ts` Instantly merge tag:** Minor but should be
   noted in BACKLOG. The agent encodes Instantly-specific merge tag constraints — a future
   tool swap would need this updated.

6. **Patterns aggregation agent (ADR-003):** No write path to `patterns` table exists.
   If the patterns table is expected to have data before c0, a write path is needed.
   Consistent with ADR-011 deferral — no action for Prompt 3.

### Recommendations before Prompt 3A begins

| Priority | Action |
|---|---|
| P0 | Verify RLS on core tables via Supabase MCP `list_tables` or dashboard before Prompt 3 writes to any of them |
| P1 | Any new Instantly API surface in Prompt 3 must use a handler, not inline fetch (no C3 pattern repetition) |
| P1 | New registry rows must use `src/lib/integrations/handlers/` paths |
| P2 | Apollo 401/403/5xx distinction — implement as part of Apollo graceful degradation sub-task |
| Backlog | Fix `messaging-generation-agent.ts` Instantly merge tag reference |
| Backlog | Fix stale header comment in `/api/reply-drafts/route.ts` |
