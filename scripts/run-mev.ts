// Run MEV (MyEmailVerifier) on the 29 enriched prospects
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import { myemailverifierHandler } from '../src/lib/sourcing/handlers/adapter-myemailverifier'

async function runMEV() {
  const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const orgId = '0ed34697-0fa9-4f08-ac15-d3504ac45caf'

  // Get enriched prospects with emails
  const { data: prospects, error } = await supabase
    .from('prospects')
    .select('id, email, independent_email_status')
    .eq('enrichment_status', 'enriched')
    .eq('organisation_id', orgId)
    .not('email', 'is', null)
    .limit(100)

  if (error) {
    console.error('Error fetching prospects:', error)
    process.exit(1)
  }

  if (!prospects || prospects.length === 0) {
    console.log('No prospects with emails found')
    process.exit(0)
  }

  console.log(`Running MEV verification on ${prospects.length} prospects...`)

  const results = {
    valid: 0,
    invalid: 0,
    unknown: 0,
    catch_all: 0,
    total: prospects.length,
    eligible: 0,
  }

  // Verify each email (sequentially to avoid rate limits)
  for (const prospect of prospects) {
    if (!prospect.email) continue

    try {
      const result = await myemailverifierHandler.execute(prospect.email)

      // Track result
      switch (result.status) {
        case 'Valid':
          results.valid++
          break
        case 'Invalid':
          results.invalid++
          break
        case 'Catch All':
          results.catch_all++
          break
        case 'Unknown':
          results.unknown++
          break
      }

      if (result.send_eligible) {
        results.eligible++
      }

      // Update prospect with verification result
      await supabase
        .from('prospects')
        .update({
          independent_email_status: result.status,
          email_send_eligible: result.send_eligible,
          independent_verified_at: result.verified_at,
          verification_provider: 'myemailverifier',
        })
        .eq('id', prospect.id)

      // Rate limiting: 30 per minute = one every 2 seconds
      await new Promise(r => setTimeout(r, 2000))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`  ⚠ ${prospect.email}: ${msg}`)
    }
  }

  console.log('\n✓ MEV verification complete:')
  console.log(`  Valid: ${results.valid}`)
  console.log(`  Invalid: ${results.invalid}`)
  console.log(`  Unknown: ${results.unknown}`)
  console.log(`  Catch All: ${results.catch_all}`)
  console.log(`  Send-eligible: ${results.eligible}/${results.total}`)
}

runMEV()
