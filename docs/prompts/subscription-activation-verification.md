SUBSCRIPTION ACTIVATION VERIFICATION HARNESS

Fire this prompt the day you activate Instantly Growth and/or Apollo Basic.
Paste into a fresh Claude Code session. Self-contained — no prior context 
required beyond the codebase.

CONTEXT

You are running a systematic verification of MargenticOS's integrations 
against the live Instantly and Apollo APIs. Until now, the build has been 
running against Instantly's mock server (https://developer.instantly.ai/_mock/api/v2/) 
and stored Apollo fixtures. The goal of this session is to verify that 
real production APIs behave the way mock and fixtures predicted.

Read /docs/ADR.md → ADR-024 in full, including the "Watertight build 
strategy (May 2026 amendment)" section, before starting. It explains the 
four pillars this verification is exercising.

PREREQUISITES (Doug must confirm before you start)

1. Instantly Growth subscription is active. Confirm by checking 
   https://app.instantly.ai/app/settings/integrations or equivalent.
2. Apollo Basic subscription is active (if Apollo verification is in scope).
3. A real Instantly API key is configured in integration_credentials 
   for the testing organisation. Use Supabase MCP to confirm.
4. A real Apollo API key is configured in integration_credentials 
   for the testing organisation, if applicable.
5. Doug provides:
   - One real Instantly campaign UUID (for campaign validation test)
   - One test email address he controls (for lead upload test — gmail 
     +alias works; do NOT use a real prospect's email)
6. instantly_api_active and apollo_api_active flags are currently false 
   in integrations_registry. We'll flip them to true at the end, after 
   verification passes.

If any prerequisite is missing or unclear, STOP and ask Doug before 
running any API calls.

CRITICAL SAFETY RULES

- Do NOT place real DFY orders. simulate:true only.
- Do NOT upload prospect leads. Only the test email Doug provides.
- Clean up any test data you create (delete test leads after upload test).
- If auth fails or any check returns a result you don't understand, STOP 
  and report. Do not continue and discover compounding issues.
- If you find yourself stuck on a single check for more than 15 minutes 
  of investigation, STOP and report.

VERIFICATION CHECKS

For every check, report: (a) what you ran, (b) what you got, (c) verdict 
PASS / FAIL / DRIFT, (d) recommendation if FAIL or DRIFT.

DRIFT means the response works but its shape differs from what the contract 
test or fixture expected. Worth fixing but not a blocker.

INSTANTLY VERIFICATION

Check I-1: Workspace authentication
- Call GET https://api.instantly.ai/api/v2/workspaces/current with the 
  real API key (via getInstantlyApiKey() helper, NOT inline)
- Confirm 200 response
- Confirm workspace ID, owner, plan_id present in response
- Verdict: PASS only if all three present

Check I-2: Contract tests run against production
- Locate all contract tests in src/lib/integrations/handlers/instantly/__tests__/
- For each test, modify the BASE_URL configuration to point at production 
  (https://api.instantly.ai/) for the duration of this check
- Run each test
- Compare actual response shape to expected
- Report: PASS, FAIL (test fails outright), or DRIFT (test passes but 
  shape differs in a non-breaking way, e.g., extra fields)
- Restore the BASE_URL configuration before moving on

Check I-3: DFY simulate-mode order
- POST https://api.instantly.ai/api/v2/dfy-email-account-orders with body:
  {
    "items": [{ "domain": "verification-test-margenticos.com" }],
    "order_type": "dfy",
    "simulate": true
  }
- Confirm 200 response (or whatever the documented success status is)
- Confirm order_placed === false (because simulate)
- Confirm order_is_valid is present (true or false either way — we want 
  to see the field exists)
- Confirm a price quote field is returned
- If order_placed is true: STOP IMMEDIATELY. A real order has been placed. 
  Roll back via the cancellation endpoint and report.
- Verdict: PASS only if simulate confirmed working

Check I-4: Campaign validation
- Use the campaign UUID Doug provided
- Call GET https://api.instantly.ai/api/v2/campaigns/{uuid} with real API key
- Confirm 200 response
- Confirm name, status, and any other fields the validateCampaign handler 
  expects are present
- Test the failure path: call the same endpoint with a fake UUID 
  (e.g., 00000000-0000-0000-0000-000000000000)
- Confirm 404 response
- Verdict: PASS only if both success and failure paths work as expected

Check I-5: Lead upload flow
- Use the test email Doug provided (gmail +alias preferred)
- POST https://api.instantly.ai/api/v2/leads/add with body:
  {
    "leads": [{
      "email": "<test-email>",
      "personalization": "Verification test lead — safe to delete",
      "first_name": "Verification",
      "last_name": "Test"
    }],
    "campaign_id": "<campaign-uuid-from-Doug>"
  }
- Confirm 200 response
- Confirm leads_uploaded count is 1
- Confirm response shape matches the typed interface in 
  src/lib/integrations/handlers/instantly/types.ts (any drift = DRIFT verdict)
- Capture the created lead's ID from the response
- IMMEDIATELY clean up: DELETE the test lead via 
  https://api.instantly.ai/api/v2/leads/{lead-id}
- Confirm 200 on the delete
- Verdict: PASS only if upload succeeded, response shape matched, AND 
  delete succeeded

Check I-6: Error response shapes
- Send a deliberately malformed lead upload request (e.g., missing 
  required "email" field):
  POST /api/v2/leads/add with body: { "leads": [{ "first_name": "Test" }] }
- Confirm 4xx response (likely 400 or 422)
- Capture the error response shape
- Compare against any error handling expectations in the lead upload 
  handler code
- Verdict: PASS if error is caught cleanly by handler code; FAIL if 
  handler crashes; DRIFT if shape differs from expected

Check I-7: Rate limit probe (gentle)
- Send 5 quick GET requests to /api/v2/workspaces/current in succession
- Do NOT attempt to actually trigger 429 — Instantly's limits are high 
  (100 req/sec) and triggering them would risk a brief workspace-wide block
- Confirm all 5 succeed without rate limit response headers indicating 
  imminent throttling
- Inspect response headers for any rate-limit info (X-RateLimit-* or 
  similar) and report what's returned
- Verdict: PASS if 5 succeed; report headers found

APOLLO VERIFICATION (skip if Apollo not activated)

Check A-1: Authentication health
- Call GET https://api.apollo.io/v1/auth/health with the real API key 
  (in X-Api-Key header per Apollo's auth pattern)
- Confirm response: { healthy: true, is_logged_in: true } or equivalent
- Verdict: PASS only if both true

Check A-2: People match (single enrichment)
- POST https://api.apollo.io/api/v1/people/match
- Send a known-good lead: 
  { "email": "doug@margenticos.com" } (or a public-figure example for 
  better match likelihood, e.g., a well-known CEO's name + company domain)
- Confirm 200 response
- Compare response shape against fixtures in 
  src/lib/integrations/handlers/apollo/__fixtures__/
- Verdict: PASS if shape matches; DRIFT if shape differs

Check A-3: People search
- POST https://api.apollo.io/api/v1/mixed_people/search with minimal 
  filters (e.g., person_titles=['Founder'], per_page=5)
- Confirm 200 response
- Confirm a `people` or `contacts` array in response (whatever Apollo's 
  actual field name is — compare to fixtures)
- Confirm pagination fields present (page, per_page, total_pages or similar)
- Verdict: PASS if shape matches fixtures; DRIFT if different

Check A-4: Error response (auth failure)
- Send a request with a deliberately wrong API key (one character changed)
- Confirm 401 response
- Confirm error response shape matches what the Apollo handler expects
- Verdict: PASS only if 401 caught cleanly

Check A-5: Credit usage check
- Call GET https://api.apollo.io/api/v1/usage_stats/api_usage_stats with 
  the master API key (if Doug created one)
- Confirm current credit balance
- Report the limits per endpoint so Doug knows real constraints
- Verdict: informational, no PASS/FAIL required

FEATURE FLAG VERIFICATION

Check F-1: Flag toggle behaviour
- Currently instantly_api_active=false. Confirm via:
  SELECT capability, is_active FROM integrations_registry 
  WHERE capability IN ('instantly_api_active', 'apollo_api_active')
- Navigate to a Prompt 3B operator UI (e.g., the lead upload UI on the 
  operator detail page)
- Confirm the UI shows the mock-mode indicator
- Trigger an action (e.g., upload leads) and confirm it calls the mock 
  URL, NOT the production URL (inspect network logs or Sentry trace)
- Now flip instantly_api_active=true via execute_sql
- Reload the page
- Confirm the mode indicator disappears
- Trigger the same action and confirm it calls production
- Flip back to instantly_api_active=false
- Verdict: PASS only if all four states behave correctly

Check F-2: DFY two-step safety
- With instantly_api_active=true, navigate to the DFY mailbox ordering UI
- Click whatever the initial action is (e.g., "Get quote")
- Confirm it calls the API with simulate:true
- Confirm the UI shows the quote without placing an order
- Confirm there's an explicit second action required to place a real 
  order (e.g., "Confirm and place order" button)
- Do NOT click the second action
- Verdict: PASS only if the two-step gate is intact

FINAL SUMMARY

After all checks, produce:

(a) Pass/fail/drift counts per integration (Instantly, Apollo, Feature flags)

(b) Prioritised list of issues found:
    - BLOCKERS: anything that prevents real use (auth broken, endpoint 
      returns errors)
    - DRIFT: shape differences that should be fixed but don't block use
    - HEADERS/INFO: rate limit headers, credit balances, anything 
      operationally useful

(c) Recommended next steps:
    - If all PASS: flip instantly_api_active and apollo_api_active to 
      true permanently, ready for smoke test
    - If DRIFT only: list the specific files that need updating 
      (contract tests, fixtures, type interfaces) with proposed changes
    - If FAIL: do not flip flags; report the failures and recommend 
      fixes before activation

(d) Commit a copy of this verification report to 
    /docs/discovery/<YYYYMMDD>-subscription-activation-verification.md

(e) Do NOT push. Doug reviews first.
