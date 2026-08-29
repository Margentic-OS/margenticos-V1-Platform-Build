// Proof harness for the POSITIONING research query port.
//
//   npx dotenv -e .env.local -- npx tsx scripts/prove-positioning-queries.ts
//
// Same shape as scripts/prove-research-queries.ts, against the positioning builder.
// The "before" column comes from scripts/__before__positioning-research-queries.ts, which
// scripts/regen-before-research-queries.ts slices out of the commit BEFORE this port.
//
// Read-only. It touches intake_responses and organisations and writes nothing.

import { createClient } from '@supabase/supabase-js'
import { buildResearchPlan } from '../src/agents/positioning-generation-agent'
import { resolveBuyerDescriptor } from '../src/lib/agents/research-descriptors'
import { buildPositioningQueriesBefore, type IntakeRow } from './__before__positioning-research-queries'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required')

const supabase = createClient(url, key)

function wrap(text: string, indent: string, width = 92): string {
  const out: string[] = []
  let line = ''
  for (const w of text.split(' ')) {
    if (line.length + w.length + 1 > width) { out.push(line); line = w } else { line = line ? `${line} ${w}` : w }
  }
  if (line) out.push(line)
  return out.map((l, i) => (i === 0 ? l : indent + l)).join('\n')
}

async function main() {
  const { data: orgs, error: orgErr } = await supabase
    .from('organisations').select('id, name, created_at').order('created_at')
  if (orgErr) throw orgErr

  let researched = 0, skipped = 0

  for (const org of orgs ?? []) {
    const { data: intake, error } = await supabase
      .from('intake_responses')
      .select('field_key, field_label, response_value, section, is_critical')
      .eq('organisation_id', org.id)
    if (error) throw error
    if (!intake || intake.length === 0) continue

    const rows = intake as IntakeRow[]
    const before = buildPositioningQueriesBefore(rows)
    const plan = buildResearchPlan(rows)
    const buyer = resolveBuyerDescriptor(rows)

    console.log('\n' + '='.repeat(100))
    console.log(`${org.name}   (${org.id})`)
    console.log('='.repeat(100))
    console.log(`  buyer descriptor (Q2 only) : ${buyer.text ? `"${buyer.text}"` : '(none)'}`)
    console.log(`  resolved from              : ${buyer.source}`)

    if (plan.skipped) {
      skipped++
      console.log('\n  RESEARCH SKIPPED. The four queries below would have been sent before the port.')
      before.forEach((b, i) => console.log(`    BEFORE Q${i + 1}  ${wrap(b, '                ')}`))
      console.log('\n    AFTER       no query sent. suggestion_reason gains:')
      console.log(`                ${wrap(plan.skipReason.trim(), '                ')}`)
      continue
    }

    researched++
    for (let i = 0; i < 4; i++) {
      console.log(`\n  Q${i + 1}`)
      console.log(`    BEFORE  ${wrap(before[i], '            ')}`)
      console.log(`    AFTER   ${wrap(plan.queries[i], '            ')}`)
      console.log(`    changed ${before[i] !== plan.queries[i]}`)
    }
  }

  console.log('\n' + '='.repeat(100))
  console.log(`${researched} organisation(s) researched, ${skipped} skipped with a stated reason.`)
}

main().catch(err => { console.error(err); process.exit(1) })
