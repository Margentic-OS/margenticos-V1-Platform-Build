/**
 * Test script for docs_ready notification.
 *
 * This tests the notifyAfterPromotion helper against the 360 Bia Og organisation,
 * which has all 4 documents active (promoted before this code existed).
 *
 * Usage: npx tsx scripts/test-docs-ready-notification.ts
 */

import { createClient } from '@supabase/supabase-js'
import { notifyAfterPromotion } from '@/lib/notifications/notify-after-promotion'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function main() {
  console.log('🔍 Test: docs_ready notification for 360 Bia Og\n')

  // Step 1: Find the 360 Bia Og organisation
  const { data: org, error: orgError } = await supabase
    .from('organisations')
    .select('id, name')
    .eq('name', '360 Bia Og')
    .single()

  if (orgError || !org) {
    console.error('❌ Could not find 360 Bia Og organisation:', orgError?.message)
    process.exit(1)
  }

  console.log(`✓ Found organisation: ${org.name} (${org.id})\n`)

  // Step 2: Verify all 4 documents are active
  const { data: docs, error: docsError } = await supabase
    .from('strategy_documents')
    .select('document_type, status')
    .eq('organisation_id', org.id)
    .eq('status', 'active')

  if (docsError || !docs) {
    console.error('❌ Could not fetch documents:', docsError?.message)
    process.exit(1)
  }

  const docTypes = new Set(docs.map((d) => d.document_type))
  console.log(`✓ Active documents: ${Array.from(docTypes).join(', ')}`)
  console.log(`  Total: ${docs.length}/4`)

  if (!docTypes.has('icp') || !docTypes.has('tov') || !docTypes.has('positioning') || !docTypes.has('messaging')) {
    console.error('\n❌ Not all 4 documents are active. Aborting test.')
    process.exit(1)
  }

  console.log('\n✓ All 4 documents are active\n')

  // Step 3: Check if docs_ready was already sent
  const { data: loggedNotif } = await supabase
    .from('notifications_log')
    .select('id')
    .eq('organisation_id', org.id)
    .eq('notification_type', 'docs_ready')
    .single()

  if (loggedNotif) {
    console.log(`⚠️  docs_ready was already logged. This will test dedup constraint.\n`)
  }

  // Step 4: Resolve the client user email
  const { data: clientUser, error: userError } = await supabase
    .from('users')
    .select('id, email')
    .eq('organisation_id', org.id)
    .eq('role', 'client')
    .single()

  if (userError || !clientUser?.email) {
    console.error('❌ Could not resolve client user:', userError?.message || 'No client user found')
    process.exit(1)
  }

  console.log(`✓ Resolved client recipient: ${clientUser.email}`)
  console.log(`  (User ID: ${clientUser.id})\n`)

  console.log('━'.repeat(70))
  console.log('RECIPIENT CONFIRMATION NEEDED')
  console.log('━'.repeat(70))
  console.log(`\n📧 Will send docs_ready notification to: ${clientUser.email}\n`)
  console.log('Confirm this is correct before proceeding. If correct, uncomment the')
  console.log('notifyAfterPromotion() call below and re-run the script.\n')

  // STEP 4: Call notifyAfterPromotion
  console.log('⏳ Sending notification...\n')
  await notifyAfterPromotion(supabase, {
    organisation_id: org.id,
    suggestion_id: org.id, // For docs_ready, subject_id is organisation_id
    document_type: 'icp',  // Arbitrary; docs_ready sends once per org
    update_trigger: null,
  })
  console.log('✓ Notification sent (or already logged via dedup)\n')
}

main().catch(err => {
  console.error('❌ Error:', err.message)
  process.exit(1)
})
