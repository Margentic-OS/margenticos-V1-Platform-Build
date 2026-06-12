#!/usr/bin/env npx tsx
// Quick script to regenerate 360dungarvan documents for verification
// Usage: npx tsx scripts/regenerate-360dungarvan-docs.ts

import { createClient } from '@supabase/supabase-js'
import { runIcpGenerationAgent } from '@/agents/icp-generation-agent'
import { runPositioningGenerationAgent } from '@/agents/positioning-generation-agent'
import { runTovGenerationAgent } from '@/agents/tov-generation-agent'
import { runMessagingGenerationAgent } from '@/agents/messaging-generation-agent'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false }
})

async function main() {
  console.log('Fetching 360dungarvan organisation_id...')

  const { data: orgs, error: orgError } = await supabase
    .from('organisations')
    .select('id, name')
    .or("name.ilike.%360%,name.ilike.%dungarvan%")
    .limit(1)

  if (orgError || !orgs || orgs.length === 0) {
    console.error('Failed to find 360dungarvan organisation:', orgError)
    process.exit(1)
  }

  const orgId = orgs[0].id
  const orgName = orgs[0].name
  console.log(`Found: ${orgName} (${orgId})`)
  console.log('')

  try {
    console.log('=== Regenerating ICP ===')
    const icpResult = await runIcpGenerationAgent({
      organisation_id: orgId,
      supabase,
      is_refresh: true
    })
    console.log('ICP generated:', icpResult.suggestion_id)
    console.log('')

    console.log('=== Regenerating Positioning ===')
    const posResult = await runPositioningGenerationAgent({
      organisation_id: orgId,
      supabase,
      is_refresh: true
    })
    console.log('Positioning generated:', posResult.suggestion_id)
    console.log('')

    console.log('=== Regenerating TOV ===')
    const tovResult = await runTovGenerationAgent({
      organisation_id: orgId,
      supabase,
      is_refresh: true
    })
    console.log('TOV generated:', tovResult.suggestion_id)
    console.log('')

    console.log('=== Regenerating Messaging ===')
    const msgResult = await runMessagingGenerationAgent({
      organisation_id: orgId,
      supabase,
      is_refresh: true
    })
    console.log('Messaging generated:', msgResult.suggestion_id)
    console.log('')

    console.log('All documents regenerated successfully.')
    console.log('Check document_suggestions table for pending approvals.')

  } catch (error) {
    console.error('Error during regeneration:', error)
    process.exit(1)
  }
}

main()
