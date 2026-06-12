/**
 * Test the dedup constraint directly.
 * Attempts to log the SAME notification twice and verifies the constraint blocks it.
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function main() {
  const orgId = '7fedb726-73ec-4a24-906b-ad8bc7ef1b50' // 360 Bia Og
  const notificationType = 'docs_ready'
  const subjectId = orgId // For docs_ready, subject_id is org_id

  console.log('🔍 Testing dedup constraint: docs_ready for 360 Bia Og\n')

  // First insert: should succeed
  console.log('First insert: docs_ready...')
  const { error: firstError } = await supabase
    .from('notifications_log')
    .insert({
      organisation_id: orgId,
      notification_type: notificationType,
      subject_id: subjectId,
    })

  if (firstError) {
    if (firstError.code === '23505') {
      console.log('✓ Constraint violation on first insert (already exists)')
    } else {
      console.error('❌ Unexpected error:', firstError.message)
      process.exit(1)
    }
  } else {
    console.log('✓ First insert succeeded')
  }

  // Second insert: should fail with constraint violation
  console.log('\nSecond insert: same docs_ready (should fail)...')
  const { error: secondError } = await supabase
    .from('notifications_log')
    .insert({
      organisation_id: orgId,
      notification_type: notificationType,
      subject_id: subjectId,
    })

  if (secondError && secondError.code === '23505') {
    console.log(`✓ Constraint violation (UNIQUE) as expected`)
    console.log(`  Error code: ${secondError.code}`)
    console.log(`  Error message: ${secondError.message}\n`)
  } else if (secondError) {
    console.error('❌ Unexpected error:', secondError.message)
    process.exit(1)
  } else {
    console.error('❌ Should have failed with constraint violation!')
    process.exit(1)
  }

  // Fetch the logged row
  console.log('Fetching the notifications_log row...')
  const { data: logRow, error: fetchError } = await supabase
    .from('notifications_log')
    .select('*')
    .eq('organisation_id', orgId)
    .eq('notification_type', notificationType)
    .single()

  if (fetchError) {
    console.error('❌ Could not fetch log row:', fetchError.message)
    process.exit(1)
  }

  console.log(`\n✓ notifications_log row exists:`)
  console.log(`  ID: ${logRow.id}`)
  console.log(`  organisation_id: ${logRow.organisation_id}`)
  console.log(`  notification_type: ${logRow.notification_type}`)
  console.log(`  subject_id: ${logRow.subject_id}`)
  console.log(`  sent_at: ${logRow.sent_at}`)
}

main().catch(err => {
  console.error('❌ Error:', err.message)
  process.exit(1)
})
