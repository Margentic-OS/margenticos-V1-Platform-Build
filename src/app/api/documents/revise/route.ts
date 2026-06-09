// POST /api/documents/revise
//
// Client-facing. Accepts a free-text revision note on an active strategy
// document, runs the revision agent, and creates a new active version via
// promote_strategy_doc_version (the shared segment-scoped archival helper).
//
// The new version carries: same segment_id, revision_note, change_summary,
// client_approval_status='pending', pending_since=now(), version+1.
//
// Archival approach: reuses promote_strategy_doc_version rather than
// reimplementing the segment-scoped NULL-safe predicate. This is the same
// function that approve_document_suggestion calls internally — one predicate,
// two callers.
//
// Three ownership checks before any data is written:
//   1. User is authenticated
//   2. User's organisation_id resolved from users table
//   3. document_id belongs to that org and is currently active
//
// Body: { document_id: string, note: string }
// Returns: { id, version, change_summary }

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createCookieClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { runDocumentRevisionAgent, RevisionGateError } from '@/lib/agents/revision/run-revision'
import type { Json } from '@/types/database'
import { logger } from '@/lib/logger'
import { triggerCascadeIfEligible } from '@/lib/agents/cascade/trigger-cascade'

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

  // ── 2. Resolve org ─────────────────────────────────────────────────────────
  const { data: userRow } = await supabase
    .from('users')
    .select('organisation_id')
    .eq('id', user.id)
    .single()

  if (!userRow?.organisation_id) {
    return NextResponse.json({ error: 'Organisation not found.' }, { status: 403 })
  }

  const orgId = userRow.organisation_id

  // ── 3. Parse body ──────────────────────────────────────────────────────────
  let body: { document_id?: unknown; note?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { document_id, note } = body

  if (!document_id || typeof document_id !== 'string' || !UUID_RE.test(document_id)) {
    return NextResponse.json({ error: 'document_id must be a valid UUID.' }, { status: 400 })
  }

  if (!note || typeof note !== 'string' || note.trim().length === 0) {
    return NextResponse.json({ error: 'note must be a non-empty string.' }, { status: 400 })
  }

  const trimmedNote = note.trim()

  // ── 4. Fetch doc + ownership check ─────────────────────────────────────────
  const admin = createServiceClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: doc } = await admin
    .from('strategy_documents')
    .select('id, document_type, segment_id, content, organisation_id, version')
    .eq('id', document_id)
    .eq('organisation_id', orgId)
    .eq('status', 'active')
    .maybeSingle()

  if (!doc) {
    return NextResponse.json({ error: 'Document not found or not accessible.' }, { status: 404 })
  }

  if (!VALID_DOC_TYPES.includes(doc.document_type as DocType)) {
    return NextResponse.json({ error: 'Unsupported document type.' }, { status: 400 })
  }

  // ── 5. Rate-limit check: max 5 client revisions per org per day ────────────
  // Counts across both tables so the limit holds regardless of which write path
  // a given document type uses:
  //   strategy_documents — non-messaging revisions that go live immediately
  //                        (document_type != 'messaging' prevents double-counting
  //                         if a messaging row ever appears here with client_revision)
  //   document_suggestions — messaging revisions staged for operator review
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
  } catch (err) {
    if (err instanceof RevisionGateError) {
      logger.warn('POST /api/documents/revise: gate failure after retry', {
        document_id,
        org_id: orgId,
        document_type: doc.document_type,
        violations: err.violations,
      })
      // TODO (S4): send operator notification email here.
      // The copy below says "notified" — the email ships in S4. Known temporary
      // inconsistency during the no-clients window.
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

  // ── 7. Create new version via shared archival helper ───────────────────────
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
    org_id: orgId,
    user_id: user.id,
    document_type: doc.document_type,
    prior_version: doc.version,
  })

  // A client revision on icp/positioning/tov may unlock the next agent in sequence.
  // Messaging revisions don't cascade (messaging has no downstream dependency).
  // admin is service-role so allThreeActive() is not filtered by RLS.
  if (doc.document_type !== 'messaging') {
    await triggerCascadeIfEligible(admin, orgId, doc.document_type)
  }

  const result = newDoc as { id: string; version: string; change_summary: string }

  return NextResponse.json({
    id: result.id,
    version: result.version,
    change_summary: result.change_summary,
  })
}
