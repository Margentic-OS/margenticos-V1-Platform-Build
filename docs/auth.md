# auth.md — Authentication and Access Control

## Authentication method

Supabase Auth with magic link (passwordless). Users receive a login email, click the
link, and land in the app. No passwords anywhere in the system.

## Roles

- **operator** — Doug. Full access to all organisations and all data.
- **client** — Client founders. Can only see their own organisation's data.

## How a new user gets into the system

When someone signs in for the first time via magic link, Supabase creates a row in
`auth.users`. A database trigger (`on_auth_user_created`) fires immediately and creates
a matching row in `public.users` with `role = 'client'` as the default.

This means every new signup is automatically a client. Only a deliberate operator
promotion step can change this.

## Operator Setup

This is a one-time step. Run it after Doug signs in for the first time.

**Step 1 — Sign in via magic link**

Go to the app login page and enter Doug's email address. Click the link in the email.
This creates the `auth.users` row (Supabase) and the `public.users` row (the trigger).

**Step 2 — Run the seed script**

From the project root, run:

```
OPERATOR_EMAIL=your@email.com npx tsx scripts/seed-operator.ts
```

The script reads `.env.local` automatically. Replace `your@email.com` with the exact
email address used to sign in.

**What it does:** Updates the `public.users` row for that email from `role = 'client'`
to `role = 'operator'`. This is the only way to gain operator access.

**Expected output:**
```
✓ your@email.com (id: <uuid>) promoted to operator role.
```

If you see "No user found with email", the magic link sign-in hasn't happened yet.
Complete Step 1 first.

**Step 3 — Verify**

Sign in again and confirm the operator dashboard loads. Operator routes check
`role = 'operator'` on every request — not just at login.

## The three-check rule

Every API route that returns data must verify three things before responding:
1. The user is authenticated (valid session)
2. The user's role is correct for that route (operator or client)
3. The `client_id` / `organisation_id` in the request matches the data being fetched

Check 3 prevents a client from accessing another client's data even if they somehow
pass checks 1 and 2.

## organisation_id for operators vs clients

`organisation_id` in `public.users` is nullable.

- **Operators**: `organisation_id = NULL`. Operators are cross-organisation.
- **Clients**: `organisation_id` set during client onboarding (links them to their org).

## What to check if auth breaks

- Is `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` set in `.env.local`?
- Did the magic link email arrive? Check spam. Check Supabase → Auth → Logs.
- Is the redirect URL configured in Supabase → Auth → URL Configuration?
  Set Site URL to your Vercel deployment URL (or `http://localhost:3000` for local).
- Does the `on_auth_user_created` trigger exist? Check Supabase → Database → Functions.
- Does the `public.users` row exist for the user? Check Supabase → Table Editor → users.
- Is the `handle_new_auth_user` function `SECURITY DEFINER`? It must be — otherwise
  the trigger can't write to `public.users` during first-time signup (no session yet).
