// GET  /api/operator/faq-seed?client=<orgId>   — what the button should say
// POST /api/operator/faq-seed                  — run the FAQ seed agent for one org
//
// Operator-only, both methods. ADR-021: operator endpoints are cross-org, so there is no
// org filter on the auth check itself; the organisation is named in the request and every
// query below filters on it explicitly (ADR-003, enforcement level 2).
//
// This route is the seed agent's only caller. Candidates it writes land in
// faq_extractions as source='seed_generated', status='pending', and cannot reach a
// prospect-facing draft until an operator approves them: the drafter calls findFaqMatches
// with includePendingExtractions false (draft-orchestrator.ts).

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { logger } from '@/lib/logger'
import { requireOperator } from '@/lib/supabase/require-operator'
import { generateFaqSeedCandidates } from '@/lib/agents/faq-seed-agent'
import { claimSeedRun, releaseSeedRun, abandonSeedRun } from '@/lib/faq/seed-run-claim'

export const dynamic = 'force-dynamic'
// The agent's own budget is 240s (see faq-seed-agent.ts), leaving the rest of this for
// loading documents and writing candidates.
export const maxDuration = 300

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const REQUIRED_DOCUMENT_TYPES = ['icp', 'positioning', 'tov', 'messaging'] as const
type RequiredDocumentType = (typeof REQUIRED_DOCUMENT_TYPES)[number]

const DOCUMENT_LABELS: Record<RequiredDocumentType, string> = {
  icp: 'ICP document',
  positioning: 'Positioning document',
  tov: 'Tone of Voice guide',
  messaging: 'Messaging document',
}

async function buildSessionClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        },
      },
    }
  )
}

function buildServiceClient() {
  return createServiceClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function denied(user: unknown) {
  return NextResponse.json(
    { error: user ? 'Operator access required.' : 'Not authenticated.' },
    { status: user ? 403 : 401 },
  )
}

// ── Shared reads ──────────────────────────────────────────────────────────────

/** Seed candidates still waiting on an operator. The number the duplicate guard turns on. */
async function countPendingSeedCandidates(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  orgId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('faq_extractions')
    .select('id', { count: 'exact', head: true })
    .eq('organisation_id', orgId)
    .eq('source', 'seed_generated')
    .eq('status', 'pending')

  if (error) throw new Error(`could not count pending seed candidates — ${error.message}`)
  return count ?? 0
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readLastRun(supabase: any, orgId: string) {
  const { data, error } = await supabase
    .from('faq_seed_runs')
    .select('id, state, started_at, finished_at, candidates_created, error_message')
    .eq('organisation_id', orgId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`could not read the seed run history — ${error.message}`)
  return data ?? null
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const sessionClient = await buildSessionClient()
  const supabase = buildServiceClient()
  const { user, authorized } = await requireOperator(sessionClient, supabase)
  if (!authorized) return denied(user)

  const orgId = request.nextUrl.searchParams.get('client')
  if (!orgId || !UUID_RE.test(orgId)) {
    return NextResponse.json({ error: 'client parameter is required and must be a valid org ID.' }, { status: 400 })
  }

  try {
    const [pendingSeedCount, lastRun] = await Promise.all([
      countPendingSeedCandidates(supabase, orgId),
      readLastRun(supabase, orgId),
    ])

    return NextResponse.json({
      pending_seed_count: pendingSeedCount,
      last_run: lastRun,
      running: lastRun?.state === 'running',
    }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('GET /api/operator/faq-seed: read failed', { org_id: orgId, error: message })
    return NextResponse.json({ error: 'Failed to load seed status.' }, { status: 500 })
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const sessionClient = await buildSessionClient()
  const supabase = buildServiceClient()
  const { user, authorized } = await requireOperator(sessionClient, supabase)
  if (!authorized) return denied(user)

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const orgId = body.organisation_id
  if (!orgId || typeof orgId !== 'string' || !UUID_RE.test(orgId)) {
    return NextResponse.json({ error: 'organisation_id is required.' }, { status: 400 })
  }

  // ── 1. Take the lock BEFORE checking anything ──────────────────────────────
  // The duplicate guard below is a read, and a read cannot defend itself: two requests
  // arriving together would both see zero pending candidates and both spend an Opus
  // call. Claiming first means the guard runs under mutual exclusion.
  let claim
  try {
    claim = await claimSeedRun(supabase, orgId, user?.id ?? null)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('POST /api/operator/faq-seed: claim failed', { org_id: orgId, error: message })
    return NextResponse.json({ error: 'Failed to start a seed run.' }, { status: 500 })
  }

  if (claim.kind === 'already_running') {
    return NextResponse.json({
      error: 'A seed run is already in progress for this client.',
      started_at: claim.startedAt,
    }, { status: 409 })
  }

  const { runId } = claim
  if (claim.tookOverStaleClaim) {
    logger.warn('POST /api/operator/faq-seed: adopted an abandoned run lock', { org_id: orgId, run_id: runId })
  }

  try {
    // ── 2. The duplicate guard ───────────────────────────────────────────────
    // Seeding again while the last batch is still pending would put a second set of
    // near-identical candidates in front of the operator, and there is no way to tell
    // from a row which run produced it. Curate the existing batch first.
    const pendingSeedCount = await countPendingSeedCandidates(supabase, orgId)
    if (pendingSeedCount > 0) {
      await abandonSeedRun(supabase, runId)
      return NextResponse.json({
        error: `${pendingSeedCount} seed candidate${pendingSeedCount === 1 ? '' : 's'} from an earlier run ` +
               'are still waiting for review. Approve or reject them before seeding again.',
        pending_seed_count: pendingSeedCount,
      }, { status: 409 })
    }

    // ── 3. Load what the agent reads ─────────────────────────────────────────
    const { data: org, error: orgError } = await supabase
      .from('organisations')
      .select('id, name')
      .eq('id', orgId)
      .maybeSingle()

    if (orgError) throw new Error(`could not load the organisation — ${orgError.message}`)
    if (!org) {
      await abandonSeedRun(supabase, runId)
      return NextResponse.json({ error: 'Organisation not found.' }, { status: 404 })
    }

    const { data: docRows, error: docError } = await supabase
      .from('strategy_documents')
      .select('document_type, plain_text, content, status, created_at')
      .eq('organisation_id', orgId)                         // ADR-003: explicit isolation filter
      .in('document_type', [...REQUIRED_DOCUMENT_TYPES])
      .eq('status', 'active')
      .order('created_at', { ascending: false })

    if (docError) throw new Error(`could not load strategy documents — ${docError.message}`)

    const latestByType = new Map<string, { plain_text: string | null; content: unknown }>()
    for (const row of docRows ?? []) {
      if (!latestByType.has(row.document_type)) {
        latestByType.set(row.document_type, { plain_text: row.plain_text, content: row.content })
      }
    }

    const documents: Record<RequiredDocumentType, string> = {
      icp: '', positioning: '', tov: '', messaging: '',
    }
    const missing: string[] = []
    for (const type of REQUIRED_DOCUMENT_TYPES) {
      const row = latestByType.get(type)
      const text = row ? (row.plain_text ?? (row.content ? JSON.stringify(row.content) : '')) : ''
      if (!text.trim()) missing.push(DOCUMENT_LABELS[type])
      documents[type] = text
    }

    const { data: intakeRows, error: intakeError } = await supabase
      .from('intake_responses')
      .select('field_key, field_label, response_value')
      .eq('organisation_id', orgId)                         // ADR-003: explicit isolation filter

    if (intakeError) throw new Error(`could not load intake responses — ${intakeError.message}`)

    if (missing.length > 0 || (intakeRows ?? []).length === 0) {
      // Nothing has been spent yet, so this is not a run and must not be recorded as one.
      await abandonSeedRun(supabase, runId)
      const reasons = [...missing]
      if ((intakeRows ?? []).length === 0) reasons.push('intake questionnaire')
      return NextResponse.json({
        error: `Cannot seed FAQs yet. Missing or not active: ${reasons.join(', ')}.`,
      }, { status: 422 })
    }

    const intakeAnswers: Record<string, unknown> = {}
    for (const row of intakeRows ?? []) {
      intakeAnswers[row.field_key] = { label: row.field_label, value: row.response_value }
    }

    // ── 4. Run the agent ─────────────────────────────────────────────────────
    // websiteContent is deliberately not passed: nothing in this codebase stores scraped
    // website text, so there is no source for it. The agent already treats it as optional.
    const results = await generateFaqSeedCandidates({
      organisationId: orgId,
      organisationName: org.name,
      intakeAnswers,
      icpDocument: documents.icp,
      positioningDocument: documents.positioning,
      tovDocument: documents.tov,
      messagingDocument: documents.messaging,
      supabase,
    })

    // The agent returns [] for every failure it handles itself, and records the reason in
    // agent_runs. Distinguishing "generated nothing" from "failed" is not possible here,
    // so the operator is told the count and pointed at the run history.
    if (results.length === 0) {
      await releaseSeedRun(supabase, runId, {
        state: 'failed',
        candidatesCreated: 0,
        errorMessage: 'The agent produced no candidates. See agent_runs for the reason.',
      })
      return NextResponse.json({
        error: 'The seed run produced no candidates. Check the agent run log for the reason.',
        candidates_created: 0,
      }, { status: 502 })
    }

    await releaseSeedRun(supabase, runId, { state: 'completed', candidatesCreated: results.length })

    logger.info('POST /api/operator/faq-seed: seed run completed', {
      org_id: orgId, run_id: runId, candidates_created: results.length,
    })

    return NextResponse.json({
      run_id: runId,
      candidates_created: results.length,
    }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('POST /api/operator/faq-seed: run failed', { org_id: orgId, run_id: runId, error: message })
    // Release rather than abandon: the run may well have spent an Opus call before it
    // threw, so it belongs in the history with its reason.
    await releaseSeedRun(supabase, runId, { state: 'failed', errorMessage: message }).catch(() => {})
    return NextResponse.json({ error: 'The seed run failed. See the run log for details.' }, { status: 500 })
  }
}
