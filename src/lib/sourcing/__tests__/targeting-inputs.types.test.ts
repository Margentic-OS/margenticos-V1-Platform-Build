// COMPILE-TIME TESTS. The assertions in this file are checked by `tsc --noEmit`, which CI
// runs as its own blocking step, and not by vitest. The one runtime test at the bottom only
// keeps the file in the suite so that it is never mistaken for dead code and deleted.
//
// ─── WHAT IS BEING HELD ──────────────────────────────────────────────────────
//
// ADR-061 rests on one claim: the code that builds search settings can only read targeting
// fields. If it could read anything else, an edit to that other thing would change the
// search while the comparison in targeting-inputs.ts reported "no targeting change".
//
// The claim is held by the parameter types. So this file pins the parameter types, and
// then proves that prose is unreachable through them.
//
// ─── HOW AN UNUSED DIRECTIVE BECOMES THE FAILING TEST ────────────────────────
//
// Each `@ts-expect-error` below sits on a read that must not compile. If someone widens
// TargetingDocument so that the read becomes legal, the directive is left with no error to
// suppress, and TypeScript reports THAT as an error (TS2578). The test fails by going quiet.

import { describe, it, expect } from 'vitest'
import type { TargetingDocument } from '@/lib/sourcing/targeting-inputs'
import type { IcpDocument, deriveFilterSpec } from '@/lib/agents/icp-filter-spec'
import type { collectTargetingGeographyStatements } from '@/agents/icp-geography-agent'
import type { ResolveIcpGeographyInput } from '@/lib/sourcing/resolve-icp-geography'

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

// The two derivations that read the document accept the projection, exactly. Widening either
// back to the full document type makes its line a compile error.
export const derivationReadsTheProjection:
  Exact<Parameters<typeof deriveFilterSpec>[0], TargetingDocument> = true
export const geographyReadsTheProjection:
  Exact<Parameters<typeof collectTargetingGeographyStatements>[0], TargetingDocument> = true
export const resolverReadsTheProjection:
  Exact<ResolveIcpGeographyInput['doc'], TargetingDocument> = true

// CONTROL: `Exact` can say no. The full document is wider than the projection, and if this
// line stopped compiling as `false` the three lines above would be proving nothing.
export const theFullDocumentIsWider: Exact<IcpDocument, TargetingDocument> = false

// A full document is still ACCEPTED where the projection is asked for, which is what lets
// every existing caller keep passing one.
export function acceptsAFullDocument(doc: IcpDocument): TargetingDocument {
  return doc
}

export function proseIsUnreachable(doc: TargetingDocument): void {
  // @ts-expect-error the summary is prose
  void doc.summary
  // @ts-expect-error the job-to-be-done statement is prose
  void doc.jtbd_statement
  // @ts-expect-error tier 3 is the disqualifier tier, and no derivation reads it
  void doc.tier_3
  // @ts-expect-error triggers decide what research looks for, never who is sourced
  void doc.tier_1.triggers
  // @ts-expect-error a tier's description is prose
  void doc.tier_2.description
  // @ts-expect-error stage is read by the fit dimensions only (ADR-061, costs accepted)
  void doc.tier_1.company_profile.stage
  // @ts-expect-error business model, the same
  void doc.tier_1.company_profile.business_model
  // @ts-expect-error only the buyer's title and seniority are targeting fields
  void doc.tier_1.buyer_profile.day_to_day
}

describe('targeting inputs, compile-time', () => {
  it('is checked by tsc; see the comment at the top of this file', () => {
    expect(derivationReadsTheProjection && geographyReadsTheProjection && resolverReadsTheProjection)
      .toBe(true)
    expect(theFullDocumentIsWider).toBe(false)
  })
})
