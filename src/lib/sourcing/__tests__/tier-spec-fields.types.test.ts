// COMPILE-TIME TESTS. The assertions in this file are checked by `tsc --noEmit`, which CI
// runs as its own blocking step, and not by vitest. The runtime tests at the bottom keep
// the file in the suite and check the one thing a type cannot: that the list is not empty.
//
// ─── WHAT IS BEING HELD ──────────────────────────────────────────────────────
//
// ADR-061 rule 7: approving a change to the search settings re-queues the removed
// prospects only when the change touches something tiering reads. The approval answers
// "what does tiering read" from TIERING_SPEC_FIELDS.
//
// If tiering could read a field that list omits, a change to that field would be approved,
// the rule that removed people would have changed, and nobody would be re-queued. So the
// list is the parameter type, and this file pins the parameter type.
//
// ─── HOW AN UNUSED DIRECTIVE BECOMES THE FAILING TEST ────────────────────────
//
// Each `@ts-expect-error` sits on a read that must not compile. Widen TieringSpec so the
// read becomes legal and the directive has nothing to suppress, which TypeScript reports
// as an error (TS2578). The test fails by going quiet.

import { describe, it, expect } from 'vitest'
import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import {
  TIERING_SPEC_FIELDS,
  type classifyTier,
  type TieringSpec,
  type TieringSpecField,
} from '@/lib/sourcing/tier-classification'

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

// The classifier accepts the projection, exactly. Widening it back to the full settings
// type makes this line a compile error.
export const tieringReadsTheProjection:
  Exact<Parameters<typeof classifyTier>[1], TieringSpec> = true

// The projection is exactly the listed fields, in both directions.
export const theProjectionIsTheList: Exact<keyof TieringSpec, TieringSpecField> = true

// CONTROL: `Exact` can say no. The full settings are wider than the projection, and if this
// line stopped compiling as `false` the two lines above would be proving nothing.
export const theFullSettingsAreWider: Exact<ICPFilterSpec, TieringSpec> = false

// Full settings are still ACCEPTED where the projection is asked for, which is what lets
// every existing caller keep passing them.
export function acceptsFullSettings(spec: ICPFilterSpec): TieringSpec {
  return spec
}

export function nothingElseIsReachable(spec: TieringSpec): void {
  // @ts-expect-error the titles sent to the provider are not what tiering judges a buyer by
  void spec.job_titles
  // @ts-expect-error nor are the excluded titles: tiering reads the criterion's own reject list
  void spec.job_titles_excluded
  // @ts-expect-error the provider seniority filter is not the buyer criterion (ADR-046)
  void spec.seniority_levels
  // @ts-expect-error tiering does not judge geography
  void spec.company_countries
  // @ts-expect-error tiering reads the headcount ceiling only
  void spec.company_headcount_min
  // @ts-expect-error tiering does not read the revenue band
  void spec.company_revenue_max
  // @ts-expect-error excluded keywords are a post-filter in the sourcing handler
  void spec.keywords_excluded
  // @ts-expect-error switched-off axes change the provider request, never a tier verdict
  void spec.omitted_axes
  // @ts-expect-error the fit dimensions are read by the research judge
  void spec.fit_dimensions

  // CONTROL: the listed fields ARE reachable. If these stopped compiling the directives
  // above would be passing for the wrong reason.
  void spec.buyer_criterion
  void spec.company_headcount_max
  void spec.industries
  void spec.industries_excluded
  void spec.keywords
}

describe('what tiering reads from the search settings', () => {
  it('is a list with something in it', () => {
    // An empty list would make "no tiering field changed" true of every approval.
    expect(TIERING_SPEC_FIELDS.length).toBeGreaterThan(0)
    expect(new Set(TIERING_SPEC_FIELDS).size).toBe(TIERING_SPEC_FIELDS.length)
  })

  it('includes the buyer criterion, which is what the pre-enrichment gate reads too', () => {
    expect(TIERING_SPEC_FIELDS).toContain('buyer_criterion')
  })
})
