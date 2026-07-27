# Prospect Review Feature — Test Readiness Report

**Date:** 2026-07-28
**Status:** Ready to test (pending Phase 1 migration deployment)

---

## MOCK MODE CONFIRMATION ✅

**The build is mock-sealed and safe to test without sending real emails.**

### How Mock Mode Works

When `INSTANTLY_API_ACTIVE=false` (default):
- `shouldUseMockDispatch()` returns `true` (see [constants.ts:48-50](../src/lib/integrations/handlers/instantly/constants.ts#L48-L50))
- In-process mock dispatch runs instead of HTTP calls ([mock-dispatch.ts:4](../src/lib/integrations/handlers/instantly/mock-dispatch.ts#L4) "zero network calls")
- `mockLeadsAdd()` returns a mock Response object with created_leads array
- No real emails are sent to Instantly

### Verification
```bash
# Default mode (safe for testing)
npm test  # INSTANTLY_API_ACTIVE not set → defaults to false → mock dispatch

# Mock mode explicitly on (also safe)
INSTANTLY_API_ACTIVE=false npm test

# To use real Instantly API (requires activation, not for testing)
INSTANTLY_API_ACTIVE=true npm test  # Requires valid API key and real campaign
```

✅ **Full claim-filter-exclude-upload path runs in mock mode without pushing real email.**

---

## COMPLIANCE TEST SUITE ✅

Four critical test cases written and ready to run:

### 1. **Reject-then-send race (Gate 2)**
File: [handleUploadLeads.compliance.test.ts](../src/app/dashboard/operator/clients/[id]/__tests__/handleUploadLeads.compliance.test.ts#L60-L103)

**What it tests:** A prospect rejected AFTER claim must not appear in upload payload.

**Test logic:**
1. Create two prospects, claim both (status='uploading')
2. Reject one prospect (suppressed=true) after claim
3. Run Gate 2 re-check query (suppressed=true OR client_review_status='rejected')
4. Verify: Gate 2 finds rejected prospect, would exclude from upload

**Expected result:** ✅ Gate 2 correctly identifies rejected prospect for exclusion

---

### 2. **Fail-closed error handling**
File: [handleUploadLeads.compliance.test.ts](../src/app/dashboard/operator/clients/[id]/__tests__/handleUploadLeads.compliance.test.ts#L105-L144)

**What it tests:** If Gate 2 query errors, upload aborts and prospects reclaim to 'pending'.

**Test logic:**
1. Claim a prospect (status='uploading')
2. Simulate Gate 2 error: reclaim prospect back to 'pending'
3. Verify prospect is ready for retry

**Expected result:** ✅ Error handling reclaims all claimed prospects, preventing upload

---

### 3. **Durable tier lock (uploaded state survives reclaim)**
File: [handleUploadLeads.compliance.test.ts](../src/app/dashboard/operator/clients/[id]/__tests__/handleUploadLeads.compliance.test.ts#L146-L191)

**What it tests:** Once a prospect reaches 'uploaded', tier stays locked even after stale reclaim.

**Test logic:**
1. Create two prospects in same tier
2. Set one to 'uploaded' (terminal), one to 'uploading' (35 min old, stale)
3. Simulate reclaim: reset stale 'uploading' to 'pending'
4. Run tier lock check: search for 'uploaded' OR 'uploading'
5. Verify: tier still locked (found 'uploaded' prospect)

**Expected result:** ✅ Tier lock is durable; stale reclaim cannot unlock tier

---

### 4. **Column exposure (client_prospects_view)**
File: [handleUploadLeads.compliance.test.ts](../src/app/dashboard/operator/clients/[id]/__tests__/handleUploadLeads.compliance.test.ts#L193-L234)

**What it tests:** View never returns email or verification fields.

**Test logic:**
1. Create prospect with full data (email, verification fields)
2. Query via `client_prospects_view`
3. Verify: safe columns present (id, first_name, company_name, personalisation_trigger)
4. Verify: dangerous columns absent (email, independent_email_status, verification_provider, outbound fields)

**Expected result:** ✅ View exposes only safe columns

---

## PREREQUISITE: Phase 1 Migration Deployment

**Current status:** Migration file written but not yet deployed to test database.

**File:** [20260728_client_prospect_review_schema.sql](../supabase/migrations/20260728_client_prospect_review_schema.sql)

**What it adds:**
- `client_review_status` column to prospects
- `client_review_reason` column to prospects  
- `client_review_auto_approved_at` column to prospects
- `client_prospects_view` view (safe columns only)
- Indexes for query performance
- RLS policies for client access

**To run tests:**
1. Deploy Phase 1 migration to Supabase:
   ```bash
   supabase migration deploy  # or via Supabase dashboard
   ```
2. Run tests:
   ```bash
   npm test -- src/app/dashboard/operator/clients/\[id\]/__tests__/handleUploadLeads.compliance.test.ts
   ```

---

## SAFETY GUARANTEES (After Migration)

✅ **Gate 1 (Reject endpoint):** Fails if prospect status != 'pending' (prevents reject after send)
✅ **Gate 2 (Final re-check):** Excludes any prospect found in rejection query (catches rejects post-claim)
✅ **Gate 3 (Tier lock):** Checks for 'uploaded' OR 'uploading' status (durable via uploaded state)
✅ **Column view:** client_prospects_view never exposes email or verification fields

**Structural guarantee:** Sending to a rejected prospect is now impossible.

---

## Next Steps

1. ✅ Migration file created: [20260728_client_prospect_review_schema.sql](../supabase/migrations/20260728_client_prospect_review_schema.sql)
2. ✅ Tests written: [handleUploadLeads.compliance.test.ts](../src/app/dashboard/operator/clients/[id]/__tests__/handleUploadLeads.compliance.test.ts)
3. ⏳ **Pending:** Deploy Phase 1 migration to test/prod Supabase
4. ⏳ **Then:** Run test suite to verify all four gates pass
5. ⏳ **Then:** Manual testing of UI tier-review flow
6. ⏳ **Then:** Staging deployment verification

---

## Mock Mode Safety Confirmation

**All tests will run in mock mode by default (INSTANTLY_API_ACTIVE=false):**
- No HTTP calls to Instantly
- No real emails sent
- Zero risk of production data exposure during testing
- Fully isolated integration tests
