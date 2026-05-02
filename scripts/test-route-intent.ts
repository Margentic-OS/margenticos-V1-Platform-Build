// scripts/test-route-intent.ts
// Printer-with-assertions test for routeIntent.
// Run: npm run test-routing
// No test runner — fails with process.exit(1) if any assertion fails.

import { routeIntent, type RoutingDecision } from '../src/lib/reply-handling/route-intent'

let passed = 0
let failed = 0

function assert(
  label: string,
  got: RoutingDecision,
  expected: RoutingDecision,
): void {
  if (got === expected) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.error(`  FAIL  ${label}`)
    console.error(`        got: ${got}   expected: ${expected}`)
    failed++
  }
}

console.log('\n── routeIntent tests ──────────────────────────────────────────\n')

// ── Tier 1 intents ────────────────────────────────────────────────────────────

console.log('Tier 1 — always handled upstream')
assert('opt_out',     routeIntent({ intent: 'opt_out',     confidence: 0.95, faqMatchTopScore: null }), 'tier_1_handled')
assert('out_of_office', routeIntent({ intent: 'out_of_office', confidence: 0.90, faqMatchTopScore: null }), 'tier_1_handled')
assert('positive_direct_booking @ 0.90 exact', routeIntent({ intent: 'positive_direct_booking', confidence: 0.90, faqMatchTopScore: null }), 'tier_1_handled')
assert('positive_direct_booking @ 1.00', routeIntent({ intent: 'positive_direct_booking', confidence: 1.00, faqMatchTopScore: null }), 'tier_1_handled')

// ── positive_direct_booking tier boundaries ───────────────────────────────────

console.log('\npositive_direct_booking confidence boundaries')
assert('@ 0.89 → tier_2', routeIntent({ intent: 'positive_direct_booking', confidence: 0.89, faqMatchTopScore: null }), 'tier_2')
assert('@ 0.70 → tier_2', routeIntent({ intent: 'positive_direct_booking', confidence: 0.70, faqMatchTopScore: null }), 'tier_2')
assert('@ 0.69 → tier_3', routeIntent({ intent: 'positive_direct_booking', confidence: 0.69, faqMatchTopScore: null }), 'tier_3')
assert('@ 0.00 → tier_3', routeIntent({ intent: 'positive_direct_booking', confidence: 0.00, faqMatchTopScore: null }), 'tier_3')

// ── Always Tier 2 ─────────────────────────────────────────────────────────────

console.log('\nAlways Tier 2')
assert('positive_passive', routeIntent({ intent: 'positive_passive', confidence: 0.80, faqMatchTopScore: null }), 'tier_2')
assert('objection_mild',   routeIntent({ intent: 'objection_mild',   confidence: 0.75, faqMatchTopScore: null }), 'tier_2')

// ── Always Tier 3 ─────────────────────────────────────────────────────────────

console.log('\nAlways Tier 3')
assert('information_request_commercial', routeIntent({ intent: 'information_request_commercial', confidence: 0.90, faqMatchTopScore: 0.90 }), 'tier_3')
assert('unclear',                        routeIntent({ intent: 'unclear',                        confidence: 0.60, faqMatchTopScore: null }),  'tier_3')

// ── information_request_generic with FAQ score boundaries ─────────────────────

console.log('\ninformation_request_generic FAQ score boundaries')
assert('FAQ score 0.66 → tier_2', routeIntent({ intent: 'information_request_generic', confidence: 0.80, faqMatchTopScore: 0.66 }), 'tier_2')
assert('FAQ score 0.65 exact → tier_2', routeIntent({ intent: 'information_request_generic', confidence: 0.80, faqMatchTopScore: 0.65 }), 'tier_2')
assert('FAQ score 0.64 → tier_3', routeIntent({ intent: 'information_request_generic', confidence: 0.80, faqMatchTopScore: 0.64 }), 'tier_3')
assert('FAQ score null → tier_3',  routeIntent({ intent: 'information_request_generic', confidence: 0.80, faqMatchTopScore: null }),  'tier_3')
assert('FAQ score 0.00 → tier_3', routeIntent({ intent: 'information_request_generic', confidence: 0.80, faqMatchTopScore: 0.00 }), 'tier_3')

// ── Unknown intent → log_only ─────────────────────────────────────────────────

console.log('\nUnknown intent')
assert('completely_made_up → log_only', routeIntent({ intent: 'completely_made_up', confidence: 0.80, faqMatchTopScore: null }), 'log_only')
assert('empty string → log_only',       routeIntent({ intent: '',                   confidence: 0.80, faqMatchTopScore: null }), 'log_only')

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n── Results ────────────────────────────────────────────────────`)
console.log(`   Passed: ${passed}   Failed: ${failed}`)

if (failed > 0) {
  console.error('\nTest run FAILED')
  process.exit(1)
}

console.log('\nAll tests passed.')
