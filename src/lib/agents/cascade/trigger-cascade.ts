// All four promotion paths call this one function: no inline cascade logic anywhere else.
//
// ICP approved   → dispatch positioning
// ICP approved   → dispatch messaging (when positioning + TOV already active)
// Positioning approved → dispatch messaging (when ICP + TOV already active)
// TOV approved   → dispatch messaging (when ICP + positioning already active)
//
// The function never throws. Any dispatch failure is logged and silently swallowed
// so that the caller's success response always reaches the client.
//
// Idempotency: fireDispatch() has an 8s AbortController so the agent route
// begins processing and we return immediately. A second promotion within the
// agent's run window (typically 60-180s) could re-dispatch. The unique partial
// index on document_suggestions (org, type, status='pending') and 23505 handling
// in each agent's INSERT are the backstop for that window.

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

type DocType = 'icp' | 'positioning' | 'tov' | 'messaging'

const CASCADE_MAP: Record<DocType, DocType[]> = {
  icp:         ['positioning', 'messaging'],
  positioning: ['messaging'],
  tov:         ['messaging'],
  messaging:   [],
}

// Returns true only if (orgId, docType) has neither an active strategy_document
// nor a pending document_suggestion. Both checks needed: active doc means the
// generation is done; pending suggestion means an agent is already running.
async function isEligible(
  supabase: SupabaseClient,
  orgId: string,
  docType: DocType
): Promise<boolean> {
  const [{ count: activeCount }, { count: pendingCount }] = await Promise.all([
    supabase
      .from('strategy_documents')
      .select('id', { count: 'exact', head: true })
      .eq('organisation_id', orgId)
      .eq('document_type', docType)
      .eq('status', 'active'),
    supabase
      .from('document_suggestions')
      .select('id', { count: 'exact', head: true })
      .eq('organisation_id', orgId)
      .eq('document_type', docType)
      .eq('status', 'pending'),
  ])
  return (activeCount ?? 0) === 0 && (pendingCount ?? 0) === 0
}

// Messaging depends on all three upstream docs being active before it runs.
async function allThreeActive(supabase: SupabaseClient, orgId: string): Promise<boolean> {
  const { count } = await supabase
    .from('strategy_documents')
    .select('id', { count: 'exact', head: true })
    .eq('organisation_id', orgId)
    .in('document_type', ['icp', 'positioning', 'tov'])
    .eq('status', 'active')
  return (count ?? 0) >= 3
}

// Fires a POST to the agent route and immediately returns (8s abort).
// AbortError is the expected path for healthy dispatches: the agent runs
// independently for 60-180s. Real network errors are logged as warn.
async function fireDispatch(orgId: string, docType: DocType): Promise<void> {
  const pathMap: Record<DocType, string> = {
    icp:         '/api/agents/icp',
    positioning: '/api/agents/positioning',
    tov:         '/api/agents/tov',
    messaging:   '/api/agents/messaging',
  }
  const path = pathMap[docType]

  const internalSecret = process.env.NEXT_INTERNAL_SECRET
  if (!internalSecret) {
    logger.warn(`cascade: NEXT_INTERNAL_SECRET not set, dispatch skipped for ${path}`, { orgId, docType })
    return
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)

  try {
    await fetch(`${process.env.NEXT_PUBLIC_APP_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': internalSecret,
      },
      body: JSON.stringify({ organisation_id: orgId }),
      signal: controller.signal,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      logger.info('cascade: dispatch sent, agent running independently', { orgId, docType, path })
    } else {
      logger.warn('cascade: dispatch network error', {
        orgId,
        docType,
        path,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  } finally {
    clearTimeout(timer)
  }
}

// Entry point called by all four promotion paths.
// promotedDocType = the doc that was just approved. Never throws.
export async function triggerCascadeIfEligible(
  supabase: SupabaseClient,
  orgId: string,
  promotedDocType: string
): Promise<void> {
  try {
    const targets = CASCADE_MAP[promotedDocType as DocType]
    if (!targets || targets.length === 0) return

    for (const target of targets) {
      // Messaging requires all three upstream docs to be active before dispatch.
      if (target === 'messaging') {
        const ready = await allThreeActive(supabase, orgId)
        if (!ready) continue
      }

      const eligible = await isEligible(supabase, orgId, target)
      if (!eligible) continue

      // Notification fires from the target agent route's success path — not here.
      // Notifying at dispatch time would mean the operator gets an email before the
      // document exists, which is confusing. The suggestion-ready email fires only
      // after the agent has written the suggestion row.
      await fireDispatch(orgId, target)
    }
  } catch (err) {
    // Never propagate — cascade is best-effort. The operator can manually
    // trigger any skipped agent from the client detail page.
    logger.error('cascade: unexpected error in triggerCascadeIfEligible', {
      orgId,
      promotedDocType,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
