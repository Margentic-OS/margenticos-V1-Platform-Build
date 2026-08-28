// Blocks OUR execution stack leaking into a generated strategy document, without ever
// blocking a client from describing their own market.
//
// ─── WHY THIS EXISTS AND WHY THE PROMPT WAS NOT ENOUGH ───────────────────────
//
// Measured 2026-08-28. The vendor name "Apollo" appeared TWICE in icp-agent.md and
// THIRTY-THREE times in stored generated documents. The model was taught it as a schema
// prefix ("Apollo-detectable:") and then used it as ordinary vocabulary elsewhere,
// including twice in tier_3.disqualifiers, which the client-facing IcpDocumentView
// renders. A prompt-text scan would have caught 2 and missed 33.
//
// ADR-028: code validators are the hard gate, prompt instructions are advisory. This is
// the case where that is measured rather than assumed.
//
// ─── THE BOUNDARY, WHICH IS THE WHOLE DESIGN ─────────────────────────────────
//
// A gate that stops a client describing their own buyer is WORSE than the leak it
// prevents. A client selling to software vendors may legitimately name one in their ICP.
//
// So the line is SOURCEDNESS, and it is Rule 9's own test rather than a new one:
//
//     "Before writing any name or number, find the line in this message that supplied
//      it. If you cannot point to that line, it is Tier One."
//
//   UNSOURCED  the name appears nowhere in the input message. The model introduced it.
//              That is our stack leaking. Reported, and blocked once this is in block
//              mode.
//   SOURCED    the name appears in the intake, the uploads, the website text or the
//              research results, all of which are IN the input message. That is the
//              client's own market vocabulary. Allowed, logged, never gated.
//
// This cannot block a legitimate client description BY CONSTRUCTION: a legitimate
// description of a client's own market is sourced, because that is what makes it
// legitimate, and the gate reads exactly the message the model read.
//
// Ambiguity resolves to ALLOW. The failure mode is a missed leak, never a blocked client.
//
// Measured backing: "apollo" and "instantly" appear ZERO times in intake_responses and
// intake_website_pages across all five organisations, so this line would have caught all
// 33 occurrences with zero false positives on real data.
//
// ─── THE KNOWN HOLE, RECORDED RATHER THAN PATCHED ────────────────────────────
//
// A client who mentions a vendor incidentally ("we tried Apollo once" in intake) SOURCES
// the name, and the model may then reuse it as a signal prefix. The gate allows it and
// logs it as sourced. That is deliberate.
//
// DO NOT TRY TO FIX THIS BY MATCHING THE PHRASING. The 33 real occurrences used at least
// three unrelated shapes: "Apollo-detectable:", "Checkable via Apollo revenue estimates",
// and "no visible team beyond the founder on Apollo or LinkedIn". Guessing intent from
// phrasing means guessing wrong in both directions, and the direction that guesses wrong
// against the client is the one that matters. A sourced-mention review belongs in the
// report-only log, where a human reads it, not in a regex.

import { logger } from '@/lib/logger'

// Every vendor on CLAUDE.md's tool-name list, plus the ones that have reached a prompt.
// A new vendor goes here in the same commit that introduces its handler. That rule is the
// one MyEmailVerifier was missing from when it reached a column default.
const VENDOR_NAMES = [
  'Instantly', 'Apollo', 'Taplio', 'Lemlist', 'GoHighLevel', 'Calendly',
  'Hunter.io', 'MyEmailVerifier', 'Bouncer', 'Apify', 'Brave', 'Smartlead',
] as const

// Built from VENDOR_NAMES rather than written out again, so the list cannot drift from
// the pattern that searches for it.
const VENDOR_RE = new RegExp(
  `\\b(${VENDOR_NAMES.map(n => n.replace(/\./g, '\\.')).join('|')})\\b`,
  'gi',
)

// REPORT-ONLY FIRST, BY INSTRUCTION. Doug, 2026-08-28: "Report-only first, not blocking,
// for one week. If it fires zero times on real generations, flip it to blocking. A gate
// that has never been observed firing is a gate nobody has tested."
//
// The flip is a MANUAL decision after reading the logs, not a date this file rolls over
// on its own. An automatic flip would put the gate into blocking mode without anyone
// having looked at what it caught, which is the exact thing the observation week is for.
//
// TO FLIP: change this to 'block', and record in BACKLOG what the week's logs showed.
export type VendorGateMode = 'report' | 'block'
export const VENDOR_GATE_MODE: VendorGateMode = 'report'

// Review date, for the BACKLOG entry and for anyone finding this later.
export const VENDOR_GATE_REVIEW_AFTER = '2026-09-04'

export interface VendorHit {
  /** Dotted path to the string inside the document, e.g. tier_3.disqualifiers[1] */
  field: string
  vendor: string
  /** True when the name appears in the input message the model was given. */
  sourced: boolean
  /** The offending text, trimmed for the log. */
  excerpt: string
}

// Walks every string in the document, mirroring scrubAITellsDeep's traversal so the two
// see the same values.
function collectStrings(value: unknown, path: string, out: Array<{ path: string; text: string }>): void {
  if (typeof value === 'string') {
    out.push({ path, text: value })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectStrings(item, `${path}[${i}]`, out))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectStrings(v, path ? `${path}.${k}` : k, out)
    }
  }
}

/**
 * Finds vendor names in a generated document and marks each one sourced or unsourced
 * against the input message the model was given.
 *
 * Pure. Does not log, does not throw. Exported for tests.
 */
export function findVendorNames(document: unknown, inputMessage: string): VendorHit[] {
  const haystack = inputMessage.toLowerCase()
  const strings: Array<{ path: string; text: string }> = []
  collectStrings(document, '', strings)

  const hits: VendorHit[] = []
  for (const { path, text } of strings) {
    for (const match of text.matchAll(VENDOR_RE)) {
      const vendor = match[0]
      hits.push({
        field: path,
        vendor,
        // Case-insensitive substring, deliberately loose. A looser sourcedness test
        // ALLOWS more, and allowing is the safe direction here.
        sourced: haystack.includes(vendor.toLowerCase()),
        excerpt: text.trim().slice(0, 160),
      })
    }
  }
  return hits
}

/**
 * Runs the gate. Logs every hit with the document, the field and whether the name was
 * sourced. Throws only in 'block' mode and only for UNSOURCED hits.
 *
 * Call after the document parses and after scrubAITellsDeep, alongside assertNoDashes.
 */
export function assertNoUnsourcedVendorNames(
  document: unknown,
  inputMessage: string,
  context: { agent: string; organisation_id: string; document_type: string },
): VendorHit[] {
  const hits = findVendorNames(document, inputMessage)
  if (hits.length === 0) return hits

  const unsourced = hits.filter(h => !h.sourced)
  const sourced = hits.filter(h => h.sourced)

  if (sourced.length > 0) {
    // Allowed, and logged anyway. This is where the incidental-mention hole shows up, and
    // a human reading these is the intended review, not a regex.
    logger.info('vendor-name-gate: sourced vendor names allowed', {
      ...context,
      mode: VENDOR_GATE_MODE,
      count: sourced.length,
      hits: sourced.map(h => ({ field: h.field, vendor: h.vendor, excerpt: h.excerpt })),
    })
  }

  if (unsourced.length > 0) {
    logger.warn('vendor-name-gate: UNSOURCED vendor names in generated document', {
      ...context,
      mode: VENDOR_GATE_MODE,
      count: unsourced.length,
      hits: unsourced.map(h => ({ field: h.field, vendor: h.vendor, excerpt: h.excerpt })),
    })

    if (VENDOR_GATE_MODE === 'block') {
      const detail = unsourced.map(h => `${h.field}: "${h.vendor}"`).join('; ')
      throw new Error(
        `${context.agent}: generated document names a vendor that nothing in the input ` +
        `message supplied, so it was introduced by the model rather than by the client. ` +
        `Do not write to the database. ${detail}`,
      )
    }
  }

  return hits
}
