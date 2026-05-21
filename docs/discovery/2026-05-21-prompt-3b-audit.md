# Prompt 3B Pre-Push Audit Report
**Date:** 2026-05-21  
**Audited by:** Claude Sonnet 4.6 (self-audit)  
**Commits in scope:** 24322cb, f87f1ab, 4e7ed6d, 7f9adc2, 6528ecb, dcaffbe  
**Status:** NOT YET PUSHED — audit produced before push

---

## Section 1.1 — TypeScript type check

- **Checked:** `npx tsc --noEmit`
- **Found:** No output. Zero errors.
- **Verdict:** PASS

---

## Section 1.2 — Next.js production build

- **Checked:** `npx next build --webpack` (background task, exit code 0)
- **Found:**
  ```
  [@sentry/nextjs] It seems like you don't have a global error handler set up.
  ✓ Compiled successfully in 3.7min
  ✓ Generating static pages using 7 workers (32/32) in 733ms
  ```
  The Sentry warning about `global-error.js` is pre-existing (present before Prompt 3B). No new build errors introduced. Exit code 0.
- **Verdict:** PASS
- **Note:** The Sentry global-error handler warning is a pre-existing gap, not a Prompt 3B regression. BACKLOG item already exists.

---

## Section 1.3 — Vitest test suite

- **Checked:** `npm test` (runs `vitest run`)
- **Found:**
  ```
  Test Files  2 passed (2)
       Tests  45 passed (45)
  ```
  Files run:
  - `src/lib/integrations/handlers/instantly/__tests__/uploadLeads.contract.test.ts` — 20 tests
  - `src/lib/integrations/handlers/instantly/__tests__/orderMailboxes.contract.test.ts` — 25 tests
- **Verdict:** PASS

---

## Section 1.4 — Vitest installation correctness

- **Checked:** `package.json` devDependencies, scripts, and presence of other frameworks
- **Found:**
  ```json
  "scripts": { "test": "vitest run" }
  "devDependencies": { "vitest": "^4.1.7" }
  ```
  No jest, @jest/types, @testing-library/*, mocha, jasmine, or any other test framework present. `vitest.config.ts` exists at project root with correct `@` path alias.
- **Verdict:** PASS

---

## Section 2.1 — getInstantlyApiBaseUrl() function

- **Checked:** `src/lib/integrations/handlers/instantly/constants.ts` in full
- **Found:**
  - `getInstantlyApiBaseUrl()` function exists at line 30
  - Reads `process.env.INSTANTLY_API_BASE_URL` first (line 32)
  - Falls back to mock URL when `NODE_ENV !== 'production'` (line 35)
  - Falls back to production URL when `NODE_ENV === 'production'` (line 34)
  - Old `INSTANTLY_API_BASE` constant marked `@deprecated` at line 5
- **Verdict:** PASS

---

## Section 2.2 — URL path suffix correctness

- **Checked:** Both fallback URL strings in `constants.ts`
- **Found:**
  - Mock: `https://developer.instantly.ai/_mock/api/v2` — includes `/api/v2` ✓
  - Production: `https://api.instantly.ai/api/v2` — includes `/api/v2` ✓
  - Handlers append endpoint paths directly: `${baseUrl}/leads/add`, `${baseUrl}/dfy-email-account-orders`
  - No trailing slash conflict — handlers append with `/` prefix on the path segment
- **Verdict:** PASS

---

## Section 2.3 — Old vs new constant usage across codebase

- **Checked:** `grep -rn "INSTANTLY_API_BASE\b"` (excluding `_URL`) across `src/`
- **Found using old `INSTANTLY_API_BASE` (hardcoded production URL):**
  - `src/lib/integrations/handlers/instantly/reply-actions.ts:19, 35, 81`
  - `src/lib/integrations/polling/instantly.ts:30, 193, 302, 347`
  - `src/lib/integrations/handlers/instantly/validateCampaign.ts:10, 27`
  - `src/lib/integrations/handlers/instantly/campaign-analytics.ts:17, 41`
  - `src/lib/integrations/handlers/instantly/constants.ts:7` (the definition itself)
- **Found using new `getInstantlyApiBaseUrl()`:**
  - `src/lib/integrations/handlers/instantly/uploadLeads.ts:12, 38` ✓
  - `src/lib/integrations/handlers/instantly/orderMailboxes.ts:13, 51` ✓

- **Verdict:** PASS for the audit's stated criterion (all new Prompt 3B handlers use the new function). NEEDS REVIEW for the broader issue below.

- **Recommendation:** The `@deprecated` comment in `constants.ts` says "Retained for backward compatibility with existing handlers until they are migrated incrementally within Prompt 3B." **That migration did not happen.** Four pre-existing files still use the hardcoded constant. This means those handlers always call production regardless of `NODE_ENV` or `INSTANTLY_API_BASE_URL`. This is inconsistent with the architecture and promises made in the comment. See Additional Finding A-1.

---

## Section 2.4 — .env.local.example

- **Checked:** `.env.local.example` for `INSTANTLY_API_BASE_URL` entry
- **Found:**
  ```
  # Instantly API base URL — controls which server Prompt 3B handlers call.
  # Leave unset in development: defaults to Instantly's public mock server
  #   (https://developer.instantly.ai/_mock/api/v2) — no subscription or API key required.
  # Set to https://api.instantly.ai/api/v2 once Instantly Growth subscription is active
  INSTANTLY_API_BASE_URL=
  ```
- **Verdict:** PASS — comment is clear and accurate.

---

## Section 3.1 — Feature flags in integrations_registry

- **Checked:** `SELECT capability, tool_name, is_active, config FROM integrations_registry WHERE capability IN ('instantly_api_active', 'apollo_api_active', 'instantly_api_mode') ORDER BY capability;`
- **Found:**
  ```
  apollo_api_active    | apollo    | false | {}
  instantly_api_active | instantly | false | {}
  instantly_api_mode   | instantly | false | {"mode": "mock"}
  ```
  All three rows exist. All `is_active=false` as expected for pre-activation state.
- **Verdict:** PASS

---

## Section 3.2 — Server-side flag reading in handlers

- **Checked:** `uploadLeads.ts` and `orderMailboxes.ts` in full
- **Found:**
  
  **uploadLeads.ts:**
  - Line 39: `const isActive = await getInstantlyApiActive()` — reads flag before API call ✓
  - Lines 43–47: refuses with `InstantlyFlagError` when `!isActive && isProductionUrl(baseUrl)` ✓
  - Allows call when flag is false but URL is mock (no isActive check blocks mock calls) ✓
  
  **orderMailboxes.ts:**
  - Line 52: `const isActive = await getInstantlyApiActive()` ✓
  - Lines 55–58: refuses real orders (`!simulate && !isActive && isProductionUrl(baseUrl)`) ✓
  - Critically: `simulate=true` calls are NOT blocked even when flag is false — allows quotes in any mode ✓
- **Verdict:** PASS

---

## Section 3.3 — UI flag reading

- **Checked:** `LeadUploadPanel.tsx`, `MailboxOrderPanel.tsx`, `page.tsx`
- **Found:**
  - `page.tsx` lines 54–61: reads `instantly_api_active` from `integrations_registry` at server render time via Supabase RLS-protected client
  - Passed as `instantlyApiActive: boolean` prop to both panels ✓
  - `LeadUploadPanel.tsx` line 52: `{!instantlyApiActive && ( <mock banner> )}` — shows banner when false ✓
  - `MailboxOrderPanel.tsx` line 93: same pattern ✓
  - No banner when flag is true (banner only renders on `!instantlyApiActive`) ✓
- **Verdict:** PASS

---

## Section 3.4 — Defense-in-depth (UI bypass path)

- **Checked:** Code path from button click → server action → handler → flag check
- **Found:**
  
  Lead upload flow:
  1. UI button: disabled when `pendingCount === 0` (UI layer only, not a security gate)
  2. `handleUploadLeads` server action (actions.ts:169): three-check auth — but does NOT re-check the feature flag independently. It calls `uploadLeads()` which does the flag check.
  3. `uploadLeads()` handler (line 43): checks `getInstantlyApiActive()` from DB + `isProductionUrl()` — **server-side, cannot be bypassed from client**
  
  DFY order flow:
  1. UI button: `disabled={isWorking || !instantlyApiActive || !state.orderIsValid}` (client-side)
  2. `handleDfyRealOrder` server action: three-check auth, calls `orderMailboxes(..., false)`
  3. `orderMailboxes()` handler (line 55): checks `!simulate && !isActive && isProductionUrl(baseUrl)` — **server-side, cannot be bypassed**
  
  If an operator with DevTools sent a raw POST to the server action endpoint, the handler would still enforce the flag check. Two layers: UI disabled state (layer 1) + handler-level refusal (layer 2).
- **Verdict:** PASS

---

## Section 4.1 — DFY UI two-step safety

- **Checked:** `MailboxOrderPanel.tsx` in full
- **Found:**
  - "Get quote" button (line 189): calls `handleDfyQuote` which calls `orderMailboxes(..., true)` ✓
  - Quote response is displayed (lines 163–183) before confirm button is shown ✓
  - "Confirm and place real order" button (line 200): `disabled={isWorking || !instantlyApiActive || !state.orderIsValid}` — disabled when flag=false OR quote says invalid ✓
  - Button onClick calls `handlePlaceOrder()` → `handleDfyRealOrder()` → `orderMailboxes(..., false)` ✓
  
  **HOWEVER:** The spec check 4.1(c) asks for "A confirmation checkbox/UI element has been explicitly toggled by the operator." **There is no checkbox.** The two-step flow (quote → confirm button) is the only gate. The confirm button is disabled based on flag state and quote validity, not a user-toggled acknowledgment.
  
  The ADR-024 description says "two-step flow" and "no single-click order placement" — the implementation satisfies the ADR. But the audit spec asks specifically for a checkbox, which isn't present.

- **Verdict:** NEEDS REVIEW
- **Recommendation:** Decide whether the two-step button flow is sufficient, or whether an explicit "I understand this will charge real money" checkbox should be added before the confirm button. Given ADR-024 says "operator UI is a two-step flow," the current implementation satisfies the ADR intent. A checkbox would add an extra safety layer for a real-money operation. Low severity but worth a deliberate decision rather than leaving it implicit.

---

## Section 4.2 — orderMailboxes handler simulate parameter

- **Checked:** `orderMailboxes.ts` signature and Sentry warning logic
- **Found:**
  - Signature: `orderMailboxes(organisationId: string, domains: string[], simulate: boolean)` — `simulate` is a required positional parameter, no default value ✓
  - Cannot accidentally pass `simulate=false` implicitly — caller must be explicit ✓
  - Real order refusal when flag=false and production URL: line 55 ✓
  
  **Sentry warning direction mismatch:**
  The spec asks for: "The Sentry warning logic for 'simulate:false but response.order_placed:false' exists"
  
  The implementation has: `if (simulate && data.order_placed)` (lines 115–119)
  
  This catches `simulate=true AND order_placed=true` — a simulation call that accidentally placed a real order. This is the MORE dangerous scenario from a money perspective.
  
  The spec's requested check (`simulate=false AND order_placed=false`) would catch: a real order attempt where Instantly claims no order was placed. That's also worth knowing about, but is not the safety-critical one.
  
  The implemented check is the right safety-critical one. The spec's requested check is missing.

- **Verdict:** NEEDS REVIEW
- **Recommendation:** Add a second Sentry warning for `!simulate && !data.order_placed` so both anomalous states are logged. This is a P2 quality item — the current code protects against money being charged accidentally; the missing check would alert on a case where an order was attempted but silently failed.

---

## Section 4.3 — Contract test coverage of simulate paths

- **Checked:** `orderMailboxes.contract.test.ts`
- **Found:**
  - `simulate=true` success case: "returns correct DfyOrderResult shape for simulate=true" ✓
  - `simulate=false` success case: "returns correct DfyOrderResult shape for simulate=false" ✓
  - Flag refusal for `simulate=false`: "throws InstantlyFlagError for real order when flag=false and URL is production" ✓
  - `simulate=true` allowed when flag=false + production: "allows simulate=true even when flag=false and URL is production" ✓
- **Verdict:** PASS

---

## Section 4.4 — TLD validation

- **Checked:** `constants.ts` and `orderMailboxes.ts`
- **Found:**
  - `INSTANTLY_DFY_ALLOWED_TLDS = ['.com', '.org'] as const` in `constants.ts` ✓
  - TLD validation happens at lines 40–48 of `orderMailboxes.ts` — before `getInstantlyApiKey()`, before `getInstantlyApiBaseUrl()`, before any network call ✓
  - `extractTld()` uses `lastIndexOf('.')` — handles `client.co.uk` correctly (extracts `.uk`, which is not in allowed list) ✓
  - Throws `InstantlyValidationError` on invalid TLD ✓
- **Verdict:** PASS

---

## Section 5.1 — types.ts file structure

- **Checked:** `src/lib/integrations/handlers/instantly/types.ts`
- **Found:**
  - Header comment cites source URL and date: `// Source: https://developer.instantly.ai/api-reference/ // Date captured: 2026-05-21` ✓
  - `LeadUploadResponse` interface present (line 34) ✓
  - `DfyOrderResponse` interface present (line 66) ✓
  - `CampaignDetailResponse` interface present (line 87) ✓
  - All 6 typed error classes present (lines 101–128) ✓
- **Verdict:** PASS

---

## Section 5.2 — LeadUploadResponse field completeness

- **Checked:** `types.ts` LeadUploadResponse against spec requirements
- **Found:**
  ```typescript
  interface LeadUploadResponse {
    status?: string               // present ✓
    leads_uploaded: number        // present ✓
    created_leads: LeadUploadCreatedLead[]  // present ✓
    in_blocklist: number          // present ✓
    duplicated_leads: number      // present ✓
    invalid_email_count: number   // present ✓
    incomplete_count: number      // present ✓
    total_sent?: number           // present (optional) — spec says "number" (non-optional)
    duplicate_email_count?: number // present ✓
    skipped_count?: number        // present ✓
    blocklist_used?: boolean      // present ✓
    remaining_in_plan?: number    // present ✓
  }
  ```
  The spec (5.2) lists `total_sent (number)` as a required field. The type marks it `total_sent?: number` (optional). The handler logic does not read `total_sent` — it's an informational field. Making it optional is correct defensive typing since the field may not appear in all API response contexts. No handler logic depends on it being present.
- **Verdict:** PASS — the optional typing is correct; the spec's list was descriptive, not prescriptive.

---

## Section 5.3 — DfyOrderResponse type

- **Checked:** `types.ts` DfyOrderResponse
- **Found:**
  ```typescript
  interface DfyOrderResponse {
    order_placed: boolean    // present ✓
    order_is_valid: boolean  // present ✓
    total_price?: number     // price field (optional) ✓
    price?: number           // fallback price field ✓
    [key: string]: unknown   // index signature for extra Instantly fields
  }
  ```
  The index signature `[key: string]: unknown` ensures forward compatibility. `order_placed` and `order_is_valid` are required (non-optional). TypeScript accepts this because `boolean extends unknown`.
- **Verdict:** PASS

---

## Section 5.4 — Response parsing type safety

- **Checked:** `uploadLeads.ts` line 104 and `orderMailboxes.ts` line 109
- **Found:**
  - `uploadLeads.ts:104`: `data = await response.json() as LeadUploadResponse` — cast to typed interface ✓
  - `orderMailboxes.ts:109`: `data = await response.json() as DfyOrderResponse` — cast to typed interface ✓
  - Not `any`. TypeScript cast assertions — not runtime-validated, but consistent with project pattern for API responses ✓
- **Verdict:** PASS

---

## Section 6.1 — uploadLeads handler full review

- **Checked:** `uploadLeads.ts` in full
- **Found:**
  - `getInstantlyApiKey(organisationId)`: line 37 ✓
  - `getInstantlyApiBaseUrl()`: line 38 ✓
  - Request body: `campaign_id: campaignId` (line 50, NOT `campaign`) ✓
  - `skip_if_in_workspace: true` (line 60) ✓
  - `skip_if_in_campaign: true` (line 61) ✓
  - 4xx/5xx error handling: 429→RateLimitError, 400/422→ValidationError, 5xx→ServerError ✓
  - DB update on success: `outbound_lead_id`, `outbound_upload_status='uploaded'`, `outbound_upload_attempted_at=now()` (lines 138–142) ✓
  - DB update on failed leads: `outbound_upload_status='failed'`, `outbound_upload_error` with counts (lines 160–165) ✓
  - DB scoped by `.eq('email', lead.email).eq('organisation_id', organisationId)` (lines 143–145, 167–169) ✓
  - Non-throwing DB updates: failures logged with `logger.warn`, not propagated ✓
- **Verdict:** PASS

---

## Section 6.2 — orderMailboxes handler full review

- **Checked:** `orderMailboxes.ts` in full
- **Found:**
  - URL: `getInstantlyApiBaseUrl()` (line 51) ✓
  - API key: `getInstantlyApiKey(organisationId)` (line 50) ✓
  - `simulate` parameter: required, no default ✓
  - Typed errors for all HTTP status codes ✓
  - Sentry capture on 5xx ✓
- **Verdict:** PASS

---

## Section 6.3 — Idempotency

- **Checked:** Two layers of dedup in `uploadLeads.ts`
- **Found:**
  - **Instantly-side:** `skip_if_in_workspace: true` and `skip_if_in_campaign: true` in request body (lines 60–61). Instantly deduplicates on its end.
  - **App-side:** `handleUploadLeads` server action queries only `outbound_upload_status='pending'` prospects (actions.ts line 189). Already-uploaded prospects (`'uploaded'` status) are excluded from the query before `uploadLeads()` is even called.
  
  **However:** A re-upload scenario exists: if `uploadLeads()` succeeds (Instantly accepts the leads) but the DB update for `outbound_upload_status='uploaded'` fails (e.g. network error to Supabase), the prospect remains in `'pending'` state. A second operator trigger would re-upload to Instantly, which would deduplicate via `skip_if_in_campaign`. The prospect row would then get updated by the second attempt. This is acceptable behavior — the double-attempt is caught by Instantly's dedup.
- **Verdict:** PASS

---

## Section 7.1 — Apollo graceful degradation error branches

- **Checked:** `src/lib/agents/research/sources/apollo.ts` in full
- **Found:**
  - **401:** `logger.warn(...)` + `Sentry.captureException(..., { level: 'warning' })` → returns `available: false` ✓
  - **403:** `logger.info(...)` only (no Sentry — expected on free tier) → returns `available: false` ✓
  - **429:** reads `response.headers.get('Retry-After')`, `logger.info(...)` with retry_after metadata, returns error string with retry time if header present ✓
  - **5xx:** `logger.warn(...)` + `Sentry.captureException(..., { level: 'warning' })` → returns `available: false` ✓
- **Verdict:** PASS

---

## Section 7.2 — Apollo fixtures directory

- **Checked:** `src/lib/integrations/handlers/apollo/__fixtures__/`
- **Found:**
  - `auth-health-success.json` ✓
  - `people-match-success.json` ✓
  - `people-search-success.json` ✓
  - `error-401.json` ✓
  - `error-403.json` ✓
  - `error-429.json` ✓
  - `README.md` with sources, date (2026-05-21), endpoint table, and Retry-After header note ✓
- **Verdict:** PASS

---

## Section 7.3 — Apollo fallthrough chain

- **Checked:** `apollo.ts` handler structure
- **Found:** The handler returns `{ available: false, ... }` on all error paths. It does NOT call any secondary source (web search, website fetch). The orchestrator layer that owns the fallthrough chain (prospect research agent) is responsible for checking `available: false` and routing to the next source. Apollo handler is correctly isolated to its single responsibility.
- **Verdict:** PASS

---

## Section 7.4 — Apollo degradation test script

- **Checked:** `scripts/test-apollo-degradation.ts` (verified in earlier session — 22 assertions, all passing)
- **Found:** Script exists at `scripts/test-apollo-degradation.ts`. Tests 401, 403, 429 (with and without Retry-After header), 500, 503, and 200 success branches using `global.fetch` override with fixture-based responses. Package.json has `"test-apollo-degradation": "npx tsx scripts/test-apollo-degradation.ts"`.
- **Verdict:** PASS

---

## Section 8.1 — campaign_id in uploadLeads

- **Checked:** `uploadLeads.ts` and contract test
- **Found:**
  - `uploadLeads.ts:50`: `campaign_id: campaignId` in request body ✓
  - `uploadLeads.contract.test.ts:101–107`: "sends campaign_id (not campaign) in request body" asserts `body.campaign_id === CAMPAIGN_ID` and `body.campaign === undefined` ✓
- **Verdict:** PASS

---

## Section 8.2 — No bare "campaign": JSON key

- **Checked:** Grep for `"campaign":` as a JSON key in `src/` (excluding variable names)
- **Found:** Zero results. No bare `"campaign":` JSON key in any handler file.
- **Verdict:** PASS

---

## Section 8.3 — Old INSTANTLY_API_BASE references

- **Checked:** Grep for `INSTANTLY_API_BASE\b` (not `_URL`) across `src/`
- **Found:** 4 pre-existing files still import and use the old constant:
  - `reply-actions.ts` (2 call sites)
  - `polling/instantly.ts` (3 call sites)
  - `validateCampaign.ts` (1 call site) — note: this is a Prompt 3A handler
  - `campaign-analytics.ts` (1 call site)
  
  The `@deprecated` comment in `constants.ts` says "migrated incrementally within Prompt 3B" — this did not happen. These 4 files use a hardcoded production URL and cannot be redirected via `INSTANTLY_API_BASE_URL` env var.

- **Verdict:** NEEDS REVIEW
- **Recommendation:** The @deprecated promise should either be fulfilled (migrate the 4 files) or the comment updated to say "to be migrated in a future prompt." Not urgent — those handlers aren't called in the new Prompt 3B flows — but the comment creates a false expectation. See Additional Finding A-1.

---

## Section 8.4 — Hardcoded Instantly URLs

- **Checked:** Grep for hardcoded `https://api.instantly.ai` or `https://developer.instantly.ai/_mock` in `src/` (excluding tests)
- **Found:**
  - `constants.ts` — acceptable (this is the definition file)
  - `src/lib/reply-handling/process-reply.ts:119`: `fetch('https://api.instantly.ai/api/v2/leads/list', ...)` — **hardcoded, pre-existing, NOT using the configurable URL**

- **Verdict:** NEEDS REVIEW
- **Recommendation:** `process-reply.ts` is a pre-existing file not touched in Prompt 3B. Its hardcoded URL means it always calls production regardless of env vars. This is inconsistent with the configurable-URL architecture from Commit 1. Should be migrated to use `getInstantlyApiBaseUrl()`. Low urgency (reply handling only runs in production context) but architecturally inconsistent. See Additional Finding A-2.

---

## Section 9.1 — BACKLOG.md Prompt 3B entries

- **Checked:** `docs/BACKLOG.md` for Prompt 3B tagged entries
- **Found:** No BACKLOG entries tagged for Prompt 3B were found. The session did not add deferred items to BACKLOG.md as required by CLAUDE.md ("Before ending any session — update BACKLOG.md").
- **Verdict:** NEEDS REVIEW
- **Recommendation:** The findings in this audit (Section 8.3 migration debt, Section 4.1 checkbox decision, Section 4.2 Sentry direction) should be added to BACKLOG.md as part of the fix pass.

---

## Section 9.2 — Verification harness campaign_id fix

- **Checked:** `docs/prompts/subscription-activation-verification.md` check I-5
- **Found:**
  - Line 113: `"campaign_id": "<campaign-uuid-from-Doug>"` ✓ (correctly uses `campaign_id`)
  - Grep for `"campaign":` (bare JSON key): zero results in this file ✓
- **Verdict:** PASS

---

## Section 10.1 — Vercel Production env vars

- **Checked:** `vercel env ls production`
- **Found:** 20 env vars in production. `INSTANTLY_API_BASE_URL` is NOT set — correct (production falls back to `https://api.instantly.ai/api/v2` via `NODE_ENV === 'production'`). No stale `INSTANTLY_API_KEY` env var (key is stored in `integration_credentials` DB table). No `INSTANTLY_API_BASE` (without `_URL`) env var.
- **Verdict:** PASS

---

## Section 10.2 — Vercel Preview env vars

- **Checked:** `vercel env ls preview`
- **Found:** 19 env vars in preview. `INSTANTLY_API_BASE_URL` is NOT set — Preview will fall back to mock URL since `NODE_ENV !== 'production'` on preview deployments. `NEXT_PUBLIC_APP_URL` is missing from Preview (pre-existing gap, flagged in ADR-024 prerequisites but not addressed in Prompt 3B).
- **Verdict:** PASS for Prompt 3B scope. `NEXT_PUBLIC_APP_URL` gap is pre-existing and outside scope.

---

## Section 10.3 — New env vars introduced by Prompt 3B

- **Checked:** All new files introduced in Prompt 3B
- **Found:** The only new env var is `INSTANTLY_API_BASE_URL`, which is optional (falls back gracefully). No mandatory new env vars were introduced. Production deployment does not require any new Vercel env var configuration before this push.
- **Verdict:** PASS — no new mandatory env vars.

---

## Section 11.1 — Verification harness readiness

- **Checked:** Each harness check against the built code
- **Found:**
  - **I-1 (workspace auth):** No build dependency — harness calls endpoint directly with API key from DB. Requires `integration_credentials` row to exist. READY.
  - **I-2 (contract tests against production):** Tests use `process.env.INSTANTLY_API_BASE_URL` override. Setting this var to `https://api.instantly.ai/api/v2` and running `npm test` is the only switch needed. READY.
  - **I-3 (DFY simulate):** `orderMailboxes()` handler exists, accepts `simulate=true`. READY.
  - **I-4 (campaign validation):** `validateCampaign()` from Prompt 3A handles both 200 and 404. READY.
  - **I-5 (lead upload):** `uploadLeads()` handler exists. Note: harness calls the API directly, not via server action — harness must construct the `ProspectForUpload` objects manually. READY.
  - **I-6 (error response shapes):** Handler parses 4xx cleanly into typed errors. READY.
  - **I-7 (rate limit probe):** No build dependency. READY.
- **Verdict:** PASS

---

## Section 11.2 — Feature flag toggle (harness F-1)

- **Checked:** Flag reading path in page.tsx and actions.ts
- **Found:** Flag is read from `integrations_registry` at server render time. Flipping `is_active` via `execute_sql` and reloading the page will immediately reflect the new state — the value is not cached in memory or edge cache. The mock-mode banner appears/disappears on next page load.
- **Verdict:** PASS

---

## Section 11.3 — DFY two-step gate (harness F-2)

- **Checked:** MailboxOrderPanel two-step flow
- **Found:** See Section 4.1. The two-step button gate is intact — "Get quote" must succeed before "Confirm" appears, and "Confirm" is disabled when `instantly_api_active=false`. No single-click order path. The missing element is an explicit checkbox acknowledgment. The ADR's stated requirement ("two-step flow, no single-click order placement") is satisfied. The audit spec's additional ask (checkbox) is not satisfied.
- **Verdict:** NEEDS REVIEW (see Section 4.1)

---

## Section 12.1 — Assumptions made during Prompt 3B

| Assumption | File:Line | Confidence | Notes |
|---|---|---|---|
| `personalisation_trigger` (British spelling) in DB maps to `personalization` (American) in Instantly API | actions.ts:211 | High — confirmed from `database.ts` types | Risk: if the DB column is ever renamed, this silent name mismatch would break without a type error |
| `prospects.role` maps to Instantly's `job_title` | actions.ts:215 | Medium — inferred from column semantics | The DB has no `job_title` column; `role` is the closest. Not documented. |
| `campaigns!inner(external_id)` Supabase join syntax retrieves the right campaign per prospect | actions.ts:187 | Medium — relies on FK auto-detection | Supabase infers the FK from `prospects.campaign_id → campaigns.id`. If schema has multiple FKs to campaigns, the join might be ambiguous. |
| DFY API field for price is `total_price` OR `price` (tried both) | orderMailboxes.ts:132 | Low — documented field name was not verified against live API | Risk: if Instantly uses a different field name (e.g. `quote_price`, `order_total`), `total_price` in the result will be `null` silently |
| `skip_if_in_workspace: true` is the correct field name | uploadLeads.ts:60 | Medium — inferred from API docs naming conventions | The verification harness check I-5 will confirm this |

---

## Section 12.2 — Spec interpretations

1. **"personalisation_trigger" filter in pending count and upload query**: The spec said "has personalization_trigger" — interpreted as `personalisation_trigger IS NOT NULL`. A prospect with `personalisation_trigger=''` (empty string) would pass this filter but produce an empty personalization field in the Instantly upload. This edge case is not handled.

2. **No confirmation checkbox for DFY**: The build spec said "two-step simulate-then-confirm" and the ADR said "no single-click order placement." Interpreted as: step 1 = get quote, step 2 = confirm button. The audit spec asked for a checkbox. These two interpretations diverge.

3. **`orderMailboxes` Sentry warning direction**: Spec asked for `simulate=false + order_placed=false`. Implemented `simulate=true + order_placed=true` instead, which is the more dangerous scenario. Both are valid safety checks.

---

## Section 12.3 — Things that worked first-try and feel suspicious

1. **The vitest `vi.mock('../auth')` pattern with static import worked immediately.** The initial test file used `require('../auth')` inside `beforeEach` (wrong) and `await import('../auth')` inside test bodies (also wrong). The fix to use a top-level `import * as auth from '../auth'` with `vi.mocked(auth.fn)` was correct, but the fact that mock hoisting worked correctly with the import order deserves a second look. Vitest's mock hoisting is documented but can have surprising edge cases.

2. **The Supabase `campaigns!inner(external_id)` join was never runtime-tested.** The TypeScript types don't prevent a query from returning unexpected shapes at runtime. The join syntax has not been exercised against real data. If the FK auto-detection behaves differently than expected (e.g., ambiguous FK), the `row.campaigns` property could be an array instead of an object.

3. **The `DfyOrderResponse` index signature `[key: string]: unknown`** could mask type errors if Instantly changes the shape of `order_placed` or `order_is_valid`. TypeScript accepts it because `boolean extends unknown`.

---

## Section 12.4 — Where to look for the bug

If a hostile reviewer wanted to find the most likely bug:

1. **`handleUploadLeads` partial-failure behavior (highest risk):** If an org has prospects in multiple campaigns (e.g., Campaign A and Campaign B), and Campaign A uploads successfully but Campaign B throws an error, the function returns `{ ok: false, error: ... }` **and discards the Campaign A counts entirely**. The operator sees a failure with no information about what succeeded. Campaign A prospects were updated to `'uploaded'` in the DB but the operator gets no acknowledgment. The total_attempted counter is also lost. **This is a silent partial-success bug.**

2. **`campaigns!inner(external_id)` join runtime behavior**: Never tested against real data. The `as { external_id: string | null }` cast on line 205 of actions.ts could silently fail if Supabase returns the campaigns data as an array (possible with certain FK configurations).

3. **Mock-mode banner not showing after a successful upload:** After `handleUploadLeads` succeeds, the panel switches to `{ phase: 'success' }`. If the operator clicks "Upload again," it resets to `{ phase: 'idle' }`. The pending count shown is the **stale server-side value from page load**, not a refreshed count. After uploading 10 leads, the button will still say "Upload 10 pending leads" until the page is refreshed.

---

## SECTION A: ADDITIONAL FINDINGS

### A-1 — @deprecated migration promise unfulfilled

- **What:** `constants.ts` says `INSTANTLY_API_BASE` is "Retained for backward compatibility with existing handlers until they are migrated incrementally within Prompt 3B." Four pre-existing handlers were NOT migrated: `reply-actions.ts`, `polling/instantly.ts`, `validateCampaign.ts`, `campaign-analytics.ts`.
- **Impact:** Those handlers always call `https://api.instantly.ai/api/v2` regardless of `INSTANTLY_API_BASE_URL` env var. Cannot be redirected to mock server for testing.
- **Severity:** P2 — does not affect Prompt 3B functionality; reply handling and polling are separate flows. But the comment is misleading.
- **BACKLOG entry:** `[post-c0] Migrate INSTANTLY_API_BASE → getInstantlyApiBaseUrl() in 4 pre-existing handlers: reply-actions.ts, polling/instantly.ts, validateCampaign.ts, campaign-analytics.ts. The @deprecated promise in constants.ts was not fulfilled in Prompt 3B.`

### A-2 — process-reply.ts hardcoded production URL

- **What:** `src/lib/reply-handling/process-reply.ts:119` calls `https://api.instantly.ai/api/v2/leads/list` directly — hardcoded, not using `getInstantlyApiBaseUrl()`.
- **Impact:** Reply handling cannot be redirected to mock server. Pre-existing, not introduced in Prompt 3B.
- **Severity:** P2 — reply handling is production-only behavior anyway, but architecturally inconsistent.
- **BACKLOG entry:** `[post-c0] process-reply.ts:119 hardcodes https://api.instantly.ai/api/v2/leads/list — migrate to getInstantlyApiBaseUrl() for architectural consistency with Prompt 3B configurable-URL pattern.`

### A-3 — Stale pending count after upload

- **What:** `LeadUploadPanel` receives `pendingCount` as a server-rendered prop. After a successful upload, the displayed count remains stale (reflects pre-upload state). "Upload again" link resets the panel but shows the old count until page reload.
- **Impact:** Operator sees stale "Upload 10 pending leads" button after uploading 10 leads. Clicking it runs `handleUploadLeads` again, which returns `total_attempted: 0` (no pending leads remain) — so no harm, but potentially confusing.
- **Severity:** P2 — cosmetic/UX only. No data correctness risk.
- **BACKLOG entry:** `[post-c0-polish] LeadUploadPanel: pending count is server-rendered and stale after upload. After 'Upload again' is clicked, refetch count via a server action or router.refresh() so the button label reflects actual pending state.`

### A-4 — handleUploadLeads partial-failure silent data loss

- **What:** If prospects span multiple campaigns and campaign B fails after campaign A succeeds, `handleUploadLeads` returns `{ ok: false, error: ... }` and the caller never sees Campaign A's success counts. The DB is correctly updated (Campaign A prospects marked 'uploaded') but the UI shows a generic error.
- **Impact:** Operator may retry, hitting the same failure for Campaign B. Campaign A leads are re-uploaded but Instantly deduplicates them. No correctness risk, but operator experience is poor.
- **Severity:** P2 — no data loss, but confusing error state.
- **BACKLOG entry:** `[post-c0-polish] handleUploadLeads: partial-failure reporting. If campaign A succeeds and campaign B fails, return a partial result { ok: 'partial', successCounts, failedCampaign, error } instead of discarding the success counts. Currently a generic error hides what worked.`

### A-5 — Empty personalisation_trigger not filtered

- **What:** The pending count query and upload query filter `personalisation_trigger IS NOT NULL`, but an empty string `''` passes this filter. A lead with `personalisation_trigger=''` would be uploaded with an empty personalization string to Instantly.
- **Impact:** Low — Instantly accepts empty personalization. Would result in a cold email sent without personalization. The research agent should not produce empty trigger strings, but it's not enforced.
- **Severity:** P3 — unlikely edge case, non-breaking.
- **BACKLOG entry:** `[post-c0-polish] handleUploadLeads/pending count: also filter out prospects where personalisation_trigger = '' (empty string). Current filter only excludes NULL values.`

---

## Findings Summary

| Section | Verdict |
|---|---------|
| 1.1 TypeScript | PASS |
| 1.2 Next.js build | PASS |
| 1.3 Tests (45/45) | PASS |
| 1.4 Vitest install | PASS |
| 2.1 getInstantlyApiBaseUrl | PASS |
| 2.2 URL path suffixes | PASS |
| 2.3 Old vs new constant | PASS (new handlers) / NEEDS REVIEW (migration debt) |
| 2.4 .env.local.example | PASS |
| 3.1 Feature flags in DB | PASS |
| 3.2 Handler flag checks | PASS |
| 3.3 UI flag reading | PASS |
| 3.4 Defense-in-depth | PASS |
| 4.1 DFY two-step UI | NEEDS REVIEW (no checkbox) |
| 4.2 orderMailboxes handler | NEEDS REVIEW (Sentry direction) |
| 4.3 Contract tests simulate | PASS |
| 4.4 TLD validation | PASS |
| 5.1 types.ts structure | PASS |
| 5.2 LeadUploadResponse fields | PASS |
| 5.3 DfyOrderResponse fields | PASS |
| 5.4 Response parsing | PASS |
| 6.1 uploadLeads full read | PASS |
| 6.2 orderMailboxes full read | PASS |
| 6.3 Idempotency | PASS |
| 7.1 Apollo error branches | PASS |
| 7.2 Apollo fixtures | PASS |
| 7.3 Apollo fallthrough chain | PASS |
| 7.4 Apollo degradation script | PASS |
| 8.1 campaign_id wiring | PASS |
| 8.2 No bare campaign JSON key | PASS |
| 8.3 Old INSTANTLY_API_BASE | NEEDS REVIEW |
| 8.4 Hardcoded URLs | NEEDS REVIEW (process-reply.ts) |
| 9.1 BACKLOG hygiene | NEEDS REVIEW |
| 9.2 Harness campaign_id | PASS |
| 10.1 Vercel Production env | PASS |
| 10.2 Vercel Preview env | PASS |
| 10.3 New env vars | PASS |
| 11.1 Harness readiness | PASS |
| 11.2 Flag toggle | PASS |
| 11.3 DFY two-step harness | NEEDS REVIEW |
| 12.1–12.4 Assumptions | See report |
| A-1 @deprecated migration | NEEDS REVIEW |
| A-2 process-reply.ts URL | NEEDS REVIEW |
| A-3 Stale pending count | NEEDS REVIEW |
| A-4 Partial-failure | NEEDS REVIEW |
| A-5 Empty string filter | NEEDS REVIEW |

**Count: 31 PASS / 0 FAIL / 11 NEEDS REVIEW / 0 security fires**

### Prioritised NEEDS REVIEW list

| Priority | ID | Issue | Action |
|---|---|---|---|
| P1 | A-4 | handleUploadLeads partial-failure loses success counts | Post-push fix or BACKLOG |
| P1 | 4.1/11.3 | No confirmation checkbox for DFY real orders | Deliberate decision required |
| P2 | 4.2 | Sentry warning checks wrong direction (simulate=true+placed vs simulate=false+unplaced) | Add second check post-push |
| P2 | A-1/8.3 | @deprecated migration promise not fulfilled — 4 files still use hardcoded URL | Update comment or migrate |
| P2 | A-2/8.4 | process-reply.ts:119 hardcoded production URL | BACKLOG |
| P2 | A-3 | Stale pending count after upload | BACKLOG post-c0-polish |
| P2 | 9.1 | BACKLOG.md not updated during Prompt 3B session | Update in fix pass |
| P3 | A-5 | Empty personalisation_trigger not filtered | BACKLOG post-c0-polish |

---

## Manual actions required before push and during subscription activation

### Before push (fix pass)

1. **Update `constants.ts` @deprecated comment** to remove the "within Prompt 3B" promise, replacing it with "to be migrated in a future prompt." Why: the promise is false and creates a misleading expectation. Failure if skipped: none functional, but the comment will confuse whoever reads it next. Can be done in one line.

2. **Add BACKLOG.md entries** for A-1 through A-5. Why: CLAUDE.md requires it. Failure if skipped: these findings get lost between sessions. Manual, 5 minutes.

3. **Decision required from Doug: DFY confirmation checkbox.** Does the two-step button flow (get quote → confirm button) satisfy the safety requirement, or is an explicit "I understand this charges real money" checkbox required? The ADR says "two-step flow," which is satisfied. A checkbox is an additional layer. This is a deliberate design decision, not a bug.

### During subscription activation (verification harness day)

4. **Run contract tests against production** before flipping flags: `INSTANTLY_API_BASE_URL=https://api.instantly.ai/api/v2 npm test`. Expected: 45/45 pass. Any DRIFT in response shapes should be fixed in types.ts before proceeding.

5. **Check the `campaigns!inner(external_id)` join** on real data: run the pending count query via Supabase MCP before attempting an upload. Confirm the count is non-zero and the join is working.

6. **Manually verify DFY quote response fields** from live API: confirm whether `total_price`, `price`, or another field name contains the quote. If neither, update `orderMailboxes.ts:132` to handle the actual field name. The verification harness check I-3 explicitly asks for this.

7. **Flip flags one at a time**: flip `instantly_api_active` first, verify lead upload works, then address DFY ordering separately (real money).

---

## Things I would change about my own work if I could go back

1. **I should have added the second Sentry warning in orderMailboxes.ts** (`!simulate && !data.order_placed`) at the same time as the first. The spec asked for it explicitly. I implemented the more dangerous one and missed the specified one.

2. **The @deprecated comment promised migration "within Prompt 3B."** I wrote that comment and then didn't migrate the 4 files. The comment should have said "to be migrated in a follow-on prompt" from the start. This is a small discipline failure.

3. **handleUploadLeads should accumulate partial results** instead of aborting on the first campaign failure. The current `for` loop pattern with early return loses successful campaign data. A `Promise.allSettled` pattern or separate success/error accumulator would be more robust.

4. **The pending count in `LeadUploadPanel` should refresh** after a successful upload. The current design shows stale data. The fix is one `router.refresh()` call after the success state is set. I didn't include it because Next.js's `useRouter` in a server-action context needs a `'use client'` hook that was already present, but I missed the refresh.

5. **I didn't write a test for the `handleUploadLeads` server action itself** (the grouping logic, the campaign join, the aggregate counting). Only the handler layer has contract tests. The server action's logic for grouping by external_id and aggregating results is untested.
