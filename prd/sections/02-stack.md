# sections/02-stack.md — Technology Stack, Tool Registry Pattern
# MargenticOS PRD | April 2026
# Read prd/PRD.md first, then this section when working on any infrastructure, integration, or stack decision.

---

## Core technology stack

  Framework:        Next.js 14+ (App Router)
  Language:         TypeScript — always, no exceptions
  Styling:          Tailwind CSS — always, no inline styles, no separate CSS files
  Database:         Supabase (PostgreSQL + Auth + Storage + RLS)
  Deployment:       Vercel
  Error monitoring: Sentry
  Transactional email: Resend

All new code must follow the conventions in CLAUDE.md:
  - One component = one responsibility
  - Descriptive names (handleApprovalSubmission not handleSubmit)
  - Plain English comment above complex logic explaining WHY it exists
  - All logging through the project logger module — never console.log directly

---

## Model selection for Anthropic API calls

Always pass the model name explicitly. Never rely on defaults.

  Document generation agents (ICP, Positioning, TOV, Messaging):  claude-opus-4-5
  Building, debugging, refactoring:                               claude-sonnet-4-5
  Signal processing, lightweight agent tasks:                     claude-haiku-4-5-20251001
  Batch processing, transcript ingestion:                         claude-haiku-4-5-20251001

Test Opus vs Sonnet for document generation quality before locking in a final choice.
Never use a more expensive model than the task requires.

---

## Tool registry pattern — the most important architectural decision

Nothing is hardcoded to a specific vendor. Ever.

### How it works

Every external tool is registered in the integrations_registry table with:
  - tool_name: human-readable name (e.g. "Instantly")
  - capability: what it does (e.g. "can_send_email")
  - is_active: boolean — which tool is currently handling this capability
  - api_handler_ref: string reference to the handler function
  - connection_status: connected / disconnected / error
  - config: JSONB for tool-specific settings

The system always references capabilities, never tool names:

  can_send_email              → currently: Instantly
  can_schedule_linkedin_post  → currently: Taplio (content delivery model — see below)
  can_send_linkedin_dm        → currently: Lemlist
  can_enrich_contact          → currently: Apollo
  can_book_meeting            → currently: Calendly
  can_validate_email          → currently: Hunter.io (phase two)

### Handler pattern

Each capability has one handler function. The handler is the only place
where tool-specific code lives. Agents call the capability, not the tool.

  Wrong: await instantly.sendEmail({ ... })
  Right: await executeCapability('can_send_email', { ... })

The executeCapability function looks up the registered handler for that capability
and calls it. If Instantly is swapped for Lemlist for email, only the handler changes.
No agent, no component, no other code changes.

### Taplio content delivery model

The can_schedule_linkedin_post capability uses a content delivery model,
not a programmatic scheduling API.

Taplio has no public API for post scheduling (verified April 2026).
The handler for this capability marks the post as approved and ready-to-deliver,
then signals Doug to push it to Taplio manually or via Zapier.

Do not attempt to build a direct API integration with Taplio.
See ADR-004 and ADR-010 in /docs/ADR.md for the full reasoning.

### Swapping tools

To swap a tool:
  1. Update integrations_registry — set is_active = false on old tool, add new row
  2. Write a new handler function for the capability
  3. Nothing else changes — zero impact on agents or components

To add a new tool:
  1. Add a new row to integrations_registry
  2. Write a handler function
  3. Nothing else changes

This is the architectural decision that makes the entire product extensible without rebuilds.

---

## Environments

  development:  local — Supabase local or dedicated dev project
  staging:      Vercel preview — automatic on push to any non-main branch
  production:   Vercel main — only after staging verified

Separate environment variables in Vercel for each environment.
Never push to production without staging verification.
Never skip staging for any reason.

---

## External tools in scope (phase one)

  Instantly       Cold email sending and sequence management
  Taplio          LinkedIn content delivery (post queue, manual/Zapier delivery)
  Lemlist         LinkedIn DM outreach
  Apollo          Prospect enrichment and contact data
  GoHighLevel     CRM, meeting tracking, client communication
  Calendly        Meeting booking (or client's existing booking tool)
  Resend          Transactional email from MargenticOS (approval notifications, 90-day refresh)
  Sentry          Error monitoring

Phase two additions:
  Hunter.io       Email validation (can_validate_email)
