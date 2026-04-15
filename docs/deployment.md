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
