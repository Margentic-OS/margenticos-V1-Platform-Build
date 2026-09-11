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

## Environment variables added by feature

**CALCOM_WEBHOOK_SECRET** (added 2026-09-11, ADR-056). Production and Preview. The secret that
signs Cal.com booking notifications. Generate with `openssl rand -hex 32`, type the same value into
the Cal.com webhook's secret field, and never commit it. Missing: every booking notification is
refused with a 500 and logged. Different from Cal.com's copy: every notification is refused with a
401. Replaces `CALENDLY_WEBHOOK_SECRET`, which was never set in any environment and is no longer read.
