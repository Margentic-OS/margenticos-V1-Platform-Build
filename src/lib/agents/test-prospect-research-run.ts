// Test script for prospect research agent v2.
// Run with: npx tsx --env-file=.env.local src/lib/agents/test-prospect-research-run.ts
//
// Prerequisites before a full four-source run:
//   APIFY_API_KEY  — sign up at apify.com (LinkedIn source)
//   BRAVE_SEARCH_API_KEY — get key at search.brave.com/app/keys (Brave fallback)
//   APOLLO_API_KEY — Apollo Basic required (Apollo source, currently 403 on free plan)
// Without these, the agent runs on Anthropic native web search + website source only.

import { createClient } from '@supabase/supabase-js'
import { runProspectResearchAgentV2 } from '@/lib/agents/prospect-research-agent-v2'

const ORG_ID      = '74243c62-f42d-4f3f-b93e-bd5e51f0b6c0' // MargenticOS client zero
const PROSPECT_ID = '7cd92532-55e0-45d4-9d99-4a7c2ae0a12d' // Ginny Hudgens — The Strategic Implementer

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
  }

  console.log('=== Prospect Research Agent v2 — Test Run ===')
  console.log(`Prospect ID : ${PROSPECT_ID}`)
  console.log(`Client ID   : ${ORG_ID}`)
  console.log('')
  console.log('Active sources:')
  console.log(`  LinkedIn  : ${process.env.APIFY_API_KEY       ? '✓ APIFY_API_KEY set'       : '✗ APIFY_API_KEY not set (skipped)'}`)
  console.log(`  Apollo    : ${process.env.APOLLO_API_KEY      ? '✓ APOLLO_API_KEY set'      : '✗ APOLLO_API_KEY not set (skipped)'}`)
  console.log(`  Brave     : ${process.env.BRAVE_SEARCH_API_KEY ? '✓ BRAVE_SEARCH_API_KEY set' : '○ BRAVE_SEARCH_API_KEY not set (Anthropic native only)'}`)
  console.log('')

  try {
    const result = await runProspectResearchAgentV2({
      prospect_id: PROSPECT_ID,
      client_id: ORG_ID,
    })

    console.log('=== RESEARCH RESULT ===')
    console.log(`ICP fit           : ${result.icp_fit}`)
    console.log(`Dateable signal   : ${result.has_dateable_signal} (${result.signal_relevance})`)
    console.log(`Qualification     : ${result.qualification_status}`)
    console.log(`Confidence        : ${result.synthesis_confidence}`)
    console.log(`Sources attempted : ${result.sources_attempted.join(', ') || 'none'}`)
    console.log(`Sources succeeded : ${result.sources_successful.join(', ') || 'none'}`)
    console.log('')
    console.log('Trigger text:')
    console.log(`  ${result.trigger_text}`)
    console.log('')
    if (result.trigger_source) {
      console.log('Trigger source:')
      console.log(`  Type: ${result.trigger_source.type}`)
      console.log(`  Date: ${result.trigger_source.date ?? 'unknown'}`)
      console.log(`  URL:  ${result.trigger_source.url ?? 'none'}`)
      console.log(`  Desc: ${result.trigger_source.description}`)
    }
    console.log('')
    console.log('Relevance reason:')
    console.log(`  ${result.relevance_reason}`)
    console.log('')
    console.log('Reasoning (first 500 chars):')
    console.log(result.synthesis_reasoning.slice(0, 500))

    // Verify DB writes.
    const supabase = createClient(url, key)

    const { data: researchRow } = await supabase
      .from('prospect_research_results')
      .select('id, icp_fit, has_dateable_signal, signal_relevance, qualification_status, synthesis_confidence, sources_successful, trigger_text, relevance_reason, synthesized_at')
      .eq('id', result.research_result_id)
      .single()

    console.log('\n=== prospect_research_results row ===')
    console.log(JSON.stringify(researchRow, null, 2))

    const { data: prospectRow } = await supabase
      .from('prospects')
      .select('icp_fit, has_dateable_signal, signal_observation, classified_at, qualification_status, current_research_result_id, personalisation_trigger, research_ran_at')
      .eq('id', PROSPECT_ID)
      .eq('organisation_id', ORG_ID)
      .single()

    console.log('\n=== prospects row (updated columns) ===')
    console.log(JSON.stringify(prospectRow, null, 2))

  } catch (err) {
    console.error('\n=== AGENT FAILED ===')
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

main()
