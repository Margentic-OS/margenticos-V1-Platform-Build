// Enrichment and tiering are pressed together, so their ceilings have to agree.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS EXISTS TO CATCH
//
// EnrichAndTierButton does two things on one press: it POSTs to enrich-approved-batch, then
// POSTs to tier-enriched-batch. Until 2026-09-23 both were capped at 100 and the pair matched
// BY COINCIDENCE: enrichment's limit lived in enrichment-trigger.ts and tiering's was the bare
// literal `100` in its route.
//
// That coincidence ended the moment one press started enriching up to
// ENRICHMENT_MAX_PER_REQUEST. A press would have enriched 500 and tiered 100, leaving 400
// enriched-but-untiered prospects: no error, no failed request, just a screen showing tiers for
// a fifth of the batch and four fifths sitting in a state nothing was going to move them out of.
//
// It is the same shape as CLAUDE.md's parallel arrays, one level up: two numbers in two files
// that have to stay in step, with nothing making them. The fix is that the route DERIVES its cap
// from the enrichment constant, and this test is what fails if anyone puts a literal back.
//
// ── WHY READING THE SOURCE IS THE RIGHT CHECK HERE ─────────────────────────
//
// The thing being protected is an ARGUMENT AT A CALL SITE, not a behaviour of a function. A
// behavioural test would have to stand up the route with a fake request, a fake session and a
// fake database, and would still only prove the cap for the fixture it was given. Reading the
// call site proves the coupling itself, which is the property that broke.
//
// It is a cheap early warning, not the authoritative check, and its limit is stated here for the
// next reader: it proves what the source says, not what a deployed route does. Same caveat as
// CLAUDE.md's note on tests that scan migration files.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { ENRICHMENT_MAX_PER_REQUEST } from '../enrichment-continuation'
import { ENRICHMENT_PER_PRESS_LIMIT } from '../enrichment-trigger'

const TIER_ROUTE = 'src/app/api/operator/organisations/[id]/tier-enriched-batch/route.ts'
const ENRICH_ROUTE = 'src/app/api/operator/organisations/[id]/enrich-approved-batch/route.ts'

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('the tiering route reads the enrichment ceiling instead of its own literal', () => {
  it('can find the call site at all, before anything is concluded from its absence', () => {
    // THE POSITIVE CONTROL. Every assertion below is about what the file does NOT contain, and a
    // renamed file or a renamed function would make all of them pass while proving nothing. This
    // is the check that the instrument can see a positive.
    const src = read(TIER_ROUTE)
    expect(src).toContain('tierEnrichedBatch(supabase, organisationId,')
  })

  it('passes ENRICHMENT_MAX_PER_REQUEST, not a number', () => {
    const src = read(TIER_ROUTE)
    expect(src).toContain('tierEnrichedBatch(supabase, organisationId, ENRICHMENT_MAX_PER_REQUEST)')
    // And imports it, so the identifier above is the real constant rather than a local of the
    // same name.
    expect(src).toMatch(
      /import \{ ENRICHMENT_MAX_PER_REQUEST \} from '@\/lib\/sourcing\/enrichment-continuation'/,
    )
  })

  it('does not pass a bare numeric cap to tierEnrichedBatch', () => {
    // The mutation this catches: putting `100` back, or "fixing" the mismatch by writing `500`,
    // which restores the coincidence rather than the coupling.
    const src = read(TIER_ROUTE)
    expect(src).not.toMatch(/tierEnrichedBatch\([^)]*,\s*\d+\s*\)/)
  })

  it('declares maxDuration, because it now writes up to 500 rows one at a time', () => {
    // The route had no declaration at all, which was survivable at 100 rows.
    const src = read(TIER_ROUTE)
    expect(src).toMatch(/export const maxDuration = 300/)
  })
})

describe('the two enrichment ceilings are different numbers on purpose', () => {
  it('keeps the per-pass limit below the per-press ceiling', () => {
    // If these were ever made equal, one press would be one pass again and the original defect
    // would be back, with no test failing anywhere else to say so.
    expect(ENRICHMENT_PER_PRESS_LIMIT).toBeLessThan(ENRICHMENT_MAX_PER_REQUEST)
  })

  it('has the enrich route reporting both, so the screen can explain what a press does', () => {
    const src = read(ENRICH_ROUTE)
    expect(src).toContain('per_pass_limit: ENRICHMENT_PER_PRESS_LIMIT')
    expect(src).toContain('max_per_request: ENRICHMENT_MAX_PER_REQUEST')
  })
})
