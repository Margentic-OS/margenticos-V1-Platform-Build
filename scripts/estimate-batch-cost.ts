// Standalone cost estimator for prospect research batches.
// Run before deciding whether to execute a batch:
//   npx tsx --env-file=.env.local scripts/estimate-batch-cost.ts <prospect_count>
//
// Reads APIFY_API_KEY and BRAVE_SEARCH_API_KEY from env to determine which sources
// are active. Apollo is $0 (included in plan). Exit 0 always — no batch is run.

import {
  COST_ANTHROPIC_LOW,
  COST_ANTHROPIC_HIGH,
  COST_APIFY,
  BRAVE_FREE_MONTHLY,
  BRAVE_PAID_PER_CALL,
  HAIKU_PERSONALIZATION_USD,
} from '../src/lib/agents/research/cost-constants'

function printEstimate(totalProspects: number): void {
  const hasApify = !!process.env.APIFY_API_KEY
  const hasBrave = !!process.env.BRAVE_SEARCH_API_KEY

  const apifyCost     = hasApify ? totalProspects * COST_APIFY : 0
  const braveCallsNeeded = hasBrave ? totalProspects * 2 : 0
  const braveCost     = hasBrave ? braveCallsNeeded * BRAVE_PAID_PER_CALL : 0
  const anthropicLow  = totalProspects * COST_ANTHROPIC_LOW
  const anthropicHigh = totalProspects * COST_ANTHROPIC_HIGH
  const haikuCost     = totalProspects * HAIKU_PERSONALIZATION_USD

  const totalLow  = apifyCost + anthropicLow  + haikuCost
  const totalHigh = apifyCost + braveCost + anthropicHigh + haikuCost

  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  Pre-batch cost estimate — ${totalProspects} prospects`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  Apify LinkedIn   : ${hasApify ? `~$${apifyCost.toFixed(2)} (${totalProspects}×$${COST_APIFY})` : '✗ APIFY_API_KEY not set (skipped)'}`)
  if (hasBrave) {
    console.log(`  Brave Search     : ~$0–$${braveCost.toFixed(2)} (${braveCallsNeeded} calls; free up to ${BRAVE_FREE_MONTHLY}/month)`)
    console.log(`                     Check usage: https://api.search.brave.com/app/subscriptions`)
  } else {
    console.log(`  Brave Search     : $0 (key not set — Anthropic native search only)`)
  }
  console.log(`  Anthropic Sonnet : ~$${anthropicLow.toFixed(2)}–$${anthropicHigh.toFixed(2)}`)
  console.log(`  Anthropic Haiku  : ~$${haikuCost.toFixed(2)} (personalisation)`)
  console.log(`  Apollo           : $0 (included in plan)`)
  console.log('  ─────────────────────────────────────────────────')
  console.log(`  Estimated total  : ~$${totalLow.toFixed(2)}–$${totalHigh.toFixed(2)}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')
}

const arg = process.argv[2]
const count = parseInt(arg ?? '', 10)

if (!arg || isNaN(count) || count < 1) {
  console.error('Usage: npx tsx --env-file=.env.local scripts/estimate-batch-cost.ts <prospect_count>')
  console.error('Example: npx tsx --env-file=.env.local scripts/estimate-batch-cost.ts 50')
  process.exit(1)
}

printEstimate(count)
