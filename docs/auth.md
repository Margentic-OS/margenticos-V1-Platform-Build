# auth.md — Authentication and Access Control

_Last updated: 2026-06-09. Reflects the OTP-code login rework shipped that date._

---

## Authentication method

Supabase Auth with OTP codes (passwordless). Users enter their email, receive an
8-digit code by email, and enter the code on the login screen. No passwords. No
clickable magic links.

**Why codes instead of links:** Clickable auth links are consumed by corporate email
gateways (Outlook Safe Links, Gmail link-prefetch) before the user clicks them. The
gateway follows the link, the single-use token is spent, and the user sees "link invalid."
Codes are not URLs. Scanners cannot consume them. This is especially important for
MargenticOS's ICP (B2B founders with Office 365 tenants).

The OTP digit count (8) and expiry window (86400 seconds, or 24 hours) are both set
in the Supabase dashboard under Authentication. The email template shows the token code
only, with no ConfirmationURL field populated. There is no clickable link in the email.

---

## Roles

- **operator** — Doug. Full access to all organisations and all data.
- **client** — Client founders. Can only see their own organisation's data.

---

## Two login legs

### Returning-user leg

The user visits the login page, enters their email, and clicks "Send code."

The server action (`sendMagicLink` in `src/app/login/actions.ts`) calls
`supabase.auth.signInWithOtp` with `shouldCreateUser: false`. No `emailRedirectTo`
is passed, so Supabase sends a code-only email with no link.

The user enters the 8-digit code on the next screen. The server action `verifyOtpCode`
calls `supabase.auth.verifyOtp` with `type: 'email'`. On success, the session is
established and the user is redirected to the dashboard.

### First-time invite leg

When an operator invites a new client, the welcome email contains an 8-digit code
alongside the `?invite=1&email=...` URL. The user opens that URL (which loads the
code-entry screen directly, skipping the email-entry step) and enters the code.
`verifyOtpCode` is called with `type: 'invite'`. On success, the account is activated
and the session is established.

---

## Enumeration-safe neutral message

`shouldCreateUser: false` means Supabase returns a 422 error for emails that are not
registered in the system. This would normally reveal whether an account exists.

`sendMagicLink` catches the 422 and treats it identically to a successful OTP send: it
redirects to `/login?sent=true&email=...` (the code-entry screen) and shows the same
"check your inbox" message. Callers cannot distinguish a registered from an unregistered
email address. The code entry will silently fail for unregistered emails if the user
tries to enter a code, but no account information is disclosed at the send step.

---

## Double-submit protection

The submit button in `src/app/login/submit-button.tsx` uses `useFormStatus` from
`react-dom`. While the form action is in flight, `pending` is `true` and the button is
disabled. This prevents a second submission while the server is processing the first,
which avoids duplicate OTP sends and duplicate verify attempts.

---

## How a new user gets into the system

When someone signs in for the first time (invite leg), Supabase creates a row in
`auth.users`. The database trigger `on_auth_user_created` fires immediately and runs
`handle_new_user()`, a `SECURITY DEFINER` function that creates a matching row in
`public.users` with `role = 'client'` as the default.

The trigger must be `SECURITY DEFINER` because no session context exists when a brand
new user's row is being created. Without it, the function cannot write to `public.users`.

Every new signup is automatically a client. Only a deliberate operator promotion step
can change this.

---

## Operator setup

This is a one-time step. Run it after Doug signs in for the first time.

**Step 1 — Sign in via OTP code**

Go to the app login page and enter Doug's email address. Wait for the 8-digit code,
enter it on the next screen. This creates the `auth.users` row (Supabase) and the
`public.users` row (via the trigger).

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
your@email.com (id: <uuid>) promoted to operator role.
```

If you see "No user found with email", the sign-in has not happened yet. Complete
Step 1 first.

**Step 3 — Verify**

Sign in again and confirm the operator dashboard loads. Operator routes check
`role = 'operator'` on every request, not just at login.

---

## The three-check rule

Every API route that returns data must verify three things before responding:

1. The user is authenticated (valid session).
2. The user's role is correct for that route (operator or client).
3. The `client_id` or `organisation_id` in the request matches the data being fetched.

Check 3 prevents a client from accessing another client's data even if they somehow
pass checks 1 and 2. The `/api/suggestions/[id]/approve` route and `assertStrategyApproved`
are two examples where all three checks are enforced explicitly before any data is returned
or modified.

Operator routes that span multiple organisations (for example, the reply-drafts routes)
intentionally perform only checks 1 and 2, omitting check 3, because operators are
cross-organisational by design per ADR-021 and must access data across all clients.

---

## organisation_id for operators vs clients

`organisation_id` in `public.users` is nullable.

- **Operators:** `organisation_id = NULL`. Operators are cross-organisation.
- **Clients:** `organisation_id` set during client onboarding (links them to their org).

---

## What to check if auth breaks

**Code is never arriving:**
- Check that the Supabase project is using the Resend custom SMTP, not the built-in relay.
  Built-in relay has a 2-email-per-hour rate limit and poor deliverability. Custom SMTP is
  configured via Supabase dashboard: Authentication, SMTP settings,
  sender `MargenticOS <login@margenticos.com>`, server `smtp.resend.com:465`.
- Check Supabase dashboard: Authentication, Logs. A "sent" entry with no delivery means
  the relay dropped it. An error entry means the SMTP call failed.

**Code is invalid or expired:**
- The 8-digit code is single-use. Requesting a new code invalidates the previous one.
  Repeated test sends from the same session will each invalidate the prior code.
- Expiry is 86400 seconds (24 hours), set in the Supabase dashboard.
- The error displayed on the code-entry screen distinguishes `code_invalid` from
  `code_expired` based on the error message returned by Supabase.

**Redirect goes to the wrong place after sign-in:**
- Check Supabase dashboard: Authentication, URL Configuration.
  Site URL must be `https://app.margenticos.com` for production.
  Redirect URLs allow list must include `https://app.margenticos.com/**` and
  `http://localhost:3000/**`.

**User cannot sign in at all (returns to email form with error):**
- Check `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are set
  in `.env.local` (local) and Vercel environment variables (production/preview).

**New user's row is not being created after first sign-in:**
- Check Supabase: Database, Functions. Confirm `handle_new_user` exists and is
  `SECURITY DEFINER`.
- Check Supabase: Database, Triggers. Confirm `on_auth_user_created` is attached
  to `auth.users` and calls `handle_new_user()`.
- Check Supabase: Table Editor, users. The row should appear after the first
  successful OTP verify.
