# Prompt 3A Audit — 2026-05-21

Pre-push audit of all 8 Prompt 3A commits. Run before any push to origin.
Methodology: Supabase MCP (execute_sql, get_advisors), live file reads, grep, vercel CLI, tsc, npm run build.

---

## Section 1 — Schema and Migrations

### Section 1.1 — Migration timestamps confirmed
- **Checked:** `list_migrations` against live DB
- **Found:** Three Prompt 3A migrations applied:
  - `20260521130317` — prospects_outbound_columns_and_p0_fixes
  - `20260521130527` — security_hygiene_p1
  - `20260521132309` — capability_registry_slots
- **Verdict:** PASS

---

### Section 1.2 — Prospects outbound columns
- **Checked:** `information_schema.columns` for all five new columns; `check_constraints` for CHECK constraint
- **Found:**
  ```
  campaign_id                uuid        nullable     (no default)
  outbound_lead_id           text        nullable     (no default)
  outbound_upload_attempted_at  timestamptz  nullable  (no default)
  outbound_upload_error      text        nullable     (no default)
  outbound_upload_status     text        NOT NULL     DEFAULT 'pending'
  ```
  CHECK constraint: `(outbound_upload_status = ANY (ARRAY['pending'::text, 'uploading'::text, 'uploaded'::text, 'failed'::text]))`
- **Verdict:** PASS

---

### Section 1.3 — Campaigns schema (name + indexes)
- **Checked:** column schema for campaigns.name; `pg_indexes` for both new indexes
- **Found:**
  - `campaigns.name`: text, nullable — correct
  - `campaigns_external_id_idx`: `CREATE INDEX campaigns_external_id_idx ON public.campaigns USING btree (external_id)` — correct
  - `campaigns_external_id_unique_idx`: `CREATE UNIQUE INDEX campaigns_external_id_unique_idx ON public.campaigns USING btree (external_id) WHERE (external_id IS NOT NULL)` — correct
- **Verdict:** PASS

---

### Section 1.4 — Cross-org trigger: function body verified
- **Checked:** `pg_trigger` (all triggers on prospects), `pg_proc` for function body
- **Found:**
  - Trigger name in DB: `prospects_campaign_org_check` (not `check_prospect_campaign_org_match_trigger` — initial query name was wrong)
  - Enabled: 'O' (always on)
  - Function `check_prospect_campaign_org_match` body:
    ```sql
    BEGIN
      IF NEW.campaign_id IS NOT NULL THEN
        IF NOT EXISTS (
          SELECT 1 FROM public.campaigns
          WHERE id = NEW.campaign_id
            AND organisation_id = NEW.organisation_id
        ) THEN
          RAISE EXCEPTION 'prospect campaign_id % does not belong to organisation_id %',
            NEW.campaign_id, NEW.organisation_id
            USING ERRCODE = '23503';
        END IF;
      END IF;
      RETURN NEW;
    END;
    ```
  - Logic: NULL campaign_id allowed (short-circuit on line 1). Cross-org assignment blocked. Same-org assignment passes. Correct.
  - Trigger fires `BEFORE INSERT OR UPDATE OF campaign_id, organisation_id` — correct, no partial-update bypass.
- **Verdict:** PASS

---

### Section 1.5 — Trigger live test
- **Checked:** Attempted UPDATE of real prospect (`0e62da2b`) to campaign UUID `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee` (non-existent, simulates cross-org: no campaigns row with that UUID and the prospect's org_id exists)
- **Found:** DB returned error immediately:
  ```
  ERROR: 23503: prospect campaign_id aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee does not belong to
  organisation_id 74243c62-f42d-4f3f-b93e-bd5e51f0b6c0
  CONTEXT: PL/pgSQL function check_prospect_campaign_org_match() line 10 at RAISE
  ```
  Trigger fired correctly. Transaction was rolled back (no data persisted).
- **Note:** Only one organisation exists in the DB at time of audit, so a true two-org cross-org test was not possible. The test exercises the same code path (no matching campaign in the prospect's org). The function body logic for a genuine cross-org scenario is identical.
- **Verdict:** PASS (with caveat: full two-org scenario untestable at pre-c0 stage)

---

### Section 1.6 — P0 fixes: REVOKE EXECUTE on approve_document_suggestion + append_faq_variant
- **Checked:** `has_function_privilege('anon', ..., 'EXECUTE')` and `proacl` for both functions; Supabase security advisor
- **Found:**
  ```
  approve_document_suggestion: anon_can_execute=true, auth_can_execute=true, proacl={=X/postgres,...}
  append_faq_variant:          anon_can_execute=true, auth_can_execute=true, proacl={=X/postgres,...}
  ```
  `=X/postgres` means PUBLIC still has EXECUTE. Revoking from `anon` and `authenticated` individually does NOT remove a PUBLIC-based grant in Postgres. The REVOKE statements in the migration targeted the wrong granteees. Both functions remain callable via `/rest/v1/rpc/approve_document_suggestion` and `/rest/v1/rpc/append_faq_variant` without authentication.

  Supabase security advisor confirms both as active `anon_security_definer_function_executable` warnings.

  **The correct fix is:** `REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC;`
- **Verdict:** FAIL
- **Recommendation:** New migration to fix both functions:
  ```sql
  REVOKE EXECUTE ON FUNCTION public.approve_document_suggestion(uuid, uuid) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.append_faq_variant(uuid, text) FROM PUBLIC;
  ```

---

### Section 1.7 — P1 fixes: REVOKE EXECUTE on trigger functions + integration_credentials RLS
- **Checked:** `has_function_privilege` and `proacl` for handle_new_auth_user, handle_new_user, rls_auto_enable; RLS state on integration_credentials
- **Found:**
  ```
  handle_new_auth_user: anon_can_execute=true, proacl={=X/postgres,...}
  handle_new_user:      anon_can_execute=true, proacl={=X/postgres,...}
  rls_auto_enable:      anon_can_execute=true, proacl={=X/postgres,...}
  ```
  Same root cause as 1.6: REVOKE FROM anon/authenticated doesn't remove a PUBLIC grant.

  **Integration credentials RLS:** `relrowsecurity=true` (RLS enabled). Policies applied correctly:
  - `clients_cannot_access_credentials`: ALL, USING false — blanket deny
  - `operators_read_credentials`: SELECT, USING is_operator()
  - `operators_manage_credentials`: ALL, USING is_operator(), WITH CHECK is_operator()

  The credential table itself is secured. Only the function REVOKEs failed.
- **Verdict:** FAIL (REVOKE ineffective) / PASS (integration_credentials RLS correct)
- **Recommendation:** New migration:
  ```sql
  REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC;
  ```

---

### Section 1.8 — get_advisors
- **Checked:** Security and performance advisors
- **Found (security — directly related to Prompt 3A):**
  - `anon_security_definer_function_executable`: `approve_document_suggestion` and `append_faq_variant` — active (confirms 1.6 FAIL)
  - `anon_security_definer_function_executable`: `handle_new_auth_user`, `handle_new_user`, `rls_auto_enable` — active (confirms 1.7 FAIL)
  - `authenticated_security_definer_function_executable`: same five functions — active (same root cause)
  - `function_search_path_mutable` on `append_faq_variant` — pre-existing; separate BACKLOG entry at line 1714
- **Found (performance — related to Prompt 3A):**
  - `campaigns_organisation_id_fkey without covering index` — this appears in the performance advisor. This FK was pre-existing on the campaigns table (not introduced by Prompt 3A), but is now more relevant because our campaign registration code queries and inserts into campaigns. Not blocking but worth noting.
- **Found (pre-existing, not Prompt 3A):** `security_definer_view` on client_organisation_view, `function_search_path_mutable` on set_updated_at, `extension_in_public` on pg_net, `get_my_organisation_id` and `is_operator` SECURITY DEFINER callable by anon — all pre-existing.
- **Verdict:** FAIL (new advisory findings from 1.6/1.7 are unresolved); NEEDS REVIEW (campaigns FK index)

---

### Section 1.9 — database.ts types match migrations
- **Checked:** `grep` for all five new prospects columns and campaigns.name in database.ts
- **Found:**
  ```
  prospects Row:    campaign_id: string | null             ✓
  prospects Row:    outbound_lead_id: string | null        ✓
  prospects Row:    outbound_upload_attempted_at: string | null  ✓
  prospects Row:    outbound_upload_error: string | null   ✓
  prospects Row:    outbound_upload_status: string         ✓
  campaigns Row:    name: string | null                    ✓
  ```
  All Insert/Update variants also present.
- **Verdict:** PASS

---

## Section 2 — String-Match Wiring

### Section 2.1 — getInstantlyApiKey call sites
- **Checked:** `grep -rn "getInstantlyApiKey" src/`
- **Found:**
  ```
  src/lib/integrations/handlers/instantly/auth.ts:11       — definition (export)
  src/lib/integrations/handlers/instantly/validateCampaign.ts:22,23 — dynamic import + call
  src/app/api/cron/instantly-poll/route.ts:32,64            — static import + call
  src/app/api/cron/process-replies/route.ts:19,51           — static import + call
  src/lib/reply-handling/send-approved-draft.ts:25,188      — static import + call
  ```
  All call sites correctly use the helper. No remaining inline DB queries for the credential.
- **Note:** `validateCampaign.ts` uses `await import('./auth')` (dynamic import) rather than a static import at the top. This is unnecessary — there is no circular dependency and the file is not a React Server Component that would require it. The dynamic import adds async overhead on the first call and is confusing. Low severity.
- **Verdict:** PASS (wiring correct) / NEEDS REVIEW (dynamic import in validateCampaign.ts)

---

### Section 2.2 — INSTANTLY_API_KEY env var
- **Checked:** `grep -rn "INSTANTLY_API_KEY" src/`; `vercel env ls`
- **Found:** Zero occurrences in current source code. Not present in Vercel env vars (Production or Preview). The broken call site was correctly removed in Commit 4.
- **Verdict:** PASS

---

### Section 2.3 — Capability name scope
- **Checked:** `grep -rn "can_upload_leads\|can_order_mailboxes" src/ supabase/`
- **Found:** Both capability names appear only in `supabase/migrations/20260521132309_capability_registry_slots.sql`. No application code currently references them — correct, as handlers are not yet built.
- **Verdict:** PASS

---

### Section 2.4 — validateCampaign import path
- **Checked:** `actions.ts:5`; call site at `actions.ts:89`
- **Found:**
  ```typescript
  // actions.ts:5
  import { validateCampaign } from '@/lib/integrations/handlers/instantly/validateCampaign'
  // actions.ts:89
  const result = await validateCampaign(orgId, campaignUuid)
  ```
  Static import path is correct. Call site passes `orgId` (from the page's DB fetch) and the operator-supplied UUID.
- **Verdict:** PASS

---

## Section 3 — Auth and Route Behaviour

### Section 3.1 — Detail page three-check auth pattern
- **Checked:** `src/app/dashboard/operator/clients/[id]/page.tsx` full read
- **Found:**
  - Check 1 (authenticated): `getUser()` → `if (!user) redirect('/login')` ✓
  - Check 2 (operator role): `users.role` query → `if (role !== 'operator') redirect('/dashboard')` ✓
  - Check 3 (org exists): `.maybeSingle()` → `if (!org) notFound()` ✓
  - **Spec deviation:** The spec said "Returns 404 if the client_id doesn't exist OR if the requester isn't an operator (identical response, no info leak)." The implementation returns `redirect('/dashboard')` for non-operators (check 2), not `notFound()`.
  - In practice this is safe: `layout.tsx` already redirects non-operators before the page renders. The page's own check is belt-and-braces. The info-leak concern (operator probing org UUIDs) is handled by `notFound()` on check 3.
  - However: the comment in the code at line 40 claims "notFound() for both missing org and non-operator" which is inaccurate.
- **Verdict:** NEEDS REVIEW (spec deviation; functionally safe; inaccurate code comment)

---

### Section 3.2 — updateSetupStatus server-side validation
- **Checked:** `src/app/dashboard/operator/clients/[id]/actions.ts` lines 10–51
- **Found:** The function signature accepts `SetupStatusField` and `SetupStatusValue` TypeScript types, but there is no runtime validation of these parameters. Server Actions are HTTP endpoints — TypeScript types are erased at runtime. An operator using browser DevTools could POST `{field: "arbitrary_key", value: "bogus"}` and write `setup_status.arbitrary_key = "bogus"` to the organisations row.

  The current merge logic is `{ ...current, [field]: value }` — it writes whatever field/value is given.

  Mitigating factors: (1) operator-only (three-check auth gate), (2) setup_status is a JSON metadata field with no downstream enforcement or DB-level constraint, (3) the impact is cosmetic — wrong values simply won't match the UI's three-value display logic and will be ignored.
- **Verdict:** NEEDS REVIEW (missing server-side allowlist validation; low risk given operator-only, but hardening is correct practice)

---

### Section 3.3 — Campaign registration flow
- **Checked:** `src/app/dashboard/operator/clients/[id]/actions.ts` lines 59–147
- **Found:**
  - Duplicate check BEFORE Instantly API call: lines 77–86 query `campaigns.external_id` for the org ✓
  - Two-step flow (validate then confirm): `checkCampaign` returns info for display; `registerCampaign` does the insert ✓
  - `organisation_id` in the INSERT comes from the `orgId` parameter passed from the server-rendered page, which fetched it from the DB using the authenticated session ✓
  - `campaign_type: 'cold_email'`, `status: 'draft'` ✓
  - Race condition guard: final duplicate check at start of `registerCampaign` before INSERT ✓
  - Note: `orgId` is a parameter accepted from the client component. An operator with DevTools could substitute a different org UUID. Since operators have cross-org access (ADR-021), this is acceptable and consistent with the existing operator permission model.
- **Verdict:** PASS

---

### Section 3.4 — Invalid/missing [id] parameter handling
- **Checked:** `page.tsx` params handling and org fetch
- **Found:** `params` is `await`-ed (correct for Next.js 16 where params is a Promise). The org fetch uses `.maybeSingle()` and `if (!org) notFound()`. If `id` is a malformed UUID, Supabase/PostgREST will return `{ data: null }` (UUID parse error at DB level → null data). The `if (!org)` guard catches this and calls `notFound()`. The `error` return value is not destructured or logged, which means UUID format errors are silently swallowed rather than logged.
- **Verdict:** PASS (correct behaviour) / minor note: UUID parse errors not logged

---

## Section 4 — Sentry and Silent Failures

### Section 4.1 — writeSignal Sentry placement
- **Checked:** `src/lib/integrations/polling/instantly.ts` lines 263–281
- **Found:**
  ```typescript
  // line 263: skip idempotency hits
  if (error.code === '23505') return 'skipped'

  // line 270 comment: No flush here — inside a polling loop
  Sentry.captureException(                         // line 271 — BEFORE logger.error ✓
    new Error(`Signal write failed [${params.signal_type}] (${error.code}): ${error.message}`),
    { level: 'warning', extra: { signal_type: ..., external_event_id: ..., code: error.code } }
  )
  logger.error('Instantly poll: failed to write signal', { ... })   // line 275 — AFTER ✓
  return 'error'
  ```
  - Sentry fires BEFORE logger.error ✓
  - Error message format matches approved spec: `Signal write failed [signal_type] (code): message` ✓
  - `level: 'warning'` set ✓
  - No `await` on Sentry (correct — no blocking in polling loop) ✓
  - Comment explains the deliberate no-flush decision ✓
- **Verdict:** PASS

---

### Section 4.2 — Recent Sentry issues
- **Checked:** `mcp__sentry__search_issues` for `firstSeen:-1h` against `margentic-os` org
- **Found:** Zero issues in the last hour. No new error patterns from Prompt 3A.
- **Verdict:** PASS

---

## Section 5 — Backlog Hygiene

### Section 5.1 — Prompt 3A BACKLOG entries
- **Checked:** `grep` for Prompt 3A tags in BACKLOG.md; read entries at lines 1720–1745
- **Found:**
  - `[DONE 2026-05-21]` entry at line 1720: `send-approved-draft.ts used process.env.INSTANTLY_API_KEY` — documents the broken env-var, the fix in Commit 4, and the lesson. ✓
  - `[post-c0-polish]` at line 1730: `integrations_registry api_handler_ref paths wrong in all 7 existing rows` — notes that existing rows use wrong paths, new rows use correct paths. ✓
  - `[post-c0-polish]` at line 1738: `Operator nav-context drop on intra-page navigation` — deferred with rationale and severity assessment. ✓
- **Verdict:** PASS

---

### Section 5.2 — signals_signal_type_check DONE entry
- **Checked:** BACKLOG.md line 1244
- **Found:**
  ```
  - [DONE 2026-05-02] signals_signal_type_check constraint does not include 'reply_received'
    RESOLVED. Migration 20260502163646_signals_signal_type_constraint applied 2026-05-02.
    ...Verified live DB 2026-05-21 as part of Prompt 3A pre-build check.
  ```
  Correctly marked DONE with date and verification note.
- **Verdict:** PASS

---

## Section 6 — Vercel Env Var Cleanup

### Section 6.1 — INSTANTLY_API_KEY in Vercel
- **Checked:** `vercel env ls` (full output reviewed)
- **Found:** `INSTANTLY_API_KEY` does NOT appear in Production or Preview environments. Confirmed the code was broken — the env var was never set, and `send-approved-draft.ts` would have returned `send_failed` on every real call before Commit 4.
- **Verdict:** PASS (no orphaned env var to clean up; the fix in Commit 4 was necessary)

---

### Section 6.2 — Env var completeness
- **Checked:** Full `vercel env ls` output; all new code in Prompt 3A reviewed for env var dependencies
- **Found:** Prompt 3A code uses only:
  - `NEXT_PUBLIC_SUPABASE_URL` — set in both Production and Preview ✓
  - `SUPABASE_SERVICE_ROLE_KEY` — set in both Production and Preview ✓
  No new env vars required.
- **Note:** `NEXT_PUBLIC_APP_URL` is set only in Production, not Preview — pre-existing gap (not introduced by Prompt 3A).
- **Verdict:** PASS

---

## Section 7 — Typecheck and Build

### Section 7.1 — TypeScript
- **Checked:** `npx tsc --noEmit`
- **Found:** No output (zero errors).
- **Verdict:** PASS

---

### Section 7.2 — Build
- **Checked:** `npm run build`
- **Found:** Build completed successfully. `/dashboard/operator/clients/[id]` appears in the route list as a dynamic server-rendered route. Zero errors or warnings from the build.
- **Verdict:** PASS

---

## Section 8 — Prompt 3B Readiness

### Section 8.1 — Registry slots queryable
- **Checked:** `SELECT capability, tool_name, is_active, api_handler_ref FROM integrations_registry WHERE capability IN ('can_upload_leads','can_order_mailboxes')`
- **Found:**
  ```
  can_order_mailboxes | instantly | false | src/lib/integrations/handlers/instantly/dfy
  can_upload_leads    | instantly | false | src/lib/integrations/handlers/instantly/leads
  ```
  Both rows exist, `is_active=false`, correct `api_handler_ref` paths using the integrations layer.
- **Verdict:** PASS

---

### Section 8.2 — outbound_upload_status CHECK constraint covers all Prompt 3B values
- **Checked:** CHECK constraint confirmed in 1.2
- **Found:** `ARRAY['pending', 'uploading', 'uploaded', 'failed']` — all four values that Prompt 3B's upload handler will write are present.
- **Verdict:** PASS

---

### Section 8.3 — campaign_id FK + trigger compatibility
- **Checked:** Trigger function body (1.4) and FK definition (1.2)
- **Found:** `prospects.campaign_id` FK is `ON DELETE SET NULL` — if a campaign is deleted, prospects are automatically unlinked (not orphaned). Trigger checks cross-org assignment on INSERT or UPDATE of `campaign_id`. Prompt 3B's upload handler will set `campaign_id` on prospects — the trigger will enforce same-org integrity for those writes automatically.
- **Verdict:** PASS

---

## Section 9 — Assumptions and Worries

### Section 9.1 — Assumptions made during Prompt 3A

| Assumption | Confidence | Status |
|---|---|---|
| REVOKE FROM anon/authenticated removes execute access | High (at time) | **WRONG** — PUBLIC grant requires `REVOKE FROM PUBLIC` |
| organisations.slug is nullable | Medium | **WRONG** — slug is NOT NULL, trigger test setup required redesign |
| Three active call sites for getInstantlyApiKey (spec said "6+") | High | Confirmed correct — spec overestimated; only 3 existed |
| setup_status is a free-form JSON with no DB constraint | High | Confirmed correct |
| campaigns.name is distinct from sequence_name | High | Confirmed — sequence_name is Instantly's internal identifier, name is the human-readable label |
| Dynamic import in validateCampaign.ts would not cause build issues | High | Correct, but the pattern is unnecessary and should be a static import |

---

### Section 9.2 — Spec interpreted vs taken literally

1. **Non-operator on detail page → notFound() vs redirect:** Spec said "Returns 404 if the client_id doesn't exist OR if the requester isn't an operator." Implemented `redirect('/dashboard')` for non-operators at the page level, not `notFound()`. Interpreted the spec as specifying the external security behaviour (no info leak), not the exact HTTP response type. The layout catches non-operators first anyway, so the page check is belt-and-braces.

2. **Server-side validation of setup_status:** Spec did not mention runtime validation of field/value parameters in the server action. Implemented TypeScript types only, not runtime allowlist checks. This is a reasonable omission given the operator-only scope, but hardening is correct practice.

3. **Trigger test:** Spec said "try to UPDATE a prospect to assign it to a campaign from a different org." Performed the test with a non-existent campaign UUID (no campaigns from other orgs available at pre-c0 stage). The same code path is exercised — trigger fires whenever no matching (campaign_id, organisation_id) pair exists.

---

### Section 9.3 — Things that worked first-try and felt suspicious

1. **P0/P1 REVOKEs appeared to apply cleanly** — no DB errors from the migration, so the statements were syntactically valid. The flaw (wrong grantee) was silent. This is exactly the kind of thing that passes CI and looks shipped but doesn't work. The advisory tool caught it.

2. **TypeScript typed the PanelState union correctly on first attempt** — the `CampaignRegistrationPanel` required a rewrite on the second pass (TypeScript errors on unreachable union branches), which is healthy. What felt suspicious: the `registering` phase initially missing `status`/`schedulingStatus` fields. Caught by tsc.

3. **The trigger fired correctly in the live test** — but the test design (non-existent UUID) is equivalent to the cross-org case, not truly a two-org isolation test. The trigger is correct, but this should be re-tested when a second client org exists.

---

### Section 9.4 — send-approved-draft.ts: was the env var actually broken?

**Confirmed broken.** The original code (pre-Commit 4) was:
```typescript
const instantlyApiKey = process.env.INSTANTLY_API_KEY
```
`vercel env ls` confirmed `INSTANTLY_API_KEY` is not set in Vercel Production or Preview — it was never configured. The next line (not shown here but in the original) would have thrown or passed an empty string to the Instantly API, causing every reply send to fail with an auth error. This went undetected because no live campaign has yet produced real reply_received signals — there were no real paths through `sendApprovedDraft` in production.

The Commit 4 fix unified the credential source with the two cron routes (DB-based, consistent) and added proper error handling with `markSendFailed` on credential load failure.

---

## Summary

### Counts
- **PASS:** 26
- **FAIL:** 2
- **NEEDS REVIEW:** 5

### Prioritised FAIL list

| Priority | Finding | Section | Severity |
|---|---|---|---|
| P0 | REVOKE on approve_document_suggestion + append_faq_variant was FROM anon/authenticated, not FROM PUBLIC. Both functions remain callable by unauthenticated users via /rest/v1/rpc/. `approve_document_suggestion` has `SET row_security TO 'off'` — a genuine attack surface. | 1.6 | **CRITICAL** |
| P1 | REVOKE on handle_new_auth_user, handle_new_user, rls_auto_enable was FROM anon/authenticated, not FROM PUBLIC. All three remain callable via /rest/v1/rpc/ without authentication. | 1.7 | **HIGH** |

### NEEDS REVIEW list

| Finding | Section | Disposition |
|---|---|---|
| Non-operator on detail page redirects to /dashboard instead of notFound() | 3.1 | Functionally safe (layout catches first). Fix the comment, optionally change to notFound(). |
| updateSetupStatus has no runtime validation of field/value params | 3.2 | Low risk (operator-only, cosmetic impact). Add allowlist before any client-facing exposure. |
| Dynamic import in validateCampaign.ts for getInstantlyApiKey | 2.1 | Unnecessary. Change to static import. |
| campaigns_organisation_id_fkey has no covering index (performance advisor) | 1.8 | Not urgent. Add index when campaign query volume justifies it. |
| Trigger test was non-existent UUID, not true two-org cross-org scenario | 1.5 | Re-test when second client org exists. |

---

## Manual Actions Required Before Push and During Smoke Test

### Before push (blocking)

1. **Fix P0/P1 REVOKEs — new migration required**
   - **What:** New migration with `REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC` for all five functions
   - **Why:** Current REVOKEs targeted wrong grantee. All five SECURITY DEFINER functions remain accessible to anon via the REST API. `approve_document_suggestion` with `SET row_security TO 'off'` is the most dangerous.
   - **Failure mode if skipped:** Unauthenticated users can approve document suggestions (which have `row_security TO 'off'`, bypassing RLS) and call auth trigger functions via REST. This is a genuine attack surface that ships to production.
   - **Can MCP automate it:** Yes — `mcp__supabase__apply_migration` with the correct REVOKE SQL. Then rename local file to match DB timestamp.

### Before push (non-blocking, but strongly recommended)

2. **Fix dynamic import in validateCampaign.ts**
   - **What:** Change `const { getInstantlyApiKey } = await import('./auth')` to `import { getInstantlyApiKey } from './auth'` (static import at top of file)
   - **Why:** Unnecessary async overhead; confusing pattern when all other call sites use static imports
   - **Failure mode if skipped:** Functions correctly but is misleading. Cold-call overhead on first validateCampaign call.
   - **Can MCP automate it:** No — direct file edit.

3. **Fix inaccurate code comment in page.tsx:40**
   - **What:** The comment `// notFound() for both missing org and non-operator (no info leak)` is inaccurate — non-operators get `redirect('/dashboard')`, not `notFound()`
   - **Why:** Misleading comment for future readers
   - **Failure mode if skipped:** Cosmetic only.
   - **Can MCP automate it:** No — direct file edit.

### During smoke test (after push)

4. **Verify /rest/v1/rpc/ access blocked after P0/P1 fix migration**
   - **What:** After applying the FROM PUBLIC REVOKE migration, confirm `has_function_privilege('anon', ..., 'EXECUTE')` returns false for all five functions
   - **Why:** Verifies the fix actually worked (the original REVOKEs looked valid but didn't)
   - **Failure mode if skipped:** Shipped the security fix but it silently didn't apply again
   - **Can MCP automate it:** Yes — re-run the `has_function_privilege` query from section 1.6

5. **Register MargenticOS's own campaign via the new UI**
   - **What:** Navigate to /dashboard/operator/clients/[MargenticOS-org-id], enter the Instantly campaign UUID, validate, confirm registration
   - **Why:** First live test of the campaign registration flow end-to-end (Instantly API → DB insert → UI success state)
   - **Failure mode if skipped:** The form has never been exercised against the live Instantly API; could fail on an unexpected response shape
   - **Can MCP automate it:** No — requires browser and live Instantly credentials

6. **Set setup_status on MargenticOS client row**
   - **What:** Toggle campaigns and linkedin status in the new Setup Status panel on the detail page
   - **Why:** Verifies optimistic UI, server action, and DB write work together
   - **Failure mode if skipped:** UI could render but DB writes could silently fail
   - **Can MCP automate it:** No — browser test

7. **Verify AllClientsView shows both View and Manage buttons**
   - **What:** Navigate to /dashboard/operator and confirm each client row has both buttons; confirm Manage links to /dashboard/operator/clients/[id]
   - **Why:** Simple regression check on the AllClientsView edit
   - **Failure mode if skipped:** Manage button missing or pointing to wrong route
   - **Can MCP automate it:** No — browser test
