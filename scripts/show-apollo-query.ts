#!/usr/bin/env npx tsx
// Report only. Prints the provider request a client's stored spec builds. Calls nothing.
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import { apolloHandler } from '../src/lib/sourcing/handlers/adapter-apollo'
import type { ICPFilterSpec } from '../src/lib/agents/icp-filter-spec'

async function main() {
  const i = process.argv.indexOf('--org')
  const orgId = i >= 0 ? process.argv[i + 1] : undefined
  if (!orgId) { console.error('--org <uuid> required'); process.exit(1) }

  const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  const { data: org } = await supabase.from('organisations').select('name').eq('id', orgId).single()
  const { data: doc } = await supabase.from('strategy_documents')
    .select('icp_filter_spec').eq('organisation_id', orgId)
    .eq('document_type', 'icp').eq('status', 'active').single()

  console.log(`\n=== ${org?.name} ===`)
  if (!doc?.icp_filter_spec) { console.log('NO ACTIVE SPEC — sourcing refuses'); return }
  const spec = doc.icp_filter_spec as unknown as ICPFilterSpec
  try {
    console.log(JSON.stringify(apolloHandler.adapter(spec as unknown as Record<string, unknown>), null, 2))
  } catch (e) {
    console.log(`REFUSED: ${(e as Error).message}`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
