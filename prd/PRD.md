# MargenticOS — Product Requirements Document
# Version 1.0 | April 2026
# Hub document — read this first, then the relevant section for what you are building.

---

## What this is

This PRD is the source of truth for the MargenticOS build.
It is structured as a hub with section sub-documents so Claude Code can load
only the relevant section for the current build task without overloading context.

Always read this hub first. Then read the section file for the area you are working on.
If something is not covered here or in a section, ask Doug before proceeding.

---

## Important notes before building anything

**Phases are subject to change.** The phasing plan is a guide, not a contract.
As the build progresses and Doug learns what works, priorities will shift.
When scope changes, update the relevant section file and note the change date.

**Doug is a beginner at Claude Code.** See CLAUDE.md for how to work with him.
Every session must include plain English explanations of what is being built and why.
When manual steps are required, stop and provide exact instructions.

**This is phase one of a larger vision.** The full MargenticOS product includes
referral tools, SEO, website generation, paid ads, and nurture sequences.
Do not build for that vision now. Build the foundation specified here.
The tool-agnostic architecture and modular agent design make the rest addable later.

---

## Product summary

MargenticOS is an agentic services platform. Doug delivers AI-powered pipeline
generation for founder-led B2B consulting firms ($300K–$3M revenue, 3+ years
operating, referral-dependent pipeline, no repeatable marketing system).

Clients receive: four living strategy documents + a results dashboard.
Doug operates: an agent pipeline that prospects, personalises, and executes
outbound through Instantly (cold email), Taplio (LinkedIn content delivery),
Lemlist (LinkedIn DMs), Apollo (prospecting), and GoHighLevel (CRM).

Clients never see the execution layer. They see their IP and their results.

---

## Core architectural principles

**Tool agnosticism:** Every external tool is registered in the integrations_registry.
The system references capabilities, not tool names. See sections/02-stack.md.

**Agent isolation:** Every agent operates strictly within one client's context.
Cross-client data flow is never permitted except via the anonymised patterns table.
See sections/06-agents.md.

**Security by default:** Supabase RLS enforced on every table before any data is written.
All credentials stored in environment variables. Three-check auth on every API route.
See sections/04-auth.md.

**Resilience by discipline:** Git commits before and after every significant change.
Three environments. Sentry monitoring. /docs updated every session.

**Suggestion queue over autonomous updates:** Agents never update documents directly.
They write suggestions. Doug approves. Documents version.
See sections/07-feedback-loop.md.

---

## Section index

Read the hub (this file) first. Then load the relevant section.

  sections/01-product.md        Target client, offer, commercial model
  sections/02-stack.md          Technology stack, tool registry pattern
  sections/03-data-model.md     All database tables, fields, RLS policies
  sections/04-auth.md           Authentication, roles, multi-user access
  sections/05-intake.md         Questionnaire, file upload, website ingestion
  sections/06-agents.md         All agents: purpose, inputs, outputs, isolation
  sections/07-feedback-loop.md  Signal thresholds, suggestion queue, A/B testing
  sections/08-approval.md       Channel modes, notification timing, batch sampling
  sections/09-reply-handling.md Reply types, routing, escalation, opt-out
  sections/10-signals.md        Signal types, processing, pattern library
  sections/11-warnings.md       Warning types, thresholds, tiered response protocol
  sections/12-dashboard.md      All five views, components, phased unlock
  sections/13-integrations.md   Registry pattern, each tool, webhook events, setup
  sections/14-phasing.md        Phase one through four with deliverables

---

## Current build status

Phase: 1 — Foundation
Active sections: 01, 02, 03, 04, 05, 06, 12, 13, 14
Next milestone: Supabase setup, auth, intake questionnaire, document generation agents

Last updated: April 2026
