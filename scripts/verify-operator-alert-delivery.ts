// Proves, by delivery, that an operator alert reaches doug@margenticos.com.
//
//   npx dotenv -e .env.local -- npx tsx scripts/verify-operator-alert-delivery.ts
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY A SCRIPT AND NOT A TEST
//
// Because a test cannot prove this. The 2026-09-05 failure was invisible to the entire
// suite: every existing test fed the validator hand-written strings and mocked Resend, so
// nothing ever rendered a real template and asked the real validator whether it would go
// out, and nothing ever watched an email actually arrive.
//
// The unit tests added alongside this close the first gap. Only a real send closes the
// second. This is the third attempt at this lesson, and the two previous ones both ended
// with code that looked correct and delivered nothing.
//
// IT SENDS A REAL EMAIL. That is the point. Run it deliberately.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IT CHECKS
//
//   1. The exact agent-failure alert from the 2026-09-05 tov run DELIVERS.
//      Before this branch it was rejected on the template's own branding line.
//   2. A genuinely broken email is still REJECTED, so the exemption did not disable
//      the rendering checks along with the style ones.
//   3. That rejection LEAVES A ROW, and MON-030 turns PROBLEM.
//   4. The row is marked resolved on the way out, so the board goes back to green.

import { createClient } from '@supabase/supabase-js'
import { sendTransactionalEmail } from '../src/lib/email/send'
import { agentFailureTemplate, agentFailureSubject } from '../src/lib/email/templates/agent-failure'

const ORG_NAME = 'MargenticOS'
const ORG_ID = '0ed34697-0fa9-4f08-ac15-d3504ac45caf'

// The error string the 2026-09-05 run actually produced, so this is the payload that was
// discarded rather than a stand-in for it.
const REAL_ERROR =
  'TOV agent: Claude returned content that is not valid JSON. ' +
  'Raw response has been logged. Do not write to the database.'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set. Run via: npx dotenv -e .env.local -- npx tsx ${process.argv[1]}`)
  return v
}

async function readMonitor(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase.from('mon_030').select('state, detail').single()
  if (error) return `could not read mon_030: ${error.message}`
  return `${(data as { state: string }).state} - ${(data as { detail: string }).detail}`
}

async function main() {
  const operatorEmail = requireEnv('RESEND_OPERATOR_EMAIL')
  const supabase = createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  )

  console.log('MON-030 before:', await readMonitor(supabase))
  console.log()

  // ── 1. The real alert must deliver ────────────────────────────────────────
  console.log('1. Sending the real agent-failure alert to', operatorEmail)
  const alert = await sendTransactionalEmail({
    to: operatorEmail,
    subject: agentFailureSubject(ORG_NAME, 'tov'),
    html: agentFailureTemplate({ orgName: ORG_NAME, orgId: ORG_ID, docType: 'tov', error: REAL_ERROR }),
    audience: 'operator',
  })

  if (!alert.success) {
    console.error('   FAILED. The operator alert still does not deliver:', alert.error)
    process.exitCode = 1
    return
  }
  console.log('   DELIVERED. Resend message id:', alert.messageId)
  console.log('   Subject:', agentFailureSubject(ORG_NAME, 'tov'))
  console.log()

  // ── 2. A broken email must still be rejected ──────────────────────────────
  // The exemption is scoped to style. If it had switched off the rendering checks too,
  // this would send, and a template handed a missing variable would reach a human.
  console.log('2. Sending a deliberately broken operator email (literal "undefined")')
  const broken = await sendTransactionalEmail({
    to: operatorEmail,
    subject: 'MON-030 delivery proof: this one must NOT send',
    html: '<p>Regeneration for undefined could not be started.</p>',
    audience: 'operator',
  })

  if (broken.success) {
    console.error('   FAILED. A broken email was sent. The rendering checks are not running.')
    process.exitCode = 1
    return
  }
  console.log('   REJECTED, correctly:', broken.error)
  console.log()

  // ── 3. The rejection must have left a row, and the monitor must see it ────
  console.log('3. MON-030 after the rejection:', await readMonitor(supabase))

  const { data: rows, error: readErr } = await supabase
    .from('email_delivery_failures')
    .select('id, subject, stage, audience, error_message')
    .is('resolved_at', null)
    .order('created_at', { ascending: false })
    .limit(5)

  if (readErr) {
    console.error('   could not read email_delivery_failures:', readErr.message)
    process.exitCode = 1
    return
  }
  if (!rows || rows.length === 0) {
    console.error('   FAILED. The rejection left no row. The failure is still silent.')
    process.exitCode = 1
    return
  }
  console.log('   Row recorded:', JSON.stringify(rows[0]))
  console.log()

  // ── 4. Clean up, so the board is not left red by a proof ──────────────────
  const ids = rows.map(r => (r as { id: string }).id)
  const { error: resolveErr } = await supabase
    .from('email_delivery_failures')
    .update({ resolved_at: new Date().toISOString() })
    .in('id', ids)

  if (resolveErr) {
    console.error('   could not resolve the proof rows:', resolveErr.message)
    process.exitCode = 1
    return
  }
  console.log('4. Proof rows marked resolved.')
  console.log('   MON-030 after cleanup:', await readMonitor(supabase))
  console.log()
  console.log('All four checks passed. Check', operatorEmail, 'for the alert.')
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
