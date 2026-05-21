# Apollo API Response Fixtures

Stored response shapes for the Apollo API endpoints used by MargenticOS.
Used by the Apollo graceful degradation unit tests in scripts/test-apollo-degradation.ts.

Because Apollo has no public mock server, tests run against these fixtures
rather than the live API. The verification harness at
docs/prompts/subscription-activation-verification.md (checks A-1 through A-5)
validates these shapes against the real API once Apollo Basic is activated.

## Sources

All fixtures are derived from Apollo API documentation at docs.apollo.io.
Captured: 2026-05-21.

| File | Endpoint | HTTP status | Notes |
|---|---|---|---|
| auth-health-success.json | GET /v1/auth/health | 200 | Successful auth check |
| people-match-success.json | POST /v1/people/match | 200 | Single person match with employment history |
| people-search-success.json | POST /v1/mixed_people/search | 200 | List response with pagination |
| error-401.json | Any | 401 | Invalid or missing API key |
| error-403.json | Any | 403 | Free tier blocked or insufficient scope |
| error-429.json | Any | 429 | Rate limit exceeded (body only — see note below) |

## Note on 429 Retry-After

The 429 response includes a `Retry-After` HTTP header (seconds until next allowed request).
This header is not in the JSON body — it is in the response headers.
The `error-429.json` fixture represents the body only.
Tests that exercise the 429 branch must also simulate the `Retry-After: 60` header.

## Updating fixtures

If the verification harness reports DRIFT (shape differs from live API), update the
relevant fixture to match the live API response and re-run the degradation test script.
