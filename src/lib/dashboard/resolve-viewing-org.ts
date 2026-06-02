// Resolves which organisation's data a page should scope to.
//
// Contract:
// - A client user is ALWAYS pinned to their own organisation_id. clientParam is
//   ignored entirely — a client cannot view another org's data regardless of what
//   appears in the URL.
// - The client param is honoured only for authenticated users whose role = 'operator'.
// - Operator cross-org reads depend on the operators_full_access_* RLS policies
//   (USING (is_operator())) on every queried table. Any future client-data table
//   needs the same operator policy or operator view returns empty rows for it.
// - A malformed or absent clientParam falls back to the operator's own org.
//   UUID is validated syntactically only — no existence query is made.
//   This prevents malformed values from being passed to a uuid-typed column query,
//   which would throw a Postgres invalid-input-syntax error.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ViewingOrg {
  organisationId: string | null
  role: string | null
}

export async function resolveViewingOrg(
  supabase: SupabaseClient<Database>,
  user: { id: string },
  clientParam: string | undefined,
): Promise<ViewingOrg> {
  const { data: row } = await supabase
    .from('users')
    .select('organisation_id, role')
    .eq('id', user.id)
    .single()

  if (!row || !row.organisation_id) {
    return { organisationId: null, role: null }
  }

  if (row.role === 'operator' && clientParam && UUID_RE.test(clientParam)) {
    return { organisationId: clientParam, role: 'operator' }
  }

  return { organisationId: row.organisation_id, role: row.role }
}
