# RLS Verification — 2026-05-13

Live DB verification of multi-tenant security posture across all public tables.
Read-only pass. Purpose: confirm every table Prompt 3A will touch is secure before
any schema changes are made.

Project: `hjpvnvjryxdjcfdsfhzy` (eu-west-1, Postgres 17)

---

## 1. Full Table Inventory

Query: `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`

23 entries returned. 22 are tables; 1 is a view (`client_organisation_view`).

```
agent_runs
campaigns
client_organisation_view   ← VIEW, not a table
document_suggestions
faq_extractions
faqs
intake_files
intake_responses
intake_website_pages
integration_credentials
integrations_registry
meetings
organisations
patterns
polling_cursors
prospect_research_results
prospects
reply_drafts
reply_handling_actions
signals
strategy_documents
users
users_pending_review
```

**Expected and present:** All tables known from TypeScript types and migrations are here.

**Surprises:** None. `client_organisation_view` is the expected client-scoped read-only
view of `organisations`. `meetings` was listed in the TypeScript types but had no
migration file — it existed before the migrations folder was established.

**Key finding (ADR spot-check concern resolved):** The ADR spot-check flagged that core
tables have no migration files and their RLS status was unverifiable from code. Live DB
query confirms **all 22 tables have `relrowsecurity = true`**. There is no table with
RLS disabled. The concern from 514c6f5 is fully resolved.

---

## 2. Table Categorisation

| Table | Category | Justification |
|---|---|---|
| agent_runs | PER-ORG | Execution records scoped to `client_id` |
| campaigns | PER-ORG | Campaign rows scoped to `organisation_id` |
| document_suggestions | PER-ORG | Strategy doc suggestions scoped to `organisation_id` |
| faq_extractions | PER-ORG | Extracted FAQ candidates scoped to `organisation_id` |
| faqs | PER-ORG | Approved FAQs scoped to `organisation_id` |
| intake_files | PER-ORG | Uploaded files scoped to `organisation_id` |
| intake_responses | PER-ORG | Questionnaire answers scoped to `organisation_id` |
| intake_website_pages | PER-ORG | Scraped website pages scoped to `organisation_id` |
| integration_credentials | PER-ORG/SHARED | Rows scoped per org (nullable `organisation_id`); global row has `organisation_id = NULL` for the Instantly key shared across all orgs in Phase 1 |
| meetings | PER-ORG | Booked meetings scoped to `organisation_id` |
| organisations | PER-ORG | Org record is its own scope anchor |
| patterns | SHARED | Cross-org anonymised patterns; intentionally cross-org read |
| polling_cursors | PER-ORG/SHARED | Cursor rows scoped per `source`; `organisation_id` nullable (global cursors have null) |
| prospect_research_results | PER-ORG | Research results scoped to `organisation_id` |
| prospects | PER-ORG | Prospect records scoped to `organisation_id` |
| reply_drafts | PER-ORG | Reply drafts scoped via FK through signals → organisation_id |
| reply_handling_actions | PER-ORG | Action log scoped via FK through signals → organisation_id |
| signals | PER-ORG | Events scoped to `organisation_id` |
| strategy_documents | PER-ORG | Strategy docs scoped to `organisation_id` |
| users | PER-ORG | User accounts scoped to `organisation_id` |
| users_pending_review | PER-ORG | Multi-user attempts scoped to `attempted_org_id` |
| integrations_registry | SHARED | Capability-to-tool registry; no per-org data |
| client_organisation_view | VIEW | SECURITY DEFINER view over `organisations`; scoped by `get_my_organisation_id()` |

---

## 3. Per-Table Verification

### RLS Enabled Status (all tables)

Query confirmed all 22 tables: `relrowsecurity = true` for every entry. No exceptions.

### Policy-by-Policy Evaluation

---

#### `agent_runs`
- **organisation_id column:** `client_id uuid NOT NULL` (semantic equivalent)
- **RLS enabled:** ✓
- **SELECT — clients:** `client_id = (SELECT organisation_id FROM users WHERE id = auth.uid() AND role = 'client')` ✓
- **SELECT — operators:** `EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'operator')` ✓
- **INSERT/UPDATE/DELETE:** No policies for authenticated users. Agents write via service_role (bypasses RLS). ✓
- **Verdict: SECURE**

---

#### `campaigns`
- **organisation_id column:** `organisation_id uuid NOT NULL` ✓
- **RLS enabled:** ✓
- **SELECT — clients:** `organisation_id = get_my_organisation_id()` ✓
- **ALL — operators:** `is_operator()` / `with_check: is_operator()` ✓
- **No client write policy** — clients cannot create campaigns. Correct.
- **Verdict: SECURE**

---

#### `document_suggestions`
- **organisation_id column:** `organisation_id uuid` ✓
- **RLS enabled:** ✓
- **SELECT — clients:** `organisation_id = get_my_organisation_id()` ✓
- **ALL — operators:** `is_operator()` ✓
- **Verdict: SECURE**

---

#### `faq_extractions`
- **organisation_id column:** `organisation_id uuid` ✓
- **RLS enabled:** ✓
- **ALL — clients:** `qual = false` (explicit block) ✓
- **ALL — operators:** `is_operator()` ✓
- **Verdict: SECURE**

---

#### `faqs`
- **organisation_id column:** `organisation_id uuid` ✓
- **RLS enabled:** ✓
- **ALL — clients:** `qual = false` (explicit block) ✓
- **ALL — operators:** `is_operator()` ✓
- **Verdict: SECURE**

---

#### `intake_files`
- **organisation_id column:** `organisation_id uuid` ✓
- **RLS enabled:** ✓
- **SELECT:** `organisation_id = (SELECT organisation_id FROM users WHERE id = auth.uid())` ✓
- **INSERT:** `with_check: organisation_id = (SELECT organisation_id FROM users WHERE id = auth.uid())` ✓
- **DELETE:** same org scoping ✓
- **No UPDATE policy** — clients cannot update intake files (delete + re-upload is the pattern). By design.
- **Verdict: SECURE**

---

#### `intake_responses`
- **organisation_id column:** `organisation_id uuid` ✓
- **RLS enabled:** ✓
- **ALL — clients:** `organisation_id = get_my_organisation_id()` / `with_check` same ✓
- **ALL — operators:** `is_operator()` ✓
- **Verdict: SECURE**

---

#### `intake_website_pages`
- **organisation_id column:** `organisation_id uuid` ✓
- **RLS enabled:** ✓
- **SELECT — clients:** `(auth.jwt() ->> 'role') = 'client' AND organisation_id = (SELECT organisation_id FROM users WHERE id = auth.uid() LIMIT 1)` ✓
- **ALL — operators:** `(auth.jwt() ->> 'role') = 'operator'` ✓
- **Note:** Uses raw JWT claim rather than `is_operator()` / `get_my_organisation_id()` helper functions. Functionally equivalent if JWT is populated correctly, but inconsistent with the rest of the schema. Minor.
- **Verdict: SECURE**

---

#### `integration_credentials`
- **organisation_id column:** `organisation_id uuid NULLABLE` ✓ (global row has `NULL`)
- **RLS enabled:** ✓
- **Policies:** NONE
- **Advisor finding:** `rls_enabled_no_policy` (INFO level)
- **Current exposure:** RLS with no policies defaults to DENY ALL for non-service-role connections. All credential reads in application code use `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS). Currently safe.
- **Risk:** Silent empty-result if any future client-facing path accidentally uses a client session to read credentials. No explicit documented policy intent.
- **Verdict: GAP (currently safe, needs explicit policies)**

---

#### `integrations_registry`
- **Category: SHARED**
- **RLS enabled:** ✓
- **ALL — operators only:** `is_operator()` ✓
- **No client policy** — clients cannot see the tool registry. Correct.
- **Verdict: SECURE**

---

#### `meetings`
- **organisation_id column:** `organisation_id uuid` ✓
- **RLS enabled:** ✓
- **SELECT — clients:** `organisation_id = get_my_organisation_id()` ✓
- **ALL — operators:** `is_operator()` ✓
- **Verdict: SECURE**

---

#### `organisations`
- **org anchor:** `id uuid` (is its own scope) ✓
- **RLS enabled:** ✓
- **SELECT — clients:** `id = get_my_organisation_id()` ✓
- **ALL — operators:** `is_operator()` ✓
- **Operator-only columns confirmed present:** `contract_status`, `payment_status`, `engagement_month`, `auto_approve_window_hours`, `calendly_url`, `monthly_meetings_target`, `setup_status`, `contract_end_date`, `agents_dispatched_at`, `docs_complete_notification_sent_at`, `founder_first_name`, `pipeline_unlock_manual_override`
- **Client-visible columns (via `client_organisation_view`):** `id`, `name`, `slug`, `contract_start_date`, `pipeline_unlocked`, `pipeline_unlock_at`, `meetings_count`, `created_at`, `updated_at` — no sensitive fields exposed.
- **Verdict: SECURE**

---

#### `patterns`
- **Category: SHARED**
- **organisation_id column:** None — cross-org by design ✓
- **RLS enabled:** ✓
- **SELECT — operators:** `is_operator()` ✓
- **INSERT — blocked:** `with_check = false` ✓
- **UPDATE — blocked:** `qual = false` ✓
- **DELETE — blocked:** `qual = false` ✓
- **Note:** No client SELECT policy. Clients never see patterns — correct (cross-org anonymised data).
- **Verdict: SECURE**

---

#### `polling_cursors`
- **organisation_id column:** `organisation_id uuid NULLABLE` ✓
- **RLS enabled:** ✓
- **SELECT — operators:** `EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'operator')` ✓
- **No write policies** — polling process writes via service_role. ✓
- **Verdict: SECURE**

---

#### `prospect_research_results`
- **organisation_id column:** `organisation_id uuid` ✓
- **RLS enabled:** ✓
- **SELECT — clients:** `organisation_id = (SELECT organisation_id FROM users WHERE id = auth.uid() AND role = 'client')` ✓
- **SELECT — operators:** `EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'operator')` ✓
- **No write policies** — agents write via service_role. ✓
- **Verdict: SECURE**

---

#### `prospects`
- **organisation_id column:** `organisation_id uuid NOT NULL` ✓
- **RLS enabled:** ✓
- **SELECT — clients:** `organisation_id = get_my_organisation_id()` ✓
- **ALL — operators:** `is_operator()` ✓
- **Prompt 3A note:** `instantly_lead_id` and `upload_status` do not yet exist. When added, they inherit the existing operator ALL policy automatically — no new policy needed.
- **Verdict: SECURE**

---

#### `reply_drafts`
- **organisation_id column:** Indirect via FK (draft → signal → organisation_id)
- **RLS enabled:** ✓
- **ALL — operators:** `is_operator()` ✓
- **No client policy** — reply triage queue is operator-only. Correct.
- **Verdict: SECURE**

---

#### `reply_handling_actions`
- **organisation_id column:** Indirect via FK (action → signal → organisation_id)
- **RLS enabled:** ✓
- **SELECT — operators:** `EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'operator')` ✓
- **No write policies** — processor writes via service_role. ✓
- **Verdict: SECURE**

---

#### `signals`
- **organisation_id column:** `organisation_id uuid NOT NULL` ✓
- **RLS enabled:** ✓
- **ALL — operators:** `is_operator()` ✓
- **No client SELECT policy** — clients don't see raw signals. Dashboard shows aggregate metrics only. Intentional.
- **Verdict: SECURE**

---

#### `strategy_documents`
- **organisation_id column:** `organisation_id uuid` ✓
- **RLS enabled:** ✓
- **SELECT — clients:** `organisation_id = get_my_organisation_id() AND status IN ('active', 'approved')` ✓
- **ALL — operators:** `is_operator()` ✓
- **Status filter** prevents clients from seeing draft or archived documents. ✓
- **Verdict: SECURE**

---

#### `users`
- **organisation_id column:** `organisation_id uuid` ✓
- **RLS enabled:** ✓
- **SELECT — authenticated:** `organisation_id = get_my_organisation_id()` — org members can see each other ✓
- **ALL — operators:** `is_operator()` ✓
- **UPDATE — self:** `id = auth.uid()` with `with_check: id = auth.uid()` ✓
- **Verdict: SECURE**

---

#### `users_pending_review`
- **organisation_id column:** `attempted_org_id uuid` ✓
- **RLS enabled:** ✓
- **SELECT — operators:** `EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'operator')` ✓
- **No write policies** — trigger writes only (service context). ✓
- **Verdict: SECURE**

---

## 4. SHARED Tables Summary

| Table | RLS | Policy State | Assessment |
|---|---|---|---|
| `integrations_registry` | ✓ | Operators ALL only | Correct — capability registry is operator-internal |
| `patterns` | ✓ | Operators SELECT only; all writes blocked | Correct — cross-org anonymous data; write-blocked at policy level |

The `patterns` write block is belt-and-suspenders: the application never writes to it
(no aggregation agent exists yet), and the RLS policies enforce this at the DB level too.

---

## 5. Advisor Cross-Reference

### Findings from `get_advisors(type: security)`

**1. `rls_enabled_no_policy` — INFO**
Table: `public.integration_credentials`
→ Matches the GAP found in Step 3. Validates the finding.

**2. `security_definer_view` — ERROR**
View: `public.client_organisation_view`
→ View definition: `SELECT id, name, slug, ... FROM organisations WHERE id = get_my_organisation_id()`
→ SECURITY DEFINER means the view runs as its definer (bypasses table RLS). However, the
`WHERE id = get_my_organisation_id()` clause self-scopes using the caller's auth session.
For unauthenticated calls, `get_my_organisation_id()` returns null → zero rows.
→ Assessment: **safe in practice** (no data exposure to anon callers). Supabase's advisor
flags it generically — the risk is theoretical here because the WHERE clause is equivalent
to the RLS policy on `organisations`. No action required for Prompt 3A.

**3. `function_search_path_mutable` — WARN (×2)**
Functions: `public.append_faq_variant`, `public.set_updated_at`
→ Mutable search path is a SQL injection escalation risk for SECURITY DEFINER functions.
`append_faq_variant` is SECURITY DEFINER. `set_updated_at` is used as a trigger.
→ Medium priority. Fix: add `SET search_path TO 'public'` to both function definitions.
`approve_document_suggestion` already has `SET search_path TO 'public'` — model to follow.

**4. `anon_security_definer_function_executable` — WARN (×6): CRITICAL FINDINGS**

These six SECURITY DEFINER functions are callable by the `anon` role via the REST API at
`/rest/v1/rpc/<function_name>`:

| Function | Risk Level | Notes |
|---|---|---|
| `approve_document_suggestion(uuid, uuid)` | **HIGH** | No auth check in body; `SET row_security TO 'off'`; can approve suggestions and rewrite active strategy documents for any org with a known suggestion UUID |
| `append_faq_variant(uuid, text)` | **HIGH** | No auth check visible; SECURITY DEFINER; can modify FAQ question variants for any org with a known FAQ UUID |
| `get_my_organisation_id()` | Low | Returns null for unauthenticated callers — no data exposure |
| `handle_new_auth_user()` | Medium | Trigger function, not meant to be directly callable; no `NEW` row available when called directly — likely fails gracefully but should not be exposed |
| `handle_new_user()` | Medium | Same as above — trigger function incorrectly exposed via REST |
| `is_operator()` | Low | Returns false for unauthenticated callers — no data exposure |
| `rls_auto_enable()` | Medium | Function name suggests it enables RLS on tables; callable by anon is inappropriate regardless |

**`approve_document_suggestion` detail:** The function body was retrieved and confirmed:
- `SECURITY DEFINER SET row_security TO 'off'` — runs with full DB permissions, RLS disabled
- No `auth.uid() IS NULL` check — does not verify the caller is authenticated
- An unauthenticated caller who knows a `document_suggestion` UUID can:
  1. Archive the currently active strategy document for that organisation
  2. Write a new active strategy document with the suggestion's content
  3. Mark the suggestion as approved with an arbitrary `p_reviewer_id`

This is a **genuine vulnerability**. Attack surface at current state (pre-c1, private data,
no external clients) is extremely low — the only suggestion UUIDs that exist are in the
operator's own DB. But this must be fixed before any client other than the operator exists.

**5. `authenticated_security_definer_function_executable` — WARN (×6)**
Same six functions, now flagging the `authenticated` role (signed-in users) can also call
them via REST. `approve_document_suggestion` callable by any authenticated user (not just
operators) is the concern — a client user who discovers the RPC endpoint and finds a valid
suggestion UUID could approve their own strategy documents without operator review.

**6. `auth_leaked_password_protection` — WARN**
→ MargenticOS uses magic link only (no passwords). This advisory is not applicable.

---

## 6. Prompt 3A Impact Assessment

### Tables Prompt 3A will directly touch

---

**`prospects`** — Current: SECURE
- Prompt 3A adds: `instantly_lead_id text NULLABLE`, `upload_status text NULLABLE`
- Policy inheritance: existing `operators_full_access_prospects` (ALL, `is_operator()`) and
  `clients_read_own_prospects` (SELECT, `get_my_organisation_id()`) cover all new columns
  automatically — no new policy needed.
- Assessment: additions are safe under existing security model ✓

---

**`campaigns`** — Current: SECURE
- Prompt 3A adds: campaign registration UI writes new rows via operator action
- All new rows will have `organisation_id` set — covered by `operators_full_access_campaigns`.
- No new columns expected.
- Assessment: no policy changes needed ✓

---

**`organisations`** — Current: SECURE
- Prompt 3A touches: `setup_status` jsonb column (already exists), operator UI writes via
  API route using service_role or operator session
- No new columns needed for setup_status panel (column was added in Prompt 2 migration).
- Assessment: no policy changes needed ✓

---

**`integration_credentials`** — Current: GAP
- Prompt 3A touches: Instantly API key reads for lead upload and DFY mailbox operations
- All reads are currently via service_role — will remain service_role in Prompt 3A.
- However, Prompt 3A is the right moment to add explicit policies to close this gap.
- Assessment: **add policies in Prompt 3A migration** (see P1 Items)

---

**New tables Prompt 3A introduces**

If Prompt 3A adds any new tables (e.g., for tracking lead upload jobs, DFY order records,
or campaign registration audit), each must follow the same pattern:
1. `organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE`
2. `ALTER TABLE <name> ENABLE ROW LEVEL SECURITY` in the same migration
3. Separate policies for clients (SELECT only, `get_my_organisation_id()`) and operators (ALL, `is_operator()`)
4. Service_role handles writes from agent/cron routes (no INSERT policy needed for authenticated)

---

## 7. Drift from ADR-003

ADR-003 claims: "RLS policies block cross-client queries at the data layer."

**Confirmed aligned:**
- All 22 tables have RLS enabled ✓
- No `qual = true` (unrestricted access) policies anywhere ✓
- Every PER-ORG table with client-facing SELECT uses `get_my_organisation_id()` or direct
  `organisation_id = auth.uid()` subquery ✓

**Documented drift:**
- `integration_credentials` — RLS enabled, no policies. Not in BACKLOG. Should be added.

**Undocumented drift (new findings):**
- `approve_document_suggestion` — callable by anon with RLS disabled. Not in BACKLOG.
- `append_faq_variant` — callable by anon. Not in BACKLOG.
- `handle_new_auth_user`, `handle_new_user`, `rls_auto_enable` — trigger/admin functions
  exposed via REST API to anon. Not in BACKLOG.

**Not drift (by design):**
- `signals` has no client SELECT policy — clients see aggregate dashboard metrics, not raw signals. Intentional.
- `reply_drafts`, `reply_handling_actions`, `faqs`, `faq_extractions` — operator-only by design.
- `intake_files` has no UPDATE policy — delete + re-upload pattern is intentional.

---

## P0 ITEMS

**Must fix before Prompt 3A touches the schema.**

---

### P0-1: `approve_document_suggestion` callable by unauthenticated users

**What's broken:** The `approve_document_suggestion(uuid, uuid)` SECURITY DEFINER function
has no auth check in its body and `SET row_security TO 'off'`. It is callable by the
`anon` role via `/rest/v1/rpc/approve_document_suggestion`. A caller who knows a
`document_suggestion` UUID can approve it, archive the active strategy document for that
org, and write a new active strategy document.

**Risk:** At current state (pre-c1, single operator), the attack surface is near-zero because
suggestion UUIDs are not publicly known. Becomes a real risk the moment any client exists,
since UUIDs could theoretically be observed in network traffic or error logs.

**Fix (migration):**
```sql
-- Revoke execute from anon and authenticated roles on approve_document_suggestion.
-- Approval is operator-only, invoked via the operator UI (server action with role check).
-- The function runs SECURITY DEFINER so it bypasses RLS — must be callable only by
-- trusted server-side code, not via the REST API.
REVOKE EXECUTE ON FUNCTION public.approve_document_suggestion(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.approve_document_suggestion(uuid, uuid) FROM authenticated;
```

---

### P0-2: `append_faq_variant` callable by unauthenticated users

**What's broken:** The `append_faq_variant(uuid, text)` SECURITY DEFINER function is
callable by `anon` via `/rest/v1/rpc/append_faq_variant`. A caller who knows a FAQ UUID
can append arbitrary text to the `question_variants` array of any FAQ record.

**Risk:** Lower severity than P0-1 (variants affect matching quality, not document approval),
but still a data integrity issue callable by anyone on the internet.

**Fix (migration):**
```sql
REVOKE EXECUTE ON FUNCTION public.append_faq_variant(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.append_faq_variant(uuid, text) FROM authenticated;
```

---

## P1 ITEMS

**Fix in Prompt 3A's first migration.**

---

### P1-1: `integration_credentials` has no RLS policies

**What's broken:** Table has RLS enabled but zero policies. Supabase's default for RLS
with no policies is DENY ALL for non-service-role connections. Currently harmless because
all credential reads use service_role. Needs explicit documentation of intent.

**Fix (migration):**
```sql
-- Clients can never read integration credentials.
CREATE POLICY clients_cannot_access_credentials
  ON public.integration_credentials FOR ALL TO authenticated
  USING (false);

-- Operators can read all credentials (needed for future operator UI showing connection status).
CREATE POLICY operators_read_credentials
  ON public.integration_credentials FOR SELECT TO authenticated
  USING (is_operator());

-- Operators can manage credentials for their platform.
CREATE POLICY operators_manage_credentials
  ON public.integration_credentials FOR ALL TO authenticated
  USING (is_operator())
  WITH CHECK (is_operator());
```

---

### P1-2: Trigger functions exposed via REST API

**What's broken:** `handle_new_auth_user()`, `handle_new_user()`, and `rls_auto_enable()`
are SECURITY DEFINER functions callable by `anon` via REST. These are internal
trigger/admin functions and should never be directly callable.

**Fix (migration):**
```sql
REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM authenticated;
```

---

### P1-3: Mutable search path on `append_faq_variant` and `set_updated_at`

**What's broken:** Both functions lack `SET search_path TO 'public'`. This is a potential
SQL injection escalation vector for SECURITY DEFINER functions if an attacker can manipulate
the search path.

**Fix (migration):** Re-define both functions with the search_path set. Use
`approve_document_suggestion` as the model (it already has `SET search_path TO 'public'`
in its definition).

---

## BACKLOG ITEMS

Ready to paste into `/docs/BACKLOG.md`:

---

```
### [security] REVOKE anon execute on approve_document_suggestion and append_faq_variant
Date deferred: 2026-05-13
Context: RLS verification pass confirmed both functions are callable by unauthenticated
users via REST. approve_document_suggestion has SET row_security TO 'off' and no auth
check — a genuine vulnerability. append_faq_variant can corrupt FAQ variant data. Fixed
in Prompt 3A first migration (REVOKE EXECUTE FROM anon, authenticated). See P0-1 and
P0-2 in docs/discovery/2026-05-13-rls-verification.md.
```

---

```
### [security] integration_credentials explicit RLS policies
Date deferred: 2026-05-13
Context: integration_credentials has RLS enabled but zero policies. Currently safe
because all reads use service_role. Add explicit clients_cannot_access + operators_manage
policies in Prompt 3A migration to document intent and close the gap. See P1-1 in
docs/discovery/2026-05-13-rls-verification.md.
```

---

```
### [security] Revoke trigger functions from REST API (handle_new_user, handle_new_auth_user, rls_auto_enable)
Date deferred: 2026-05-13
Context: Three SECURITY DEFINER trigger/admin functions are callable by anon via REST.
No exploit path identified (trigger functions fail without NEW record), but exposure is
inappropriate. REVOKE EXECUTE FROM anon and authenticated in Prompt 3A migration.
See P1-2 in docs/discovery/2026-05-13-rls-verification.md.
```

---

```
### [security] set_updated_at mutable search_path
Date deferred: 2026-05-13
Context: set_updated_at trigger function lacks SET search_path TO 'public'. Low risk
(SECURITY INVOKER, not DEFINER), but Supabase advisor flags it. Fix alongside append_faq_variant
in a future maintenance migration. See P1-3.
```

---

```
### [security] client_organisation_view SECURITY DEFINER — document as accepted
Date deferred: 2026-05-13
Context: Supabase advisor flags client_organisation_view as SECURITY DEFINER (ERROR level).
View is safe in practice — WHERE clause uses get_my_organisation_id() which returns null
for unauthenticated callers. No data exposure. Accept the advisor finding as acknowledged
and document here. Revisit if the view definition changes.
```
