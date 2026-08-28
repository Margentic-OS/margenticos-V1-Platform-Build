// Proof harness for the ICP research query builder fix.
//
//   dotenv -e .env.local -- npx tsx scripts/prove-research-queries.ts
//
// Runs the REAL builder against the REAL intake of every organisation that has one, and
// prints the four queries before the fix beside the four after it. The "before" column
// comes from scripts/__before__research-queries.ts, which is extracted mechanically from
// origin/main rather than retyped, so the comparison is against the code that shipped.
//
// Read-only. It touches intake_responses and organisations and writes nothing.

import { createClient } from '@supabase/supabase-js'
import { buildResearchQueries as after } from '../src/agents/icp-generation-agent'
import { buildResearchQueriesBefore as before } from './__before__research-queries'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required')

const supabase = createClient(url, key)

async function main() {
  const { data: orgs, error: orgErr } = await supabase
    .from('organisations')
    .select('id, name, created_at')
    .order('created_at')
  if (orgErr) throw orgErr

  for (const org of orgs ?? []) {
    const { data: intake, error } = await supabase
      .from('intake_responses')
      .select('field_key, field_label, response_value, section, is_critical')
      .eq('organisation_id', org.id)
    if (error) throw error
    if (!intake || intake.length === 0) continue

    const rows = intake as Parameters<typeof after>[0]
    const b = before(rows)
    const a = after(rows)

    console.log('\n' + '='.repeat(100))
    console.log(`${org.name}   (${org.id})`)
    console.log('='.repeat(100))
    for (let i = 0; i < 4; i++) {
      console.log(`\n  Q${i + 1}`)
      console.log(`    BEFORE  ${b[i]}`)
      console.log(`    AFTER   ${a[i]}`)
      console.log(`    changed ${b[i] !== a[i]}`)
    }
  }
}

main().catch(err => { console.error(err); process.exit(1) })
