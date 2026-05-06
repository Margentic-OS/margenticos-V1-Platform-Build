// SECURITY-CRITICAL: This helper is the single application-layer gate against
// view-as-client privilege escalation. The order of operations below is
// intentional and must not be changed:
//
//   1. Fetch role + own organisation_id from the users table using the
//      authenticated userId from the Supabase session — NEVER from a param or
//      header. The userId must be passed in by callers from supabase.auth.getUser().
//   2. Role check runs BEFORE any code that reads or acts on clientParam.
//   3. Only if role === 'operator' AND clientParam is non-empty: verify the
//      target org actually exists in the database.
//   4. On any failure or mismatch: return the operator's own organisation_id.
//      This is graceful degradation — never a hard error, never a data leak.
//
// Do NOT add module-level caching, in-memory maps, or any structure that
// persists across requests. The cache() call below is React's request-scoped
// deduplication primitive. It is reset on every new server render tree, which
// means every HTTP request. Using any other cache here would allow a previous
// operator's view-as state to bleed into an unrelated request.
//
// The layout and all client-facing pages must call this same function with the
// same arguments. cache() ensures a single DB round-trip per request regardless
// of how many callers invoke it.

import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'

export type ViewerContext = {
  viewingOrgId: string
  isOperator: boolean
}

export const resolveViewingOrg = cache(async (
  userId: string,
  clientParam: string | undefined,
): Promise<ViewerContext> => {
  const supabase = await createClient()

  // ── 1. Fetch role + own org. userId is from the verified Supabase session. ──
  const { data: userRow } = await supabase
    .from('users')
    .select('role, organisation_id')
    .eq('id', userId)
    .single()

  const ownOrgId   = userRow?.organisation_id ?? ''
  const isOperator = userRow?.role === 'operator'

  // ── 2. Role check — runs before any branching on clientParam ─────────────
  if (!isOperator || !clientParam) {
    return { viewingOrgId: ownOrgId, isOperator }
  }

  // ── 3. Operator + param present — verify the target org exists ────────────
  const { data: targetOrg } = await supabase
    .from('organisations')
    .select('id')
    .eq('id', clientParam)
    .single()

  // ── 4. Graceful degradation if org not found ─────────────────────────────
  return { viewingOrgId: targetOrg?.id ?? ownOrgId, isOperator }
})
