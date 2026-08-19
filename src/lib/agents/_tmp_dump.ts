// Dumps the stored messaging suggestion exactly as persisted, with computed metrics.
import { createClient } from '@supabase/supabase-js'
import { nominalisationDensity } from '@/lib/style/nominalisation'
import { countWords } from '@/lib/composition/personalization'
import { findBackReferences } from '@/lib/style/back-reference'

const SUGGESTION_ID = '7c1c0f08-a4ae-40d6-97ee-3b50f523163a'

async function main() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data, error } = await supabase
    .from('document_suggestions')
    .select('id, status, segment_id, document_id, confidence_level, suggestion_reason, suggested_value, created_at')
    .eq('id', SUGGESTION_ID).single()
  if (error || !data) throw new Error(`fetch failed: ${error?.message}`)

  console.log(`suggestion id : ${data.id}`)
  console.log(`status        : ${data.status}`)
  console.log(`segment_id    : ${data.segment_id}`)
  console.log(`document_id   : ${data.document_id}`)
  console.log(`confidence    : ${data.confidence_level}`)
  console.log(`created_at    : ${data.created_at}`)
  console.log(`\n=== SUGGESTION REASON (as stored) ===\n${data.suggestion_reason}`)

  const parsed = JSON.parse(data.suggested_value as string) as {
    variants: Record<string, { angle: string; emails: Array<{ sequence_position: number; subject_line: string | null; subject_char_count: number; body: string; word_count: number }> }>
  }

  let docWords = 0, docNoms = 0
  const p3s: Array<{ variant: string; p3: string }> = []

  for (const key of Object.keys(parsed.variants).sort()) {
    const v = parsed.variants[key]
    console.log(`\n${'#'.repeat(78)}`)
    console.log(`# VARIANT: ${key}    shipped angle: ${v.angle}`)
    console.log('#'.repeat(78))

    for (const e of v.emails.sort((a, b) => a.sequence_position - b.sequence_position)) {
      const nom = nominalisationDensity(e.body)
      docWords += nom.totalWords
      docNoms += nom.count
      const recomputed = countWords(e.body)
      console.log(`\n----- Email ${e.sequence_position} -----`)
      console.log(`subject_line       : ${e.subject_line === null ? 'null' : JSON.stringify(e.subject_line)}`)
      console.log(`subject_char_count : ${e.subject_char_count}${e.subject_line ? ` (actual ${e.subject_line.length})` : ''}`)
      console.log(`word_count(stored) : ${e.word_count}   recomputed: ${recomputed}${recomputed === e.word_count ? ' OK' : ' MISMATCH'}`)
      console.log(`nominalisation     : ${(nom.density * 100).toFixed(2)}%  (${nom.count}/${nom.totalWords})  over=${nom.exceedsThreshold}  matches=[${nom.matches.join(', ') || 'none'}]`)
      const br = findBackReferences(e.body)
      console.log(`question marks     : ${(e.body.match(/\?/g) || []).length}`)
      console.log(`back-refs (hard)   : ${br.demonstratives.map(d=>d.phrase).join(', ') || 'none'}`)
      console.log(`ampersands/jargon  : ${/\s&\s/.test(e.body)?'AMPERSAND ':''}${/\bICPs?\b/.test(e.body)?'ICP':'none'}`)
      console.log(`em/en dashes       : ${(e.body.match(/[—–]/g) || []).length}`)
      console.log(`BODY (exact):`)
      console.log(e.body)
      if (e.sequence_position === 1) {
        const paras = e.body.split(/\n\n+/).map(s => s.trim()).filter(Boolean)
        p3s.push({ variant: key, p3: paras[2] ?? '(no P3 found)' })
      }
    }
  }

  console.log(`\n${'='.repeat(78)}`)
  console.log(`DOCUMENT TOTAL nominalisation: ${((docNoms / docWords) * 100).toFixed(2)}%  (${docNoms}/${docWords} words)`)
  console.log('='.repeat(78))
  console.log('\n=== EMAIL 1 P3 PER VARIANT ===')
  for (const { variant, p3 } of p3s) console.log(`\n[${variant}]\n${p3}`)
}

main().catch(e => { console.error(e); process.exit(1) })
