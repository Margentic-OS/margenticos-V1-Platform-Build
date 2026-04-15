# sections/04-auth.md — Authentication, Roles, Multi-User Access
# MargenticOS PRD | April 2026
# Read prd/PRD.md first, then this section when working on auth, roles, or access control.

---

## Authentication method

Supabase Auth with magic link (passwordless email).
No passwords. No OAuth (phase one).

Users receive a magic link by email. Clicking it authenticates them.
Session is managed by Supabase. Tokens are stored securely by the Supabase client.

---

## Roles

Two roles exist in phase one:

  operator    Doug. Full access to everything. One operator account exists.
  client      The client (founder). Access to their own organisation's data only.

Role is stored in the users table (role field).
It must be verified server-side on every protected request — not just at login.

---

## Three-check rule — every API route

For every new API route, three checks must be performed before returning any data:

  1. User is authenticated (valid Supabase session)
  2. User role is appropriate for this route (operator routes reject client role)
  3. client_id in the request matches the organisation the user belongs to

These checks are not optional on any route. Even "read-only" routes must verify all three.
A missing check is a data leak waiting to happen.

Example middleware pattern:
  - Verify session token → reject with 401 if invalid
  - Read role from users table → reject with 403 if insufficient role
  - Compare requested organisation_id to user's organisation_id → reject with 403 if mismatch

---

## Multi-user client access

Multiple users can belong to one organisation (e.g. founder + EA + partner).
All users in an organisation see exactly the same client dashboard.
No user-level permissions within an organisation in phase one — all client users see all.

When a new client user is invited:
  - Doug creates a user record in the users table with organisation_id and role = 'client'
  - The user receives a magic link to set up their account
  - On first login they land on their organisation's dashboard

---

## Operator routes

Routes under /operator or with operator-only data must:
  - Verify role = 'operator' on every request
  - Never return operator-only fields (payment_status, contract_status, engagement_month)
    in responses to client-role requests

Operator-only data includes:
  - Payment status and contract terms
  - Engagement month counter
  - Agent activity logs
  - Signal raw data
  - All-clients overview
  - Document suggestion queue (clients see approved documents only)

---

## Client routes

Routes serving client-facing data must:
  - Verify role = 'client' or 'operator' (operators can view client data)
  - Always filter by the user's organisation_id — never trust a client-supplied organisation_id
  - Never return suppressed prospect data, raw campaign data, or operator-only fields

---

## Session behaviour

Session expiry: Supabase default (1 hour access token, 1 week refresh token).
On expiry: redirect to login, show magic link request form.
Never auto-renew without re-authentication.

---

## What not to build in phase one

- OAuth (Google, LinkedIn login) — add in phase two if needed
- Password reset flows — not applicable with magic link
- User-level permissions within an organisation — all client users see the same view
- Self-serve signup — Doug manually creates all client accounts in phase one
