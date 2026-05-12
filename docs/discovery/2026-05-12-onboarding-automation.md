# Discovery: Onboarding Automation Pre-Scoping
**Date:** 2026-05-12
**Status:** Read-only. No code written. No proposals made.
**Purpose:** Establish ground truth before scoping the onboarding automation build.
**Goal framing:** Reduce per-client operator time from ~6–9 hours over 10 days down to ~3 hours of judgment work.

---

## Q1 — Intake completion handoff

**Direct answer:** The 80% critical-field threshold is a warning guard only. It does not fire any downstream action. No API route for intake completion exists. All four strategy agents are manually triggered by the operator.

**Detail:**

The 80% check lives in [src/agents/icp-generation-agent.ts:85–97](../src/agents/icp-generation-agent.ts) and runs inside the ICP agent at invocation time — not at form submission:

```
const completeness = criticalFields.length > 0
  ? Math.round((answeredCritical.length / criticalFields.length) * 100)
  : 0
if (completeness < 80) {
  logger.warn(`ICP agent: intake completeness is ${completeness}% — below 80% threshold...`)
}
```

The agent proceeds regardless. If completeness is below 80%, it injects a warning note into the prompt and records `confidence_level: 'low'` on the resulting `document_suggestions` row ([icp-generation-agent.ts:526–548](../src/agents/icp-generation-agent.ts)).

There is no:
- DB trigger on `intake_responses` that fires on completion
- API route at `/api/intake/complete` or any equivalent
- Automatic chaining from intake completion to agent invocation

The four strategy agents each have their own POST route:
- [src/app/api/agents/icp/route.ts](../src/app/api/agents/icp/route.ts)
- [src/app/api/agents/positioning/route.ts](../src/app/api/agents/positioning/route.ts)
- [src/app/api/agents/tov/route.ts](../src/app/api/agents/tov/route.ts)
- [src/app/api/agents/messaging/route.ts](../src/app/api/agents/messaging/route.ts)

Each must be invoked separately by the operator. No sequencing logic exists between them.

**Inconsistency noted:** ADR-009 ([docs/ADR.md:294–313](../ADR.md)) describes MargenticOS as client zero and implies the agent pipeline runs as a real client workflow. There is no automation between intake completion and agent invocation, meaning the operator currently triggers each of four agents manually after reviewing the intake form.

---

## Q2 — Org creation + user invite today

**Direct answer:** No code creates an organisation row. No user invite mechanism exists. Both are currently manual database operations performed directly in the Supabase dashboard.

**Detail:**

Full list of API routes in the codebase ([src/app/api/](../src/app/api/)):

```
/api/agents/icp           POST — invoke ICP agent
/api/agents/messaging     POST — invoke messaging agent
/api/agents/positioning   POST — invoke positioning agent
/api/agents/tov           POST — invoke TOV agent
/api/agents/app-url-check GET  — environment check
/api/cron/auto-approve    GET  — cron job
/api/cron/instantly-poll  GET  — cron job
/api/cron/process-replies GET  — cron job
/api/intake/files/[id]    GET/DELETE
/api/intake/files/upload  POST
/api/intake/website/fetch POST
/api/operator/faq-extractions/[id]/approve-merge POST
/api/operator/faq-extractions/[id]/approve-new   POST
/api/operator/faq-extractions/[id]/reject        POST
/api/operator/faq-extractions                    GET
/api/operator/faqs/[id]   GET/PATCH/DELETE
/api/operator/faqs        GET/POST
/api/reply-drafts/[id]/approve POST
/api/reply-drafts/[id]/reject  POST
/api/reply-drafts/[id]         GET
/api/reply-drafts              GET
/api/resend-test               POST (dev-gated)
/api/sentry-test               GET (dev-gated)
/api/suggestions/[id]/approve  POST
/api/suggestions/[id]/reject   POST
/api/suggestions/regenerate    POST
/auth/callback                 GET
```

No `/api/operator/orgs`, `/api/admin/invite`, or any equivalent route exists.

`supabase.auth.admin.inviteUserByEmail()` does not appear anywhere in the codebase. Confirmed with full-codebase grep: no results.

No database trigger populates the `users` table from `auth.users`. The migrations directory contains no `CREATE TRIGGER` statement on `auth.users`. Checked all 20 migration files in [supabase/migrations/](../supabase/migrations/).

The migration [supabase/migrations/20260506_organisations_target_and_setup_status.sql](../supabase/migrations/20260506_organisations_target_and_setup_status.sql) explicitly notes for two newly added columns: "Written by: operator (direct DB update until operator UI is built)." This confirms the manual-SQL pattern is the current practice.

ADR-009 ([docs/ADR.md:313](../ADR.md)) states: "The MargenticOS organisation record is the first row in the organisations table." No code creates it.

**BACKLOG note:** [docs/BACKLOG.md:133–150](../BACKLOG.md) references a deferred bug with `resolve-viewing-org.ts`, which was deleted and will need recreating when multi-client scoping is tested with a real non-operator account. This depends on a real client user existing — which in turn depends on an invite mechanism that does not yet exist.

---

## Q3 — Campaigns table population

**Direct answer:** No code in the repository inserts a row into the `campaigns` table. Campaign rows must be created manually (direct SQL or Supabase dashboard) with `external_id` set to the Instantly campaign UUID before the first poll runs. This is an explicitly documented manual step.

**Detail:**

The Instantly polling handler ([src/lib/integrations/polling/instantly.ts:59–85](../src/lib/integrations/polling/instantly.ts)) performs a lookup by `external_id`:

```
const { data } = await supabase
  .from('campaigns')
  .select('id, organisation_id')
  .eq('external_id', instantlyCampaignId)
  .maybeSingle()

if (!resolved) {
  logger.warn('Instantly poll: campaign not found in campaigns table', {
    instantly_campaign_id: instantlyCampaignId,
    fix: 'Insert a row into campaigns with external_id = this value and the correct organisation_id',
  })
}
```

When no row is found, the signal is silently dropped — `organisation_id` is required on every signal write and there is no fallback. The warning log is the only output.

BACKLOG documents this explicitly ([docs/BACKLOG.md:300–305](../BACKLOG.md)):

> "If no campaigns rows exist with external_id set, ALL polling events will be logged as warnings and skipped. Before the first Instantly campaign is created/launched: insert a row in campaigns with external_id = the Instantly campaign UUID, campaign_type = 'cold_email', organisation_id = correct org. This is a manual step at launch time; a UI or agent for campaign provisioning is future scope."

No code calls Instantly's `GET /api/v2/campaigns` to discover campaigns and auto-register them. The campaign analytics handler ([src/lib/integrations/handlers/instantly/campaign-analytics.ts](../src/lib/integrations/handlers/instantly/campaign-analytics.ts)) calls `GET /api/v2/campaigns/analytics` to update `sent_count`, `replied_count`, `bounced_count` on existing rows — it does not create rows.

**Inconsistency noted:** The audit that "flagged a silent failure when this row is missing" is accurately described above. The fix for that silent failure path (the warning log and null return) is in place; what is missing is any mechanism to create the row in the first place.

---

## Q4 — founder_first_name enforcement

**Direct answer:** Enforced at send time only. Not checked at intake or org creation. Three hard-stop enforcement points exist, all in the reply-handling and messaging paths.

**Detail:**

The column was added in [supabase/migrations/20260420_add_founder_first_name_to_organisations.sql](../supabase/migrations/20260420_add_founder_first_name_to_organisations.sql) as `string | null` — it is nullable, so there is no DB-level NOT NULL constraint preventing an org without it from being created.

**Enforcement point 1 — messaging agent** ([src/agents/messaging-generation-agent.ts:411–423](../src/agents/messaging-generation-agent.ts)):
```
const senderFirstName = orgRow?.founder_first_name?.trim() ?? ''
// logs error if missing, proceeds (does not hard-stop generation)
```
This logs an error but does not abort generation. Output is still written to `document_suggestions`.

**Enforcement point 2 — positive reply auto-respond** ([src/lib/reply-handling/process-reply.ts:359–602](../src/lib/reply-handling/process-reply.ts)):
```
const founderFirstName = org?.founder_first_name?.trim() ?? ''
// if empty → returns { action_error: 'founder_first_name_required_but_missing' }
```
Hard stop. No Calendly reply is sent. The signal is written with the error field set.

**Enforcement point 3 — approved draft send** ([src/lib/reply-handling/send-approved-draft.ts:117–133](../src/lib/reply-handling/send-approved-draft.ts)):
```
const founderFirstName = org.founder_first_name?.trim() ?? ''
// if empty → markSendFailed(), returns { kind: 'send_failed', reason: 'founder_first_name_required_but_missing' }
```
Hard stop. The draft is marked failed.

ADR-020 ([docs/ADR.md:1362–1384](../ADR.md)) is explicit: "Populating `organisations.founder_first_name` is a mandatory pre-launch step for every new client." And: "Operator onboarding checklist must include this field as a mandatory step."

No such checklist exists in code. Enforcement is reactive (blocked at send time) not proactive (blocked at org creation or before first agent run).

---

## Q5 — Instantly DFY mailbox API integration

**Direct answer:** No code in the repository calls `/api/v2/dfy-email-account-orders` or any DFY-related Instantly endpoint. The capability is not in the integrations registry. It would be a net-new capability.

**Detail:**

Full-codebase grep for `dfy`, `dfy-email`, `dfy_email`, and `email-account-orders` returns zero results across all `.ts` files.

The integrations registry seed ([supabase/migrations/20260420_seed_integrations_registry.sql:13](../supabase/migrations/20260420_seed_integrations_registry.sql)) contains seven capabilities:

```
can_send_email             → instantly
can_schedule_linkedin_post → taplio
can_send_linkedin_dm       → lemlist
can_enrich_contact         → apollo
can_book_meeting           → calendly
can_track_meeting          → gohighlevel
can_validate_email         → hunter (inactive)
```

No `can_provision_mailbox` or equivalent capability exists.

BACKLOG ([docs/BACKLOG.md:651–704](../BACKLOG.md)) describes the DFY mailbox setup as a series of manual pre-launch steps:

1. Upgrade Instantly to Growth plan ($47/month)
2. Call `POST /api/v2/dfy-email-account-orders/domains/similar` to check domain pool (manually tested 2026-04-24, confirmed working)
3. Order 4 mailboxes across 2 domains (trymargenticos.com, getmargenticos.com) via Instantly web UI
4. Connect mailboxes to Instantly UI

There is no code wrapping any of these steps. A longer-term BACKLOG note ([docs/BACKLOG.md:1469–1470](../BACKLOG.md)) mentions that at 10+ clients, this becomes a meaningful operator task and suggests considering a managed service or the DFY API — framed as future automation, not current scope.

---

## Q6 — Apollo people search → research agent → Instantly upload pipeline

**Direct answer:** The pipeline is: CLI batch script (manual operator trigger) → prospect research agent v2 (4 parallel sources including Apollo) → stores results to DB → compose-sequence reads trigger field → email sequence composed. Apollo is currently blocked (403 on free plan). The Instantly lead upload step does not exist anywhere in the codebase.

**Detail:**

**Step 1 — Trigger mechanism:**
The current trigger is [src/lib/agents/run-dogfood-batch-2.ts](../src/lib/agents/run-dogfood-batch-2.ts), a local CLI script run with `npx tsx --env-file=.env.local`. It passes hardcoded prospect UUIDs to `runProspectResearchAgentV2Batch()`. This is a dogfooding script, not a production operator flow.

**Step 2 — Research agent:**
[src/lib/agents/prospect-research-agent-v2.ts](../src/lib/agents/prospect-research-agent-v2.ts) runs four sources in parallel per prospect:
- LinkedIn (Apify)
- Apollo (`https://api.apollo.io/api/v1/people/match`)
- Website fetch
- Web search

Apollo source ([src/lib/agents/research/sources/apollo.ts:37–73](../src/lib/agents/research/sources/apollo.ts)) returns `available: false` if `APOLLO_API_KEY` is not set and proceeds without it. Currently blocked: Apollo Basic ($49/month) not yet activated (BACKLOG [docs/BACKLOG.md:338–341](../BACKLOG.md)).

Results are synthesized and written to `prospect_research_results`, and three fields are updated on the `prospects` row: `personalisation_trigger`, `has_dateable_signal`, `signal_relevance`.

**Step 3 — Composition:**
[src/lib/composition/compose-sequence.ts:102–106](../src/lib/composition/compose-sequence.ts) reads `prospect.personalisation_trigger` and calls `applyTriggerToEmail1()` to inject the opener into the first email.

**Step 4 — Instantly lead upload:**
No code exists for this. No calls to Instantly `POST /api/v2/leads` or any lead upload endpoint appear anywhere in the codebase (confirmed by grep). The comment in compose-sequence.ts reads: "The caller is responsible for pushing the composed sequence to Instantly." No caller implements this. The path from composed sequence to Instantly campaign lead upload is entirely unbuilt.

**Pipeline gaps:**
- Apollo → research: works (when Apollo plan active), stores to DB
- DB → compose-sequence: works (reads trigger from prospect row)
- Composed sequence → Instantly: **not built**
- Operator trigger → (no UI): currently CLI script only

---

## Q7 — Resend transactional emails

**Direct answer:** `sendTransactionalEmail()` is wired and functional but is not called from any production path. It is used only by the dev-gated test route. Resend templates are explicitly deferred in BACKLOG.

**Detail:**

Infrastructure exists:
- [src/lib/email/client.ts:1–7](../src/lib/email/client.ts) — `Resend` client instance, reads `RESEND_API_KEY`
- [src/lib/email/send.ts:31–53](../src/lib/email/send.ts) — `sendTransactionalEmail()` function, Sentry-logged, handles success/failure cleanly

The only caller is [src/app/api/resend-test/route.ts](../src/app/api/resend-test/route.ts) — a dev-gated diagnostic route. No other file imports `sendTransactionalEmail`.

BACKLOG ([docs/BACKLOG.md:578–583](../BACKLOG.md)) documents the current state:

> "resend SDK installed. Single client instance in src/lib/email/client.ts. Generic sendTransactionalEmail() in src/lib/email/send.ts — Sentry-logged failures, dev-only onboarding@resend.dev fallback, throws at load in non-dev if RESEND_FROM_EMAIL missing. Test route at /api/resend-test (dev-gated). Verified: email delivered to doug@margenticos.com inbox. Sending domain: notifications.margenticos.com (Resend EU). Templates deferred until features need them."

BACKLOG note at line 1549: "Currently safe: the only caller is the dev-gated /api/resend-test route."

The sending domain (`notifications.margenticos.com`) is confirmed configured. The infrastructure is ready. No templates exist.

---

## Summary table

| Question | Current state | Code location | Manual or automated |
|---|---|---|---|
| 80% completion fires agents? | Warning only, no trigger | [icp-generation-agent.ts:85–97](../src/agents/icp-generation-agent.ts) | Manual |
| `/api/intake/complete` exists? | No | — | — |
| 4 agents auto-chain after intake? | No — separate POST each | [src/app/api/agents/](../src/app/api/agents/) | Manual (operator) |
| Org creation route? | None | — | Manual SQL |
| User invite? | `inviteUserByEmail()` absent | — | Manual |
| Auth → users trigger? | No trigger exists | [supabase/migrations/](../supabase/migrations/) | Manual |
| Campaigns row created by code? | No insert anywhere | [polling/instantly.ts:77–82](../src/lib/integrations/polling/instantly.ts) | Manual SQL |
| Instantly campaign reconciliation? | Analytics only (no auto-register) | [campaign-analytics.ts](../src/lib/integrations/handlers/instantly/campaign-analytics.ts) | Manual |
| `founder_first_name` check at org create? | No | — | Absent |
| `founder_first_name` check at send time? | Yes — hard stop | [process-reply.ts:584](../src/lib/reply-handling/process-reply.ts), [send-approved-draft.ts:127–133](../src/lib/reply-handling/send-approved-draft.ts) | Enforced |
| DFY mailbox API in codebase? | No — zero references | — | Manual (Instantly UI) |
| `can_provision_mailbox` in registry? | No slot exists | [seed_integrations_registry.sql](../supabase/migrations/20260420_seed_integrations_registry.sql) | Net-new |
| Apollo → research agent? | Built, Apollo plan blocked | [prospect-research-agent-v2.ts](../src/lib/agents/prospect-research-agent-v2.ts) | Manual (CLI script) |
| Composed sequence → Instantly upload? | Not built | — | Absent |
| `sendTransactionalEmail()` in production? | Not used in any production path | [send.ts:31](../src/lib/email/send.ts) | Dev-only test route |

---

## OPEN QUESTIONS

1. **Org creation intent for onboarding:** The current manual SQL process implies Doug creates the org row himself before a client can log in at all. Is the onboarding automation goal to automate this first row creation (a form Doug fills out → org provisioned), or does it start after the org already exists?

2. **User invite flow scope:** The BACKLOG defers a multi-user client bug until a real non-operator account exists ([BACKLOG.md:133–150](../BACKLOG.md)). Does onboarding automation need to ship `inviteUserByEmail()` and the associated `users` table trigger as a prerequisite, or is client login out of scope for this build?

3. **Campaign row creation automation:** The BACKLOG explicitly notes this as future scope ([BACKLOG.md:304](../BACKLOG.md)). Should the onboarding build include an operator UI or API route to register a campaign's Instantly UUID against the org, or remain manual?

4. **Instantly lead upload (composed sequence → campaign):** This is a significant gap — the pipeline from research → composition exists, but composed sequences are never pushed to Instantly. Is this a dependency for the onboarding build, or is the initial launch model still "operator exports from dashboard and uploads to Instantly manually"?

5. **Apollo activation timing:** Apollo Basic ($49/month) is required for the research pipeline to run on real clients ([BACKLOG.md:338](../BACKLOG.md)). Does the onboarding automation build assume Apollo is active, or does it need to gate gracefully when it is not?

6. **DFY mailbox API scope:** BACKLOG marks DFY mailbox ordering as a manual pre-launch step. Should onboarding automation include any API calls to the DFY endpoint, or remain a documented manual checklist item?

7. **Resend email templates:** The infrastructure is ready. What transactional emails should onboarding trigger? Candidates include: welcome email (magic link invite), intake-ready confirmation to operator, agent-run-complete notification. None are currently specced or templated.

8. **`setup_status` column and the operator checklist:** The `organisations.setup_status` column ([20260506_organisations_target_and_setup_status.sql](../supabase/migrations/20260506_organisations_target_and_setup_status.sql)) tracks campaign and LinkedIn setup progress. The comment says "Written by: operator (direct DB update)." Is the onboarding automation build intended to create the operator UI that writes to this field, or is that separate?
