# auth.md — Authentication and Access Control
# Stub — fill in during auth build session.
# Cover: roles, access control, multi-user client setup, what to check if auth breaks.
# The spec is in /prd/sections/04-auth.md.

## Authentication method
Supabase Auth with magic link (passwordless). Not yet configured.

## Roles
operator — Doug. Full access.
client   — Client founders. Own organisation only.

## Setup status
[Supabase project not yet connected]

## Three-check rule reminder
Every API route must verify: (1) authenticated, (2) correct role, (3) correct client_id.
