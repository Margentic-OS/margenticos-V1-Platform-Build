// WHICH VARIANTS SHIP AN OPENING THAT DOES NOT READ AS A FIRST LINE.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY AN OPERATOR NEEDS THIS AND A LOG LINE IS NOT ENOUGH
//
// compose-sequence.ts already reports the same fault, per prospect, at the moment it ships.
// That is the right place to catch it and the wrong place to ACT on it: by then the email
// exists and the operator is not reading logs.
//
// This asks the question one level up and one step earlier. A messaging document has a fixed
// set of variants, each with one authored opening, and every prospect without research
// receives one of them. So the fault is a property of the DOCUMENT, it can be reported per
// variant rather than per prospect, and it can be shown on the screen an operator reads
// before publishing a list.
//
// ═════════════════════════════════════════════════════════════════════════════
// DRIVEN BY THE DOCUMENT, NOT BY A LIST OF KNOWN-BAD COPY
//
// Nothing here knows a variant name, a client, a sector or a phrase. It reads whatever
// openings the document contains and applies findStandaloneOpeningFaults to each. A document
// written for any industry is judged on its own text.
//
// REPORTS. Never edits copy, never blocks publishing, never blocks a send.

import { fallbackOpeningParagraph } from '@/lib/composition/compose-sequence'
import {
  findStandaloneOpeningFaults,
  type StandaloneOpeningFinding,
} from '@/lib/style/standalone-opening'

/**
 * The shape this reads out of a messaging document.
 *
 * DELIBERATELY STRUCTURAL AND NOT THE FULL MessagingContent TYPE. This module is handed a
 * stored JSON column that may have been written by an older generator, so it asserts as
 * little as it can get away with and skips anything that does not match, rather than
 * throwing on a document it does not recognise. A report that crashes the screen it appears
 * on is worse than a report that is silent about one variant.
 */
interface VariantLike {
  emails?: Array<{ sequence_position?: number; body?: string }>
}

export interface VariantOpeningFinding {
  /** The variant key as stored, e.g. the document's own identifier for it. */
  variantId: string
  /** The opening paragraph as authored. */
  opening: string
  faults: StandaloneOpeningFinding[]
}

/**
 * Every variant in this document whose fallback opening does not read as a first line.
 *
 * An empty array means every variant's opening stands on its own, OR that the document had
 * no readable variants at all. THOSE TWO ARE NOT THE SAME THING and the caller is told which
 * by `variantsChecked`: a check that returns nothing because it could not see anything must
 * not read as a clean bill of health. That is the failure this codebase keeps rediscovering,
 * and it is why the count comes back rather than just the findings.
 */
export function reportFallbackOpenings(content: unknown): {
  variantsChecked: number
  findings: VariantOpeningFinding[]
} {
  const doc = content as { variants?: Record<string, VariantLike>; emails?: VariantLike['emails'] } | null
  if (!doc || typeof doc !== 'object') return { variantsChecked: 0, findings: [] }

  // Both stored formats. The four-variant format is current (ADR-014); the single-sequence
  // format pre-dates it and stored documents still carry it, so it is read rather than
  // ignored, under a name that says what it is.
  const variants: Array<[string, VariantLike]> = doc.variants
    ? Object.entries(doc.variants)
    : doc.emails
      ? [['the single authored sequence', { emails: doc.emails }]]
      : []

  const findings: VariantOpeningFinding[] = []
  let variantsChecked = 0

  for (const [variantId, variant] of variants) {
    const emails = variant?.emails
    if (!Array.isArray(emails)) continue

    // Read through composition's OWN locator, so the paragraph judged here is the paragraph
    // that ships. A second way of finding "the opening" could pass on a line the composer
    // never sends.
    const opening = fallbackOpeningParagraph(
      emails.filter(e => typeof e?.body === 'string') as Parameters<typeof fallbackOpeningParagraph>[0],
    )
    if (opening === null) continue

    variantsChecked += 1
    const faults = findStandaloneOpeningFaults(opening)
    if (faults.length > 0) findings.push({ variantId, opening, faults })
  }

  return { variantsChecked, findings }
}
