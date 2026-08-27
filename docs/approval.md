# approval.md — Approval System Reference

_Last updated: 2026-06-09. Status section reflects code verified on that date._

---

## Approval system status

**Strategy-document approval: built and active.**
The system for generating, reviewing, approving, and auto-approving strategy documents
(ICP, Positioning, TOV, Messaging) is fully implemented.

**Channel-content approval (cold email sequences, LinkedIn posts, LinkedIn DMs): not yet built.**
See the Channel Summary section below for the forward spec.

---

## Strategy-document approval lifecycle

Agents never write directly to `strategy_documents`. Every agent output lands in
`document_suggestions` as a row with `status = 'pending'`. This is the only path
into the document system.

**Step 1: Suggestion created**

After an agent run completes, a row is inserted into `document_suggestions` with:
- `document_type` (icp, positioning, tov, or messaging)
- `status = 'pending'`
- `organisation_id`
- `suggestion_content` (the full replacement document as JSONB)
- `created_at` (used by the auto-approve cron to calculate the window)

**Step 2: Operator approval**

The operator reviews the suggestion in the dashboard and clicks Approve.
This calls `POST /api/suggestions/[id]/approve`.

The route runs three checks before touching the database:
1. User is authenticated (valid session).
2. User role is `'operator'` (checked on every request, not just at login).
3. Suggestion exists and is in `'pending'` status.

On passing all three checks, it calls the `approve_document_suggestion` Postgres
function via RPC. That function is an atomic transaction that:
- Archives the current active strategy document for the same org and document type
  (sets its status to `'archived'`).
- Inserts a new active strategy document with `version + 1`.
- Marks the suggestion `'approved'` with the reviewer's user ID.

If any step fails, the whole transaction rolls back. The suggestion remains `'pending'`.

**Step 3: Auto-approve escape**

If the operator does not act within the window defined by
`organisations.auto_approve_window_hours` (default: 72 hours), the auto-approve cron
promotes the suggestion automatically.

Route: `POST /api/cron/auto-approve`. Protected by `CRON_SECRET` bearer token.
Uses `service_role` to act across all organisations.

The cron queries all `'pending'` suggestions, checks whether
`created_at + auto_approve_window_hours` has elapsed, and for each due suggestion
calls `approve_document_suggestion` with a sentinel reviewer ID
(`SYSTEM_AUTO_APPROVE_ID = '00000000-0000-0000-0000-000000000001'`).

If the suggestion was already handled (operator approved or rejected between the query
and the RPC call), the cron logs it and moves on cleanly without counting it as an error.

The cron route exists and works. It is currently scheduled via pg_cron (not Vercel Cron,
which is blocked on Hobby for sub-daily schedules). See BACKLOG: "Build a scheduler for
auto-approve timers (DONE 2026-04-23, updated 2026-04-29)" for the scheduling detail.

**Client approval status**

Each strategy document in `strategy_documents` has a `client_approval_status` field.
Once a client approves a document in their dashboard, that field is set to `'approved'`.
All four documents must be `client_approval_status = 'approved'` before the lead upload
gate opens.

---

## Revision staging flow (messaging documents)

When a client submits a revision note on a messaging document, the request goes to
`POST /api/documents/revise`. The revision agent runs on the current document content
and produces a revised version. That revised version does not go live immediately.

Instead, it is staged as a new pending row in `document_suggestions`. The operator
reviews the staged revision in the dashboard. When the operator approves, the
`approve_document_suggestion` RPC archives the previous active document and makes the
revision the new active document (same atomic transaction as a standard approval).

This means client revision requests follow the same approval path as initial agent
suggestions. The operator always reviews before a revision goes live. There is no path
by which a client revision directly replaces an active strategy document.

The archival function used here is `promote_strategy_doc_version`. Both the revision
route and the `approve_document_suggestion` function call it to handle the
segment-scoped NULL-safe archival step. One function, two callers.

---

## Rejection notes reach the next generation run

Two controls take a free-text note about a document, and both notes now steer the run
that replaces it.

| Control | Where the note is stored | What reads it |
|---|---|---|
| Client "Request changes" on a live document | `document_suggestions.revision_note` | the revision agent, `runDocumentRevisionAgent` |
| Operator "Reject and regenerate" in the approval queue | `document_suggestions.rejection_reason` | the generation agent for that document type |

Until 27 August 2026 the operator note was written to the column and never read again.
An operator could reject an ICP suggestion with "remove Canada, Australia and Western
Europe from the geography", watch a new suggestion appear two minutes later, and find all
three still there. Nothing in the UI, the logs or the suggestion's reasoning line said the
instruction had been dropped. See ADR-038.

**How it works now.** `POST /api/suggestions/regenerate` reads both notes off the
suggestion it is rejecting and passes them to the agent as `regeneration_notes`. One
module, `src/lib/agents/regeneration-notes.ts`, turns them into the prompt block and into
the sentence appended to `suggestion_reason`. All four generation agents call it.

**When both notes exist**, which happens when an operator rejects a staged client
revision, both are sent and the prompt says the rejection note wins on conflict. The
client note is the request; the operator note is the correction to the attempt that
answered it. Neither is redundant.

**Reading the receipt.** The new suggestion's reasoning line in the approval queue now
names the note that was supplied. If a regenerated document ignores the note, that is now
a model failure you can see, not a plumbing failure you cannot.

**What still does not carry a note:**
- A plain "Confirm rejection" with no regeneration. The note is recorded and nothing runs.
- A later regeneration through the no-`suggestion_id` path. It does not go looking for the
  last rejected suggestion's note.
- The direct agent triggers at `/api/agents/{icp,positioning,tov,messaging}`.
- The rejected document's own text. Agents refresh from the live approved document, so a
  note that describes the target works and a note that describes a diff ("the second
  paragraph contradicts the third") has nothing to point at.

---

## Launch gate

`assertStrategyApproved` (source: `src/lib/approval/assertStrategyApproved.ts`) is
called at lead upload time before any prospects can be sent to the outbound tool.

It checks that all four documents for the organisation have `client_approval_status = 'approved'`:
- ICP (segment-scoped)
- Messaging (segment-scoped)
- Positioning (org-level, segment_id IS NULL)
- TOV (org-level, segment_id IS NULL)

If any document is missing or not yet client-approved, the upload is blocked and the
caller receives a list of the pending documents by name. No leads are uploaded until
all four pass.

---

## Channel summary (forward spec: not yet built)

The following describes the intended approval model for outbound channel content once
the channel-content approval layer is built. None of this has been implemented in code.
It is spec only.

**cold_email:** Sequence-level approval. The client approves the template, not individual
emails. Optional batch sample (5 to 10 emails) showing personalisation source tags.
Auto-approve window: 3 days. Notification timing: T+0, T+15h, T+48h, T-12h.

**linkedin_post:** Toggle per client, default ON. Dashboard is the approval layer.
Taplio is the publishing layer only. Taplio has no public API for programmatic
scheduling. Approved content is delivered to the Taplio queue manually or via Zapier.
Auto-approve window: 24 hours.

**linkedin_dm:** Same model as cold_email. Auto-approve window: 3 days.

Operator is notified for all rejections and auto-approvals across all channels.

See ADR-010 for the Taplio architecture decision (dashboard approval plus manual Taplio
delivery, no programmatic scheduling API).

---

## What to check if the approval system breaks

**Operator clicks Approve and nothing happens (UI shows an error):**
- Read the error message returned by the API. The route surfaces specific messages for
  the most common failure modes (already approved, invalid content, permission denied).
- Check Supabase logs for errors in the `approve_document_suggestion` function.
- Confirm `service_role` has EXECUTE permission on `approve_document_suggestion`. The
  2026-06-05 incident showed that a security-audit REVOKE can silently remove access
  if the corresponding GRANT is not included in the same migration.

**Auto-approve cron is not running:**
- Verify the pg_cron job exists in Supabase: `SELECT * FROM cron.job;`
- Verify `CRON_SECRET` is hardcoded directly in the job command string (Supabase Hobby
  does not support `current_setting()` for config vars in pg_cron; the workaround is
  to hardcode the value in the command). See BACKLOG: "Supabase Hobby tier: pg_cron
  config vars via ALTER DATABASE SET blocked."
- Check `cron.job_run_details` for the job status and any error output.

**Revision agent produces a suggestion that fails the gate:**
- The revision agent runs the same deterministic validators as initial document generation.
- On gate failure, it retries once with the failure context injected into the prompt.
- If the second pass also fails, the route returns 422 with a human-readable message.
  The client sees the failure reason; no partial document is staged.
