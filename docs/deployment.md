# deployment.md — Environments and Deployment Reference
# Stub — update as deployment is configured.
# Cover: environment setup, Vercel config, Sentry, what to check if a deployment breaks.

## Environment status
development:  local — Supabase local or dev project [not yet connected]
staging:      Vercel preview — automatic on push to non-main branch [not yet configured]
production:   Vercel main [not yet configured]

## Key rules
Never push to production without staging verification.
Separate environment variables in Vercel for each environment.

## Vercel setup (to be done)
[ ] Connect GitHub repository to Vercel
[ ] Configure environment variables per environment
[ ] Verify staging auto-deploy on non-main branch push

## Sentry setup (to be done)
[ ] Create Sentry project
[ ] Add NEXT_PUBLIC_SENTRY_DSN to environment variables
[ ] Add SENTRY_AUTH_TOKEN to Vercel

## Dependencies with a local patch (added 2026-09-11)

`@supabase/postgrest-js` 2.103.2 carries `patches/@supabase+postgrest-js+2.103.2.patch`: one
retry on a 504 for reads only. `npm install` applies it through the `postinstall` script, and
Vercel runs that script on every install. `prebuild` runs `scripts/check-postgrest-patch.ts`,
which fails the build if the patch is not in the installed files.

**What to check if a build stops at `check-postgrest-patch: FAILED`.**
- "does not carry the 504 retry patch": the install ran without scripts. Run `npm install`
  normally, or `npx patch-package`.
- "installed @supabase/postgrest-js is X": the library version changed. Read the retry code
  in the new version first (CLAUDE.md, "Supabase client library"), then regenerate the patch.

Why patch the library rather than wrap each client: about 90 files build their own client,
and a wrapper missed at any one of them would silently have no retry. Every one of them goes
through this single package.

## Environment variables added by feature

**CALCOM_WEBHOOK_SECRET** (added 2026-09-11, ADR-056). Production and Preview. The secret that
signs Cal.com booking notifications. Generate with `openssl rand -hex 32`, type the same value into
the Cal.com webhook's secret field, and never commit it. Missing: every booking notification is
refused with a 500 and logged. Different from Cal.com's copy: every notification is refused with a
401. Replaces `CALENDLY_WEBHOOK_SECRET`, which was never set in any environment and is no longer read.
