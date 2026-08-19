// Verifies the sign-off block and footer ordering end to end, using the real functions.
// Read-only: no writes, no uploads, no external API calls.
//
// Takes the live variant D email 1 (the one that shipped with two questions), runs it
// through the real applySignOffFix, the real composition footer append, and the real
// plainTextToHtml, so the rendered output is exactly what a send would produce.
//
// Usage: npx tsx --env-file=.env.local scripts/verify-signoff-block.ts

import { createClient } from '@supabase/supabase-js'
import { applySignOffFix, validateEmails, recomputeCounts, MAX_QUESTIONS_PER_EMAIL } from '@/agents/messaging-generation-agent'
import type { EmailRecord } from '@/agents/messaging-generation-agent'
import { plainTextToHtml } from '@/lib/composition/custom-variables'
import { OPT_OUT_FOOTER } from '@/lib/composition/opt-out-footer'
import { countWords } from '@/lib/composition/personalization'

const ORG_ID = '0ed34697-0fa9-4f08-ac15-d3504ac45caf'
const DOC_ID = '4e6dadbf-9a0a-4a78-adf6-afb07ef9f98f'

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: org } = await supabase
    .from('organisations').select('name, founder_first_name').eq('id', ORG_ID).single()

  const senderFirstName = org!.founder_first_name as string
  const senderCompanyName = org!.name as string

  console.log('Sender first name (organisations.founder_first_name):', senderFirstName)
  console.log('Sender company    (organisations.name)              :', senderCompanyName)

  const { data: doc } = await supabase
    .from('strategy_documents').select('content').eq('id', DOC_ID).single()

  const emails = (doc!.content as { variants: Record<string, { emails: EmailRecord[] }> })
    .variants['D'].emails

  // BEFORE: as stored today.
  const before = emails.find(e => e.sequence_position === 1)!
  console.log('\n' + '='.repeat(74))
  console.log('BEFORE (stored variant D email 1, as it shipped)')
  console.log('='.repeat(74))
  console.log(before.body)
  console.log(`\nquestion marks: ${(before.body.match(/\?/g) ?? []).length} (limit ${MAX_QUESTIONS_PER_EMAIL})`)
  console.log(`word count    : ${countWords(before.body)}`)

  // AFTER: real sign-off fix, then the real composition-time footer append.
  const { emails: signed } = applySignOffFix(emails, senderFirstName, senderCompanyName)
  const counted = recomputeCounts(signed)
  const after = counted.find(e => e.sequence_position === 1)!

  const withFooter = `${after.body.trimEnd()}\n\n${OPT_OUT_FOOTER}`

  console.log('\n' + '='.repeat(74))
  console.log('AFTER sign-off fix, then composition footer (what a send renders)')
  console.log('='.repeat(74))
  console.log(withFooter)

  console.log('\n--- RENDERED HTML (m_body_1) ---')
  console.log(plainTextToHtml(withFooter.replace(/\{\{first_name\}\}/g, 'Lori')))

  console.log('\n--- WORD COUNT RULE (8f) ---')
  console.log('stored word_count (sign-off block counted, footer not):', after.word_count)
  console.log('recount of body without footer                       :', countWords(after.body))
  console.log('recount of body with footer                          :', countWords(withFooter))
  console.log('delta from adding the company line                   :',
    countWords(after.body) - countWords(before.body))

  console.log('\n--- VALIDATOR (fix 7 + fix 8) ---')
  const violations = validateEmails(counted, senderFirstName, senderCompanyName)
  if (violations.length === 0) {
    console.log('no violations')
  } else {
    for (const v of violations) console.log(`  Email ${v.email}: ${v.issue}`)
  }
}

main().catch(err => { console.error('FAILED:', err); process.exit(1) })
