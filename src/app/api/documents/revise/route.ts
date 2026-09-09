// POST /api/documents/revise
//
// Client-facing. Accepts a free-text revision note on an active strategy
// document, runs the revision agent, and creates a new active version via
// promote_strategy_doc_version (the shared segment-scoped archival helper).
//
// The new version carries: same segment_id, revision_note, change_summary, version+1.
// It is live immediately. Client approval on strategy documents was removed 2026-09-03,
// see ADR-047.
//
// Archival approach: reuses promote_strategy_doc_version rather than
// reimplementing the segment-scoped NULL-safe predicate. This is the same
// function that approve_document_suggestion calls internally; one predicate,
// two callers.
//
// Three ownership checks before any data is written:
//   1. User is authenticated
//   2. The organisation being acted on is resolved, and the caller is allowed it
//   3. document_id belongs to THAT org and is currently live
//
// ─── WHO THE REVISION IS FOR, 2026-09-07 ─────────────────────────────────────
//
// The organisation used to come from the caller's own user row, always. The strategy
// page honours ?client= for operators and sends that client's document id, so an
// operator asking for a change on a client's document searched for the right document
// inside their own organisation and got "not found". Measured before this change: all
// twenty live documents were revisable by their own client and none by an operator.
//
// The target is now posted by the control and authorised here, which is the pattern
// /api/suggestions/regenerate already uses. An operator may name any organisation. A
// non-operator naming an organisation that is not theirs is REFUSED, not silently
// redirected to their own: 403, because they are not allowed, rather than 404, which
// would say the document does not exist and be a different and untrue statement.
//
// Body: { document_id: string, note: string, client_id?: string }
//   client_id is the organisation being viewed. Absent means "my own", which is what
//   every client sends and what an operator on their own dashboard sends.
// Returns: { id, version, change_summary }

import { NextRequest, NextResponse, after } from 'next/server'
import { createClient as createCookieClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { runDocumentRevisionAgent, RevisionGateError } from '@/lib/agents/revision/run-revision'
import type { Json } from '@/types/database'
import { renderDocumentPlainText } from '@/lib/documents/render-plain-text'
import { logger } from '@/lib/logger'
import { LIVE_DOCUMENT_STATUSES } from '@/lib/documents/live-document-statuses'
import { triggerCascadeIfEligible } from '@/lib/agents/cascade/trigger-cascade'
import { persistIcpFilterSpec } from '@/lib/sourcing/persist-icp-filter-spec'
import { sendTransactionalEmail } from '@/lib/email/send'
import { revisionGateFailureTemplate, revisionGateFailureSubject } from '@/lib/email/templates/revision-gate-failure'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VALID_DOC_TYPES = ['icp', 'positioning', 'tov', 'messaging'] as const
type DocType = (typeof VALID_DOC_TYPES)[number]

export async function POST(request: NextRequest) {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const supabase = await createCookieClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  // ── 2. Parse body ──────────────────────────────────────────────────────────
  let body: { document_id?: unknown; note?: unknown; client_id?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { document_id, note, client_id } = body

  if (!document_id || typeof document_id !== 'string' || !UUID_RE.test(document_id)) {
    return NextResponse.json({ error: 'document_id must be a valid UUID.' }, { status: 400 })
  }

  if (!note || typeof note !== 'string' || note.trim().length === 0) {
    return NextResponse.json({ error: 'note must be a non-empty string.' }, { status: 400 })
  }

  // Validated syntactically before it reaches a uuid-typed column, so a malformed value
  // is a 400 here rather than an invalid-input-syntax error out of Postgres.
  if (client_id !== undefined && (typeof client_id !== 'string' || !UUID_RE.test(client_id))) {
    return NextResponse.json({ error: 'client_id must be a valid UUID.' }, { status: 400 })
  }

  const trimmedNote = note.trim()

  const admin = createServiceClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // ── 3. Resolve the caller, then the organisation being acted on ────────────
  //
  // Read through the service client, not the caller's session. This read decides an
  // authorisation question, and a row hidden by RLS is indistinguishable here from a
  // user who has no role. Reading it as service role means the answer is the row, not
  // the policy's opinion of the row. Identity still comes from auth.getUser() above,
  // which is the part that actually authenticates.
  const { data: userRow, error: userError } = await admin
    .from('users')
    .select('role, organisation_id')
    .eq('id', user.id)
    .single()

  if (userError || !userRow?.organisation_id) {
    return NextResponse.json({ error: 'Organisation not found.' }, { status: 403 })
  }

  const isOperator = userRow.role === 'operator'
  const callerOrgId = userRow.organisation_id

  if (!isOperator && client_id && client_id !== callerOrgId) {
    logger.warn('POST /api/documents/revise: non-operator named another organisation', {
      user_id:       user.id,
      caller_org:    callerOrgId,
      requested_org: client_id,
    })
    return NextResponse.json({ error: 'Not authorized for this client.' }, { status: 403 })
  }

  const orgId = isOperator && client_id ? client_id : callerOrgId

  // ── 4. Fetch doc + ownership check ─────────────────────────────────────────
  const { data: doc, error: docError } = await admin
    .from('strategy_documents')
    .select('id, document_type, segment_id, content, organisation_id, version')
    .eq('id', document_id)
    .eq('organisation_id', orgId)
    .in('status', LIVE_DOCUMENT_STATUSES)
    .maybeSingle()

  // A failed read is not an absent document. This error used to be discarded, so a bad
  // service key or a dropped connection reached the client as "not found", which sends
  // whoever debugs it looking for a missing row that was there all along.
  if (docError) {
    logger.error('POST /api/documents/revise: document lookup failed', {
      document_id,
      org_id: orgId,
      error:  docError.message,
    })
    return NextResponse.json({ error: 'Could not load the document. Try again.' }, { status: 500 })
  }

  if (!doc) {
    return NextResponse.json({ error: 'Document not found or not accessible.' }, { status: 404 })
  }

  if (!VALID_DOC_TYPES.includes(doc.document_type as DocType)) {
    return NextResponse.json({ error: 'Unsupported document type.' }, { status: 400 })
  }

  // ── 5. Rate-limit check: max 5 client revisions per org per day ────────────
  // Counts across both tables so the limit holds regardless of which write path
  // a given document type uses:
  //   strategy_documents: non-messaging revisions that go live immediately
  //                        (document_type != 'messaging' prevents double-counting
  //                         if a messaging row ever appears here with client_revision)
  //   document_suggestions: messaging revisions staged for operator review
  const todayUtcMidnight = new Date()
  todayUtcMidnight.setUTCHours(0, 0, 0, 0)
  const todayIso = todayUtcMidnight.toISOString()

  const [{ count: liveCount }, { count: stagedCount }] = await Promise.all([
    admin
      .from('strategy_documents')
      .select('id', { count: 'exact', head: true })
      .eq('organisation_id', orgId)
      .eq('update_trigger', 'client_revision')
      .neq('document_type', 'messaging')
      .gte('created_at', todayIso),
    admin
      .from('document_suggestions')
      .select('id', { count: 'exact', head: true })
      .eq('organisation_id', orgId)
      .eq('update_trigger', 'client_revision')
      .eq('status', 'pending')
      .gte('created_at', todayIso),
  ])

  if ((liveCount ?? 0) + (stagedCount ?? 0) >= 5) {
    return NextResponse.json(
      { error: "You've requested a lot of changes today. Try again tomorrow, or contact your outbound team if something is urgent." },
      { status: 429 },
    )
  }

  // ── 6. Run revision agent ──────────────────────────────────────────────────
  let revised_content: unknown
  let change_summary: string
  let model_used: string

  try {
    const result = await runDocumentRevisionAgent({
      organisation_id: orgId,
      document_type: doc.document_type as DocType,
      current_content: doc.content,
      revision_note: trimmedNote,
      supabase: admin,
    })
    revised_content = result.revised_content
    change_summary = result.change_summary
    model_used = result.model_used
  } catch (err) {
    if (err instanceof RevisionGateError) {
      logger.warn('POST /api/documents/revise: gate failure after retry', {
        document_id,
        org_id: orgId,
        document_type: doc.document_type,
        violations: err.violations,
      })

      const operatorEmail = process.env.RESEND_OPERATOR_EMAIL
      if (operatorEmail) {
        try {
          const { data: orgRow } = await admin
            .from('organisations')
            .select('name')
            .eq('id', orgId)
            .single()
          const orgName = orgRow?.name ?? orgId
          await sendTransactionalEmail({
            to: operatorEmail,
            // Internal alert. Exempt from the customer-facing style rules, never from the
            // rendering checks. See EmailAudience in src/lib/email/send.ts.
            audience: 'operator',
            subject: revisionGateFailureSubject(orgName, doc.document_type),
            html: revisionGateFailureTemplate({
              orgName,
              orgId,
              docType: doc.document_type,
              revisionNote: trimmedNote,
            }),
          })
        } catch (emailErr) {
          logger.warn('POST /api/documents/revise: gate failure notification email failed', {
            document_id,
            org_id: orgId,
            error: emailErr instanceof Error ? emailErr.message : String(emailErr),
          })
        }
      }

      return NextResponse.json(
        { error: "We couldn't apply this change while keeping the content within your outbound guidelines. Your outbound team has been notified and will review it manually." },
        { status: 422 },
      )
    }
    logger.error('POST /api/documents/revise: revision agent failed', {
      document_id,
      org_id: orgId,
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: 'Revision agent failed. Try again.' }, { status: 500 })
  }

  // ── 7a. Messaging: stage as pending suggestion for operator review ──────────
  // Messaging revisions do not go live immediately. The active strategy_documents
  // row is left untouched until an operator approves the staged suggestion.
  if (doc.document_type === 'messaging') {
    const { data: suggestion, error: insertError } = await admin
      .from('document_suggestions')
      .insert({
        organisation_id: orgId,
        document_type:   'messaging',
        field_path:      'full_document',
        status:          'pending',
        update_trigger:  'client_revision',
        revision_note:   trimmedNote,
        suggestion_reason: change_summary,
        suggested_value: JSON.stringify(revised_content),
        segment_id:      doc.segment_id,
        document_id:     doc.id,
        // Recorded on the suggestion, not at approval. A staged messaging revision can sit
        // pending for days and be auto-approved later, so reading a model constant at
        // approval time would attribute this copy to whatever the code names then.
        generated_by_model: model_used,
      })
      .select('id')
      .single()

    if (insertError) {
      if (insertError.code === '23505') {
        return NextResponse.json(
          { error: "A revision is already waiting for your outbound team to review. You'll be able to request another change once that one is processed." },
          { status: 409 },
        )
      }
      logger.error('POST /api/documents/revise: document_suggestions insert failed', {
        document_id,
        org_id: orgId,
        error: insertError.message,
      })
      return NextResponse.json({ error: 'Failed to stage revision for review.' }, { status: 500 })
    }

    logger.info('POST /api/documents/revise: messaging revision staged', {
      original_doc_id: document_id,
      suggestion_id:   suggestion?.id,
      org_id:          orgId,
      user_id:         user.id,
      on_behalf:       orgId !== callerOrgId,
    })

    return NextResponse.json({ staged: true, suggestion_id: suggestion?.id ?? null })
  }

  // ── 7b. Non-messaging: promote live via shared archival helper ──────────────
  // promote_strategy_doc_version handles the segment-scoped NULL-safe archival
  // (IS NOT DISTINCT FROM) and inserts the new active version with pending approval.
  const { data: newDoc, error: rpcError } = await admin.rpc('promote_strategy_doc_version', {
    p_org_id:         doc.organisation_id,
    p_doc_type:       doc.document_type,
    p_segment_id:     doc.segment_id as string,
    p_content:        revised_content as Json,
    p_update_trigger: 'client_revision',
    p_revision_note:  trimmedNote,
    p_change_summary: change_summary,
    // Rendered from the content being promoted, by the one renderer. Without this the
    // revision path would keep writing plain_text NULL and quietly rebuild the hole the
    // backfill just closed, on the one path a CLIENT triggers.
    p_plain_text:     renderDocumentPlainText(revised_content),
    // Reported by the revision agent rather than read from its module constant here, so the
    // stored attribution is what actually ran.
    p_generated_by_model: model_used,
  })

  if (rpcError) {
    logger.error('POST /api/documents/revise: promote_strategy_doc_version failed', {
      document_id,
      org_id: orgId,
      error: rpcError.message,
    })
    return NextResponse.json({ error: 'Failed to create new document version.' }, { status: 500 })
  }

  logger.info('POST /api/documents/revise: revision created', {
    original_doc_id: document_id,
    org_id:          orgId,
    user_id:         user.id,
    document_type:   doc.document_type,
    prior_version:   doc.version,
    on_behalf:       orgId !== callerOrgId,
  })

  const result = newDoc as { id: string; version: string; change_summary: string }

  // ─── THE DEFECT FIXED HERE, 2026-09-03 ──────────────────────────────────────
  //
  // This route promoted a new ICP and never derived its filter spec, so a client
  // revision to the prospect profile produced a live ICP with icp_filter_spec NULL,
  // permanently. Measured on production: every active ICP with update_trigger
  // 'client_revision' had a NULL spec, and every one from the suggestion path had a
  // populated one. A clean split along the code path, not a coincidence.
  //
  // The consequence is not silent, which is the only reason it had not caused damage:
  // the sourcing orchestrator fails loudly on a NULL spec. But it means a client
  // revising their own prospect profile broke sourcing until somebody regenerated
  // through the other path, and nothing said why.
  //
  // In after() for the same reason the approval path does it: persistIcpFilterSpec makes
  // an LLM call to derive the buyer criterion, and this request has already spent most of
  // its 300 seconds running the revision agent. It never throws and never fails the
  // promotion.
  after(async () => {
    if (result?.id) {
      await persistIcpFilterSpec(admin, result.id)
    }
    // Revisions may unlock the next agent in the sequence.
    // admin is service-role so allThreeActive() is not filtered by RLS.
    await triggerCascadeIfEligible(admin, orgId, doc.document_type)
  })

  return NextResponse.json({
    id: result.id,
    version: result.version,
    change_summary: result.change_summary,
  })
}
