# Discovery: Prompt 3 Pre-Scoping
**Date:** 2026-05-13
**Status:** Read-only. No code written. No proposals made.
**Prompt context:** Prompt 2 (onboarding automation foundation) shipped May 13 2026.
**Purpose:** Establish ground truth before scoping the Prompt 3 build.

---

## Q1 — Integrations Registry Current State

**Direct answer:** The registry has 7 rows, seeded in a single migration. No `outreach.upload_leads` or `outreach.order_mailboxes` slots exist. The existing naming convention uses `can_<verb>_<noun>` (e.g. `can_send_email`), which conflicts with the dotted-namespace style (`outreach.upload_leads`) specified in ADR-023. There is no runtime dispatcher — handlers are imported directly by application code.

**Detail:**

Seed migration: [supabase/migrations/20260420_seed_integrations_registry.sql](../../supabase/migrations/20260420_seed_integrations_registry.sql)

Current rows (lines 11–19):
```
can_send_email             → instantly   (active, api_handler_ref: src/lib/handlers/instantly)
can_schedule_linkedin_post → taplio      (active)
can_send_linkedin_dm       → lemlist     (active)
can_enrich_contact         → apollo      (active)
can_book_meeting           → calendly   (active)
can_track_meeting          → gohighlevel (active)
can_validate_email         → hunter      (inactive)
```

No capability slots named `outreach.*` or anything similar exist.

**Established pattern for adding a new capability slot:** A single `INSERT INTO integrations_registry` in a migration file. There is no code-side factory or dispatcher. The `api_handler_ref` column stores a path string but nothing reads it at runtime — applications import handlers directly (e.g. `process-reply.ts` imports `suppressLead` and `sendThreadReply` directly from `src/lib/integrations/handlers/instantly/reply-actions.ts`). The registry functions as a configuration record, not a runtime dispatch layer.

**Most recently added capability slot:** `can_track_meeting` for gohighlevel, in the same seed migration (2026-04-20). No new capability has been added since seeding.

**Inconsistency:** ADR-023 specifies slot names as `outreach.upload_leads` and `outreach.order_mailboxes` (dotted namespace). The existing convention is `can_send_email` style. Prompt 3 needs a decision: adopt the dotted namespace as a new convention, or use `can_upload_leads` / `can_order_mailboxes` to match the existing pattern. Neither style is runtime-enforced — it is cosmetic — but whichever is chosen must be consistent.

**Inconsistency:** `api_handler_ref` in the seed points to `src/lib/handlers/instantly` but the actual handler files live at `src/lib/integrations/handlers/instantly/`. The path is wrong for all existing rows and is unused at runtime.

---

## Q2 — Instantly Integration Current State

**Direct answer:** Instantly code lives in four files under `src/lib/integrations/`. There is no single client wrapper class — the pattern is module-level functions, each importing `INSTANTLY_API_BASE` from a shared constants file. The API key comes from `integration_credentials` table (global, `organisation_id = NULL`). No retry logic exists; 429 detection exists but is not acted on. The two new endpoints (POST `/api/v2/leads/add` and POST `/api/v2/dfy-email-account-orders`) most naturally belong as new files in `src/lib/integrations/handlers/instantly/`.

**File list:**

- [src/lib/integrations/handlers/instantly/constants.ts](../../src/lib/integrations/handlers/instantly/constants.ts) — `INSTANTLY_API_BASE` constant only (line 5)
- [src/lib/integrations/handlers/instantly/reply-actions.ts](../../src/lib/integrations/handlers/instantly/reply-actions.ts) — `suppressLead()`, `sendThreadReply()`
- [src/lib/integrations/handlers/instantly/campaign-analytics.ts](../../src/lib/integrations/handlers/instantly/campaign-analytics.ts) — `fetchCampaignStats()`
- [src/lib/integrations/polling/instantly.ts](../../src/lib/integrations/polling/instantly.ts) — `pollInstantlyReplies()`, `pollInstantlyLeadStatus()`

**Endpoints currently called:**
- `GET /api/v2/emails` — reply polling, cursor-based ([polling/instantly.ts:394](../../src/lib/integrations/polling/instantly.ts))
- `GET /api/v2/emails/{uuid}` — outbound body fetch ([polling/instantly.ts:192](../../src/lib/integrations/polling/instantly.ts))
- `PATCH /api/v2/leads/{uuid}` — suppress lead ([reply-actions.ts:35](../../src/lib/integrations/handlers/instantly/reply-actions.ts))
- `POST /api/v2/emails/reply` — send reply thread ([reply-actions.ts:81](../../src/lib/integrations/handlers/instantly/reply-actions.ts))
- `GET /api/v2/campaigns/analytics` — campaign stats ([campaign-analytics.ts:41](../../src/lib/integrations/handlers/instantly/campaign-analytics.ts))
- `POST /api/v2/leads/list` — bounce/unsubscribe scan ([polling/instantly.ts:549](../../src/lib/integrations/polling/instantly.ts))

`GET /api/v2/campaigns/{id}` (needed for Prompt 3 campaign validation) is **not currently called anywhere**.

**No single client wrapper.** The pattern is function-per-operation. Each function constructs its own `fetch()` call using `INSTANTLY_API_BASE` from constants.ts. Adding new endpoints means adding new functions, not extending a class.

**API key resolution:** Resolved from `integration_credentials` table, `source='instantly'`, `organisation_id=NULL` (global account model). The polling cron route resolves it before calling poll functions. There is no per-org key resolution yet (that model is supported by the table schema but not implemented).

**Retry / rate-limit handling:** 429 sets `ActionResult.rateLimited: true` ([reply-actions.ts:57](../../src/lib/integrations/handlers/instantly/reply-actions.ts)) but no actual retry loop exists. Non-JSON error bodies are preserved as `{ _raw_text: string }` for debugging. No exponential backoff anywhere.

**Natural home for Prompt 3 handlers:** `src/lib/integrations/handlers/instantly/leads.ts` (for `POST /api/v2/leads/add`) and `src/lib/integrations/handlers/instantly/dfy.ts` (for `POST /api/v2/dfy-email-account-orders` and the domains/pre-warmed-up-list check). Both follow the existing function-per-operation pattern and import `INSTANTLY_API_BASE` from constants.ts.

---

## Q3 — Apollo Integration Current State

**Direct answer:** Apollo code is one file: `src/lib/agents/research/sources/apollo.ts`. When Apollo returns 403, the handler returns `{ available: false }` and the research agent continues without Apollo data — no crash, no propagation, no explicit ADR-005 fallthrough logging. The 401/403/5xx cases are not distinguished. The "formalised graceful degradation" in ADR-023 means making the fallthrough explicit and documented, not changing the fundamental flow (which already works).

**Files:**
- [src/lib/agents/research/sources/apollo.ts](../../src/lib/agents/research/sources/apollo.ts) — `fetchApolloSource()`

**When Apollo returns 403:** Lines 66–68 of apollo.ts:
```typescript
if (!response.ok) {
  return { available: false, formatted: null, raw: null, error: `Apollo API error: ${response.status}` }
}
```
All non-2xx, non-429 responses (including 401 and 403) return `available: false` with a generic error string. The research agent v2 runs all four sources with `Promise.all()` and proceeds with whatever is available. A 403 does NOT propagate — it is treated identically to a 401 or 5xx. The `buildSourceTracking()` function in v2 only distinguishes "not set" errors (skipped intentionally) from actual failures.

**Exact call location:** [src/lib/agents/research/sources/apollo.ts:53](../../src/lib/agents/research/sources/apollo.ts) — `fetch('https://api.apollo.io/api/v1/people/match', ...)`.

Called from: [src/lib/agents/prospect-research-agent-v2.ts](../../src/lib/agents/prospect-research-agent-v2.ts) via `fetchApolloSource(prospect)`.

**Current research agent flow (prospect_id → enriched profile):**
1. `prospect-research-agent-v2.ts` receives a `ResearchInput` (includes `prospect` context with first/last name, company, LinkedIn URL) — entry point is `runProspectResearchAgent()`.
2. Four sources run in parallel via `Promise.all()`: `fetchLinkedInSource()`, `fetchApolloSource()`, `fetchWebsiteSource()`, `fetchWebSearchSource()`.
3. `synthesizeResearch()` calls Haiku LLM ([research/synthesize.ts](../../src/lib/agents/research/synthesize.ts)) with all available source data → produces `icp_fit`, `trigger_text`, `has_dateable_signal`, `signal_relevance`, etc.
4. `storeResearchResult()` writes to `prospect_research_results` table (lines 67–100 of v2 file).
5. Updates `prospects` row: `personalisation_trigger`, `has_dateable_signal`, `signal_relevance`, `current_research_result_id`.

**Apollo 403 variant distinguishing:** Current handling treats all 403s identically — no code differentiates free-tier scope from invalid credentials from missing master key. ADR-023's "formalised" handling means adding explicit log branches per status code and explicit `logger.warn` calls that name the failure reason. The fallthrough behaviour is already correct; what's missing is the labelling.

**Inconsistency with ADR-005:** ADR-005 specifies the fallthrough chain as Apollo → targeted web search → direct website fetch → role-based pain proxy. The v2 agent runs all four in parallel, which means web search and website fetch always run regardless of whether Apollo succeeded. The "fallthrough" in ADR-005 language is already implemented as parallel execution — the compose-sequence.ts uses the pain proxy only when `personalisation_trigger` is null on the prospect (line 244–245 of compose-sequence.ts). This is architecturally equivalent but not sequentially gated as ADR-005's language implies.

---

## Q4 — Operator UI Current State and Pattern

**Direct answer:** There are 7 operator route groups under `/dashboard/operator/`. There is no `/dashboard/operator/clients/[id]` route. For Prompt 3, the setup_status panel and campaign registration UI need a home — the most natural fit is a new `/dashboard/operator/clients/[id]` detail page (does not exist yet). The operator layout is `src/app/dashboard/operator/layout.tsx`. The create-org server action is the canonical pattern for Prompt 3 operator actions.

**Existing operator routes:**
- `/dashboard/operator` — AllClientsView with org list, approval counts ([page.tsx](../../src/app/dashboard/operator/page.tsx))
- `/dashboard/operator/activity` — agent run log ([activity/page.tsx](../../src/app/dashboard/operator/activity/page.tsx))
- `/dashboard/operator/clients/new` — create org form ([clients/new/page.tsx](../../src/app/dashboard/operator/clients/new/page.tsx))
- `/dashboard/operator/faqs` — FAQ curation queue ([faqs/page.tsx](../../src/app/dashboard/operator/faqs/page.tsx))
- `/dashboard/operator/settings` — settings view ([settings/page.tsx](../../src/app/dashboard/operator/settings/page.tsx))
- `/dashboard/operator/signals` — signals log ([signals/page.tsx](../../src/app/dashboard/operator/signals/page.tsx))
- `/dashboard/operator/triage` — reply draft triage queue ([triage/page.tsx](../../src/app/dashboard/operator/triage/page.tsx))

**No `/dashboard/operator/clients/[id]` route exists.** The operator sees all clients as a flat list on the main operator page. To add setup_status panel and campaign registration, Prompt 3 would need to create this route. Alternatively, both could be surfaced as modal-or-drawer patterns within the `/dashboard/operator/clients/new` success state or a new `/dashboard/operator/clients` list page, but a `[id]` detail page is the cleanest architectural fit.

**Operator sidebar navigation** (OperatorSidebar.tsx lines 32–37): hardcoded links — All clients, Reply queue, FAQ curation, Agent activity, Signals log, Settings. Adding a client detail route requires no sidebar changes; it would be accessed from the AllClientsView client list.

**Operator layout** ([src/app/dashboard/operator/layout.tsx](../../src/app/dashboard/operator/layout.tsx)): server component, auth + role check (lines 13–24), fetches all organisations for sidebar (lines 26–31), renders `<OperatorSidebar clients={clients ?? []} />`. New operator routes automatically inherit this layout and auth check.

**Create-org server action shape** ([src/app/dashboard/operator/clients/new/actions.ts](../../src/app/dashboard/operator/clients/new/actions.ts)):
- Marked `'use server'` at top of file
- Returns `CreateOrgState`: `{ status: 'idle' | 'error' | 'success'; message?; orgId?; orgName? }`
- Auth check pattern (lines 62–77): `supabase.auth.getUser()` → `supabase.from('users').select('role').eq('id', user.id).single()` → `role !== 'operator'` → return error. **No organisation_id filter** (per ADR-021).
- Uses admin client (`SUPABASE_SERVICE_ROLE_KEY`) for writes that bypass RLS.
- No transaction — uses compensating deletes: org row deleted if generateLink fails (line 139), auth user + org deleted if email fails (lines 157–160).
- No redirect on success — success state returned to form, component handles display.
- This is the template Prompt 3 UIs should follow.

---

## Q5 — Campaigns Table Current State

**Direct answer:** The `campaigns` table has an `external_id` column (`string | null`). No migration file in `supabase/migrations/` creates this table (it predates the current migration set) but it is reflected in `src/types/database.ts`. No index on `external_id` is confirmed — none found in any migration file. Nothing inserts into campaigns anywhere in the codebase. Reads come from the polling layer and the campaign analytics cron.

**Schema** (from [src/types/database.ts:68–132](../../src/types/database.ts)):
```
id                      uuid (PK)
organisation_id         uuid (FK → organisations)
campaign_type           text (NOT NULL)
status                  text
sequence_name           text | null
external_id             text | null   ← the Instantly campaign UUID
sent_count              integer
replied_count           integer
bounced_count           integer
campaign_stats_updated_at timestamptz | null
started_at              timestamptz | null
paused_at               timestamptz | null
created_at              timestamptz
updated_at              timestamptz
```

**external_id column:** Confirmed present as nullable text. No index confirmed in any migration file. The polling code queries `.eq('external_id', instantlyCampaignId)` on every reply poll ([polling/instantly.ts:70](../../src/lib/integrations/polling/instantly.ts)) — without an index, this is a sequential scan. At current scale (one campaign) this is fine; at 10+ campaigns it becomes a concern.

**What writes to campaigns today:** Nothing. Zero `.insert` calls on the campaigns table exist anywhere in `src/`. Confirmed by grep.

**What reads from campaigns:**
- [polling/instantly.ts:68–84](../../src/lib/integrations/polling/instantly.ts) — `resolveCampaign()`: looks up by `external_id` to get `id` and `organisation_id` for signal writing.
- [polling/instantly.ts:504–516](../../src/lib/integrations/polling/instantly.ts) — `pollInstantlyLeadStatus()`: reads all campaigns with `external_id IS NOT NULL` for bounce/unsubscribe scan.
- Campaign analytics cron: reads campaign rows to update `sent_count`, `replied_count`, `bounced_count` via `fetchCampaignStats()`. The analytics handler reads from Instantly API, not from the campaigns table directly.

**Prompt 2 campaigns write path:** Prompt 2 added no campaigns write path. The 5 new migrations from 2026-05-12 are: org_contract_dates, org_dispatch_columns, users_pending_review, users_pending_review_fk_cascade, faq_rls_operator_policies. None touch the campaigns table.

---

## Q6 — Composed-Sequences Current State

**Direct answer:** There is no `composed_sequences` table. No persistent "composed sequence" record exists anywhere in the database. The `composeSequence()` function in `src/lib/composition/compose-sequence.ts` returns a `ComposedSequence` object in memory and writes nothing to the database (except updating `prospect.variant_id`). The pipeline currently terminates with the prospect's `personalisation_trigger` stored on the prospects table. **This is the critical architectural finding for Prompt 3.**

**Where the messaging agent's output lands:**
`strategy_documents` table, `document_type = 'messaging'`, `status = 'active'`. Content is a JSON array of variant objects, each containing an `emails` array (per ADR-012). This is the approved template, not a per-prospect composed sequence.

**"Ready to upload to Instantly" state:** Does not exist. No column, no table, no flag anywhere marks a prospect as "composed and ready for upload."

**Final DB state for a prospect that has gone through research → composition:**
- `prospect_research_results`: row with synthesis output, trigger_text, icp_fit, etc.
- `prospects.personalisation_trigger`: the synthesised trigger string (e.g. "Saw you just closed your Series A…").
- `prospects.has_dateable_signal`: boolean.
- `prospects.signal_relevance`: `use_as_hook` or `ignore`.
- `prospects.variant_id`: assigned at composition time (round-robin).
- `prospects.email`, `first_name`, `last_name`, `company_name`: sourced at list-build time.

The composition is **stateless** — `composeSequence()` reads from the above fields and from the approved messaging doc, composes the sequence in memory, and returns it. Nothing is persisted between composition and upload.

**Architectural question: does the current model match Instantly's leads/add model?**

**Partially, but with a gap.**

Instantly's `POST /api/v2/leads/add` accepts per-lead fields including:
- `email` (required)
- `first_name`, `last_name`
- `personalization` (a single string)
- `campaign_id` (which Instantly campaign to add this lead to)

The multi-step sequence template (4-email sequence) lives on the **Instantly campaign**, not on the lead. Each lead carries only the `personalization` string that gets injected into the campaign's Email 1 opener.

The current `compose-sequence.ts` produces a full 4-email `ComposedSequence` per prospect. For the Instantly upload, only the Email 1 opener (which is the `personalisation_trigger` from the prospects table, post-`applyTriggerToEmail1()`) is needed as the `personalization` parameter. Emails 2–4 are fixed by the campaign's template in Instantly.

**The gap:** The prospects table has no `campaign_id` foreign key to indicate which campaign a prospect should be uploaded to. The only link from prospect to campaign is indirect: `prospect.organisation_id` → `organisations.id` → `campaigns.organisation_id`. If an org has multiple campaigns (Tier 1 and Tier 3 per ADR-017), there is no current mechanism to determine which campaign a given prospect belongs to.

**Additionally missing from the prospects table:** No `uploaded_at` timestamp, no `instantly_lead_id` (Instantly's UUID for the lead once created), no `upload_status` field. These don't exist in `src/types/database.ts`.

**`sourced_tier` field:** ADR-017 specifies a `sourced_tier` column on the prospects table. This field does **not exist** in the current database schema (confirmed by grep of database.ts). The tiered sourcing architecture from ADR-017 has not been applied.

**Inconsistency with docs:** ADR-023 references "composed-sequence → Instantly leads via POST /api/v2/leads/add." In practice, the upload doesn't need the full composed sequence — it needs the `personalisation_trigger` string (already on the prospect row) and the `campaign_id` (not currently tracked on the prospect). A schema migration adding `instantly_lead_id` and `upload_status` (and possibly `campaign_id`) to the prospects table is a Prompt 3 prerequisite.

---

## Q7 — setup_status Column Current State

**Direct answer:** Column confirmed as `jsonb NOT NULL DEFAULT '{"campaigns":"pending","linkedin":"pending"}'`. It is actively read by the client dashboard page and passed to `DocumentsActiveState`. It is NOT orphaned — it drives visible UI today. The operator currently writes to it via direct SQL (per migration comment). Prompt 3 would add the operator UI for this.

**Migration:** [supabase/migrations/20260506_organisations_target_and_setup_status.sql](../../supabase/migrations/20260506_organisations_target_and_setup_status.sql), applied b356208 session.

**Column definition (lines 33–34):**
```sql
setup_status jsonb NOT NULL DEFAULT '{"campaigns":"pending","linkedin":"pending"}'
```

**Expected keys:** `campaigns` and `linkedin`. Valid values per key: `pending | in_progress | complete`.

**Reading today:**
- [src/app/dashboard/page.tsx:102](../../src/app/dashboard/page.tsx) — selected as part of org data alongside `id, name, engagement_month, contract_start_date, pipeline_unlocked, setup_status`.
- [src/app/dashboard/page.tsx:244](../../src/app/dashboard/page.tsx) — passed to `<DocumentsActiveState ... setupStatus={org.setup_status as {...}}>`.

The `DocumentsActiveState` component renders the setup progress (campaigns + LinkedIn) to the client in the empty-state view (shown during campaign warmup). So this column is actively rendered in the client-facing dashboard today.

**What writes to it today:** Nothing in code. Only direct SQL. The migration comment says "Written by: operator (direct DB update until operator UI is built)." Prompt 3 builds that UI.

---

## Q8 — Prompt 2 Follow-On Items Now Relevant to Prompt 3

**Direct answer:** Three `[post-c0-polish]` and two `[pre-c1]` items from Prompt 2 touch Prompt 3's surface area. None are blockers for Prompt 3's build, but one is a potential edge case Prompt 3 could incidentally expose. The 4-email sequence rigidity does not conflict with Prompt 3 — the lead upload path uses only the trigger string, not the sequence count.

**Items Prompt 3 could incidentally expose or fix:**

1. **[post-c0-polish] Empty `NEXT_INTERNAL_SECRET` bug** ([BACKLOG.md ~line 1186](../BACKLOG.md)): If `NEXT_INTERNAL_SECRET` is unset, an empty string header grants internal-call bypass. Prompt 3 adds new operator API routes that could be called internally. Not a Prompt 3 fix, but should be in the operator's mind during smoke testing.

2. **[pre-c1] `agents_dispatched_at` recovery mechanism** ([BACKLOG.md ~line 645](../BACKLOG.md)): If `/api/intake/complete` fires but all agents fail silently, the org is locked out of auto-dispatch. Prompt 3 adds a setup_status panel for the operator — this panel is a natural home for a "re-trigger agents" button when that item is eventually built, but it is not in Prompt 3 scope.

3. **[pre-c1] Operator-as-client email separation** ([BACKLOG.md ~line 654](../BACKLOG.md)): Doug's operator email is blocked by the pre-invite check when attempting to self-onboard as client zero. Prompt 3 doesn't touch the invite flow, but this must be solved before client-zero activation. Workaround documented: use Gmail +alias.

**Items NOT relevant to Prompt 3:** The `[post-c0-polish]` items around removing the 80% threshold warning log, configuring Vercel Preview env vars, and dropping the orphaned `handle_new_auth_user` function are all independent of Prompt 3's scope.

**4-email sequence rigidity and Prompt 3:** The `compose-sequence.ts` reads `emails.length` from the variant doc dynamically — it is not hardcoded to 4 ([compose-sequence.ts:322–342](../../src/lib/composition/compose-sequence.ts)). Prompt 3's lead upload handler should use `personalisation_trigger` from the prospect row directly (not re-run composition) and should never hardcode an email count. No conflict.

---

## Q9 — Auth Pattern for New Operator Routes

**Direct answer:** The same three-check pattern (authenticated + `role='operator'` + no org_id filter) applies to all Prompt 3 operator routes. For campaign validation, a direct call from the server action is the cleaner shape — the registry is not involved. A `validateCampaign()` function in `src/lib/integrations/handlers/instantly/` is the right home, following the existing module pattern.

**Confirmation of pattern:** The create-org server action ([actions.ts:62–77](../../src/app/dashboard/operator/clients/new/actions.ts)) uses:
```typescript
const { data: { user } } = await supabase.auth.getUser()  // check 1: authenticated
const { data: userRow } = await supabase.from('users').select('role').eq('id', user.id).single()  // check 2: role
if (userRow.role !== 'operator') return { status: 'error' }  // check 3: operator only
// No organisation_id filter (ADR-021 pattern)
```

The operator layout ([layout.tsx:14–24](../../src/app/dashboard/operator/layout.tsx)) also enforces the auth + role check before rendering any operator route. New server actions must still perform the check independently (server actions are called directly, layout auth can be bypassed in direct POST scenarios).

**Campaign validation (GET /api/v2/campaigns/{id}) routing decision:**

The registry pattern is for ongoing operational capabilities (send email, enrich contact, order mailboxes). A one-off validation call that checks whether a UUID exists before a row is written is an administrative operation, not a capability dispatch.

The cleaner shape: `validateInstantlyCampaign(campaignUuid: string, apiKey: string)` in `src/lib/integrations/handlers/instantly/campaigns.ts` (new file, consistent with the directory structure). The server action calls this function directly. The registry is not involved.

This matches the existing pattern: `fetchCampaignStats()` in campaign-analytics.ts is a similar administrative/diagnostic operation called directly by the cron route, not routed through the registry.

---

## Q10 — Migration Ordering and Naming

**Direct answer:** After Prompt 2's fix, the Prompt 2 migrations have correct full timestamps (`20260512nnnnnn_name.sql`). One earlier migration (`20260512_faq_rls_operator_policies.sql`) has a date-only prefix and no time component. For Prompt 3, the cleanest approach is option (b): pre-compute the timestamp as the ISO local time immediately before calling `apply_migration`, use it as the local filename. If apply_migration assigns a different timestamp, rename the file to match.

**Current state of supabase/migrations/ after Prompt 2:**

Full timestamp format (correct):
```
20260512220841_org_contract_dates.sql
20260512220938_org_dispatch_columns.sql
20260512221142_users_pending_review.sql
20260512230916_users_pending_review_fk_cascade.sql
```

Date-only format (potential ordering issue):
```
20260512_faq_rls_operator_policies.sql
```

All pre-Prompt-2 migrations use date-only format (`20260419_...`, `20260420_...`, etc.), which is the original convention. The Prompt 2 migrations shifted to full timestamps after the MCP assigned them.

**Practical recommendation for Prompt 3:** Name local files with the date-only prefix initially (`20260513_name.sql`). After `apply_migration` runs and the Supabase DB records a full timestamp, rename the local file to match. This is the pattern established by Prompt 2 and avoids ambiguity in ordering.

**The `20260512_faq_rls_operator_policies.sql` naming:** This file predates Prompt 2 and uses the original convention. It is not a Prompt 3 concern to fix, but it should be noted that Supabase's migration tracking uses the filename as the key — if this file's timestamp differs from what Supabase tracks internally, `supabase db push` or diff commands could produce false positives. No action needed for Prompt 3 unless a migration conflict surfaces.

---

## OPEN QUESTIONS

1. **Capability naming convention for new registry slots.** ADR-023 uses dotted namespaces (`outreach.upload_leads`, `outreach.order_mailboxes`). The existing convention uses `can_<verb>_<noun>`. These are cosmetic (the registry is not runtime-dispatched) but choosing inconsistently makes the registry harder to reason about. Which convention should Prompt 3 use? Recommendation required before the migration is written.

2. **`/dashboard/operator/clients/[id]` vs inline panels.** The setup_status panel and campaign registration UI have no natural home without creating the `[id]` route. Should Prompt 3 create that route (adds ~1 day of work for the shell + navigation) or should both panels be implemented as forms/modals accessible from the main operator page (`/dashboard/operator` AllClientsView)? This is a UX decision with build-time implications.

3. **Prospect-to-campaign mapping for Instantly lead upload.** The prospects table has no `campaign_id` column and no `upload_status`. For the lead upload handler, how should a prospect be mapped to a specific Instantly campaign? Options: (a) operator selects campaign at upload time (requires UI), (b) org has one default campaign and all prospects go to it (simpler, breaks when there are multiple campaigns per org), (c) a `campaign_id` column is added to prospects at sourcing time. Which model does Prompt 3 adopt?

4. **`instantly_lead_id` and upload tracking on prospects.** After a lead is uploaded to Instantly, we need to record Instantly's UUID for that lead (needed for future suppress calls, which currently use `leadInstantlyId` as the first argument). Where does this live? The `suppressed` and `suppression_reason` columns exist on prospects, but there is no `instantly_lead_id` field. Is this a Prompt 3 schema addition or does it go into a separate table?

5. **`sourced_tier` field is missing.** ADR-017 specifies a `sourced_tier` column on the prospects table. It does not exist in the current schema. The tiered routing in compose-sequence.ts that branches on tier is therefore not implemented. Does Prompt 3 add this field as part of the lead upload work, or is it deferred?

6. **DFY mailbox order domains TLD validation.** ADR-023 says `.com` and `.org` only. The Instantly DFY API may accept other TLDs. Should the UI validation be a hardcoded enum, or should it call the pre-warmed domain pool check first and derive allowed TLDs from the response? The former is simpler but could break if Instantly adds TLDs. Decision needed before building the DFY UI.

7. **API key resolution for the campaign validation call and new leads/DFY handlers.** All existing Instantly calls resolve the API key from `integration_credentials` (queried by the cron routes before calling poll functions). For the new server actions (campaign registration, lead upload, DFY ordering), the server action would need to resolve the API key itself from the same table. Is there a shared `getInstantlyApiKey()` helper already? (Not found — it is inlined in each cron route.) Should Prompt 3 extract this into a shared function in the handlers directory?

---

## RISKS I'M SEEING

1. **Lead upload data model is underspecified for multi-campaign orgs.** The current campaigns table allows one org to have multiple campaigns (no unique constraint on `organisation_id`). ADR-017 implies separate Tier 1/2 and Tier 3 campaign pools. The lead upload handler needs to know which campaign to upload a given prospect to. If this is not designed before Prompt 3 is written, the handler will likely default to "first campaign for this org" — which is correct for client zero (one campaign) but wrong for any org with multiple campaigns. This is a scoping decision, not a code question, but it should be explicit.

2. **`external_id` on campaigns has no index confirmed.** The polling code queries `.eq('external_id', campaignId)` on every reply poll ([polling/instantly.ts:70](../../src/lib/integrations/polling/instantly.ts)). No index on this column is confirmed in any migration file. Prompt 3's campaign registration UI will make `external_id` the primary lookup key for this column. If the index doesn't exist in the live DB, it should be added in the Prompt 3 migration. Worth verifying via Supabase MCP `list_tables` or SQL before the migration is written.

3. **`signals_signal_type_check` constraint is still broken** (BACKLOG [~line 1244](../BACKLOG.md)). The constraint doesn't include `reply_received`, so all reply signal inserts fail silently. This is a pre-existing blocker for the entire signal pipeline, not a Prompt 3 issue — but Prompt 3 adds more signals (lead_uploaded, etc.) that will also fail silently if this constraint problem is not fixed first. Prompt 3 should bundle a constraint fix in its first migration or treat this as a Prompt 3 prerequisite.

4. **Apollo 403 on free plan means prospect research is currently non-functional for real clients.** The research agent falls through gracefully when Apollo returns 403 (`available: false`), but the synthesis output quality degrades significantly without Apollo enrichment data. Prompt 3's "formalised graceful degradation" requires Apollo to actually be returning 403 to test the fallthrough paths. Prompt 3 should be smoke-tested with Apollo deactivated as well as activated — two distinct test scenarios.

5. **No handle_new_auth_user() cleanup before Prompt 3.** BACKLOG notes an orphaned `handle_new_auth_user()` function ([BACKLOG.md ~line 1164](../BACKLOG.md)) that is not attached to any trigger but exists alongside the live `handle_new_user()`. Any Prompt 3 trigger additions near `auth.users` should confirm they reference `handle_new_user()`, not the orphaned function.

6. **Vercel Preview environment is missing key env vars** ([BACKLOG.md ~line 1172](../BACKLOG.md)). `RESEND_FROM_EMAIL` and `NEXT_PUBLIC_APP_URL` are Production-only. Prompt 3's new operator UI (campaign registration, setup_status panel, DFY ordering) will deploy to Preview on every branch push. If any of these routes call `sendTransactionalEmail()` or use `getAppUrl()`, they will silently fail or link back to the production URL on Preview. This should be fixed before Prompt 3 starts — it's a 10-minute Vercel config change.

7. **The `users_pending_review` Database Webhook is a manual step not yet confirmed.** The Prompt 2 migration creates the `users_pending_review` table with a Supabase Database Webhook expected to fire the operator notification email. Database Webhooks must be configured manually in the Supabase dashboard — they are not created by migrations. Whether this webhook actually exists in the live DB is unknown from the code. Prompt 3 adds a setup_status panel that also involves operator notifications — this is a reminder to verify the webhook before any Prompt 3 flow depends on it.

8. **`NEXT_INTERNAL_SECRET` must be set in Vercel env before Prompt 3 tests agent dispatch end-to-end.** The `/api/intake/complete` route dispatches agents with `x-internal-secret: process.env.NEXT_INTERNAL_SECRET ?? ''`. If unset, an empty string is sent and matched — the BACKLOG flags this as a security gap ([BACKLOG.md ~line 1186](../BACKLOG.md)). Not a Prompt 3 build issue, but an operational risk during testing.

---

## PROMPT STRUCTURE RECOMMENDATION

**Recommendation: two prompts, not one.**

Reasoning:

The five items in Prompt 3 split cleanly along a dependency boundary:

**Group A — UI and registry work (no external API subscriptions required):**
- Operator UI: Register Instantly campaign (validation against live Instantly API — requires active API key, but not a paid plan upgrade)
- Operator UI: Setup status panel
- Registry slots for `outreach.upload_leads` and `outreach.order_mailboxes`

**Group B — Paid-API integration work (requires Instantly Growth plan activation):**
- Instantly lead upload capability (POST /api/v2/leads/add — requires Growth plan)
- Instantly DFY mailbox ordering (POST /api/v2/dfy-email-account-orders — requires Growth plan + real money)
- Apollo graceful degradation formalisation (requires Apollo API key to test)

The arguments for splitting:

1. **Subscription timing.** The DFY mailbox endpoint requires an active Instantly Growth plan ($47/mo). Per ADR-023, subscriptions are deliberately deferred to Costa Rica activation. Group A can be built, reviewed, and merged before any paid subscription is activated. Group B should be built during the Costa Rica activation window.

2. **Real-money risk.** The DFY ordering flow involves real spend (~$73 first month). Building and testing this flow against a live API before Doug is ready to activate mailboxes creates accidental-order risk even with simulate:true logic in place. Separating this into its own prompt means the flow is reviewed in full before the Growth plan is activated.

3. **Lead upload data model gap (Q6 finding).** The prospects table is missing `instantly_lead_id`, `upload_status`, and the campaign mapping model is undefined. Resolving these questions (Open Questions 3 and 4 above) before starting Group B is important — if Group A ships first, there is a natural pause to answer those questions before Group B begins.

4. **Apollo fallthrough testing.** Formalising Apollo graceful degradation requires testing with and without an active Apollo subscription. This is a Group B concern that can proceed independently once the subscription is activated.

The arguments for keeping it one prompt: if Doug activates both Instantly Growth and Apollo at the same time during Costa Rica, the subscription timing argument weakens. The scope is roughly equivalent to Prompt 2 in total.

**Suggested split if two prompts:**
- **Prompt 3A (pre-subscriptions):** Campaign registration UI, setup_status panel, registry slot additions, `validateInstantlyCampaign()` handler, `prospects` schema additions (instantly_lead_id, upload_status, campaign_id FK). Data model is ready for Group B.
- **Prompt 3B (post-subscriptions):** Lead upload capability + handler, DFY mailbox ordering + handler, Apollo graceful degradation formalisation, smoke tests against live APIs.

**If one prompt:** The build should explicitly gate DFY ordering to simulate:true only during build/test, with a clear operator confirmation required before the first real order is placed. The lead upload handler should be built against the data model additions from the first half of the same prompt.
