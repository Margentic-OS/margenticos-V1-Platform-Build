// Scores the abstract nominalisation density of a live messaging document.
// Read-only. Makes no writes and no external API calls.
//
// Usage: npx tsx --env-file=.env.local scripts/score-nominalisation.ts <organisation_id>

import { createClient } from '@supabase/supabase-js'
import { nominalisationDensity, NOMINALISATION_THRESHOLD } from '@/lib/style/nominalisation'

interface StoredEmail {
  sequence_position: number
  body: string
  word_count: number
}

async function main() {
  const orgId = process.argv[2]
  if (!orgId) {
    console.error('Usage: score-nominalisation.ts <organisation_id>')
    process.exit(1)
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data, error } = await supabase
    .from('strategy_documents')
    .select('id, version, content')
    .eq('organisation_id', orgId)
    .eq('document_type', 'messaging')
    .eq('status', 'active')
    .single()

  if (error || !data) {
    console.error('No active messaging document found:', error?.message)
    process.exit(1)
  }

  const variants = (data.content as { variants?: Record<string, { emails: StoredEmail[] }> }).variants ?? {}

  console.log(`Document ${data.id} v${data.version}`)
  console.log(`Threshold: ${(NOMINALISATION_THRESHOLD * 100).toFixed(1)}% (report only, never gates)\n`)
  console.log('variant  email  words  nominalisations  density  flag')
  console.log('-'.repeat(72))

  let allText = ''
  let worst = { label: '', density: 0, matches: [] as string[] }

  for (const key of Object.keys(variants).sort()) {
    for (const email of variants[key].emails) {
      const s = nominalisationDensity(email.body)
      allText += ' ' + email.body
      const flag = s.exceedsThreshold ? 'OVER' : 'ok'
      console.log(
        `${key.padEnd(8)} ${String(email.sequence_position).padEnd(6)} ` +
        `${String(s.totalWords).padEnd(6)} ${String(s.count).padEnd(16)} ` +
        `${(s.density * 100).toFixed(1).padStart(6)}%  ${flag}`
      )
      if (s.density > worst.density) {
        worst = { label: `${key}/email ${email.sequence_position}`, density: s.density, matches: s.matches }
      }
    }
  }

  const overall = nominalisationDensity(allText)
  console.log('-'.repeat(72))
  console.log(
    `DOCUMENT  all    ${String(overall.totalWords).padEnd(6)} ${String(overall.count).padEnd(16)} ` +
    `${(overall.density * 100).toFixed(1).padStart(6)}%  ${overall.exceedsThreshold ? 'OVER' : 'ok'}`
  )
  console.log(`\nDistinct nominalisations across the document (${overall.matches.length}):`)
  console.log('  ' + overall.matches.sort().join(', '))
  console.log(`\nWorst single email: ${worst.label} at ${(worst.density * 100).toFixed(1)}%`)
  console.log(`  ${worst.matches.join(', ')}`)
}

main().catch(err => {
  console.error('FAILED:', err)
  process.exit(1)
})
