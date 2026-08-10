# Middleware Auth Behavior Test Matrix

**Purpose**: Verify middleware correctly distinguishes API vs page requests and handles auth properly.

## Test Cases (to run after deployment)

### 1. Authenticated Client (Browser with Supabase session cookie)
```
Request: GET /dashboard/prospect-tiers
Expected: 200 HTML, renders page
Status: [ ] Pass [ ] Fail
Evidence: Page renders, prospects visible or error box with HTTP detail
```

### 2. Authenticated Client API Fetch (Same browser, same cookies)
```
Request: GET /api/dashboard/client/prospect-tiers (from page fetch)
Expected: 200 JSON with tiers array
Status: [ ] Pass [ ] Fail
Evidence: Page displays prospects without error
```

### 3. Unauthenticated Page Request (No cookies)
```
Request: GET /dashboard/prospect-tiers (incognito or no session)
Expected: 302 redirect to /login?next=/dashboard/prospect-tiers
Status: [ ] Pass [ ] Fail
Evidence: Browser redirects to login
```

### 4. Unauthenticated API Request (No cookies, direct API call)
```
Request: GET /api/dashboard/client/prospect-tiers (no auth)
Expected: 401 JSON {"error":"Unauthorized"}
Status: [ ] Pass [ ] Fail
Evidence: 401 response with JSON body
```

## Problem Diagnosis

If **Test 2 fails** (API returns error):
- Error box shows the exact HTTP status and response preview
- Common causes:
  - **401**: Middleware or route handler says no user → check cookie propagation
  - **404**: Organization not found → check user linkage in users table
  - **HTML instead of JSON**: Middleware/route crashing or returning wrong content type

If **Test 1 passes but Test 2 fails**:
- Page can load but API fails
- Likely: cookies aren't being passed correctly from page fetch to route handler
- Fix: verify `createClient()` in route has access to request cookies

## Cookie Flow Diagram

```
Browser
  ↓ (request with auth cookie)
Middleware (reads cookie, checks user, passes through)
  ↓
Route Handler (createClient() must read same cookie)
  ↓ (returns JSON or error)
Page Fetch (captures response)
  ↓
Error box shows detail OR prospects render
```

The middleware's cookie reading and route handler's cookie reading must be consistent.
