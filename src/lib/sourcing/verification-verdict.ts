// The canonical vocabulary for email verification verdicts.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS NOW AND NOT BEFORE
//
// CLAUDE.md's rule is that a handler owns its vendor's vocabulary and nothing upstream sees
// vendor-specific names. Until 2026-08-25 that rule was broken for verification in seven
// places, and the catch-all handover argued correctly that fixing it before a second vendor
// existed would be busywork: with one vendor, its words ARE the canonical words, and the
// leak costs nothing.
//
// A second vendor now exists, so it costs. Two vendors emit different words for the same
// fact, and shared code that branches on one vendor's spelling silently mishandles the
// other's. This module is the translation layer that makes both readable by one policy.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IS DELIBERATELY NOT CHANGED
//
// The RAW vendor verdict is still stored, in independent_email_status for the first pass and
// second_pass_status for the second. That is on purpose:
//
//   - It is the audit trail. "Bouncer said deliverable on a domain MyEmailVerifier called
//     catch-all" is the fact that justifies mailing the address, and a canonicalised
//     'deliverable' on its own cannot express it.
//   - Rewriting 29 stored verdicts to canonical form would be a migration whose only
//     benefit is tidiness, and which destroys the vendor's actual answer.
//
// So: raw in the column, canonical in the logic. Translation happens on read.

/**
 * The four states any verifier can meaningfully report.
 *
 *   deliverable   the mailbox was confirmed to accept mail
 *   undeliverable the mailbox was confirmed NOT to exist. A positive finding
 *   risky         reachable but unconfirmable. A catch-all domain is the archetype
 *   unknown       the check could not reach a verdict at all
 *
 * The difference between undeliverable and unknown is the one that matters commercially.
 * Undeliverable is information; unknown is the absence of it, and a second vendor can
 * legitimately resolve the second but should never be asked to overturn the first.
 */
export type CanonicalVerdict = 'deliverable' | 'undeliverable' | 'risky' | 'unknown'

import {
  MYEMAILVERIFIER_PROVIDER_KEY,
  MYEMAILVERIFIER_VERDICT_MAP,
} from '@/lib/sourcing/handlers/adapter-myemailverifier'
import { BOUNCER_PROVIDER_KEY, BOUNCER_VERDICT_MAP } from '@/lib/sourcing/handlers/adapter-bouncer'

/**
 * THE REGISTRY. Provider key to that provider's own vocabulary map.
 *
 * EACH MAP LIVES WITH ITS HANDLER, not here. CLAUDE.md: "Each sourcing handler owns its own
 * translation table... Translation is the handler's responsibility. Nothing upstream of the
 * handler sees tool-specific names." This module is upstream of both handlers, so it holds
 * the wiring and none of the words.
 *
 * That makes adding a vendor exactly what the capability-registry rule describes: a new
 * handler exporting its own map, plus one line here. No shared file learns a new verdict word,
 * and no shared file has to be reviewed when a vendor changes its vocabulary.
 *
 * WHY A LOOKUP RATHER THAN ASKING THE HANDLER. A handler can translate its own live response,
 * and adapter-bouncer.ts does. It cannot translate a verdict read back out of the database
 * months later, because at that point all we have is a provider string and a stored word.
 * That read path is what this registry serves.
 */
const VENDOR_VERDICTS: Record<string, Record<string, CanonicalVerdict>> = {
  [MYEMAILVERIFIER_PROVIDER_KEY]: MYEMAILVERIFIER_VERDICT_MAP,
  [BOUNCER_PROVIDER_KEY]: BOUNCER_VERDICT_MAP,
}

/** The fallback vocabulary when a row carries no provider. See toCanonicalVerdict. */
const DEFAULT_VERDICT_MAP: Record<string, CanonicalVerdict> = MYEMAILVERIFIER_VERDICT_MAP

/**
 * Translate a stored vendor verdict into the canonical vocabulary.
 *
 * UNRECOGNISED INPUT BECOMES 'unknown', NOT 'deliverable'. An unmapped word means a vendor
 * has changed its vocabulary underneath us, and the safe reading of "we do not understand
 * this answer" is that no verdict was reached. Defaulting the other way would mail addresses
 * on the strength of a word nobody has read.
 *
 * A null status likewise returns null, meaning "never verified", which is distinct from
 * 'unknown', meaning "verified, no verdict reached". The research spend gate depends on
 * telling those apart.
 */
export function toCanonicalVerdict(
  provider: string | null | undefined,
  rawStatus: string | null | undefined,
): CanonicalVerdict | null {
  if (!rawStatus) return null

  // The first-pass provider column defaults to a vendor name and predates this module, so a
  // missing provider is read as the first-pass vendor rather than rejected.
  const key = (provider ?? MYEMAILVERIFIER_PROVIDER_KEY).trim().toLowerCase()
  const table = VENDOR_VERDICTS[key] ?? DEFAULT_VERDICT_MAP

  return table[rawStatus.trim()] ?? 'unknown'
}

/**
 * Is this a word the named vendor is known to emit?
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS SEPARATELY FROM toCanonicalVerdict
 *
 * The two gates in this system want OPPOSITE defaults for an unrecognised vendor word, and
 * both are right.
 *
 * SEND SAFETY fails closed. toCanonicalVerdict degrades an unreadable word to 'unknown', so
 * an address is never mailed on the strength of a word nobody has read.
 *
 * RESEARCH SPEND fails OPEN on this specific case, and deliberately. An unrecognised status
 * almost always means a vendor renamed something, for example 'Valid' becoming
 * 'Deliverable'. If that halted research, one vendor rename would silently stop the entire
 * pipeline platform-wide, with no cheap remedy and nothing to say why. Spending research
 * money on a handful of addresses is the much smaller error, and the send gate downstream is
 * still the last word before anything is mailed.
 *
 * This is the same principle send-eligibility-policy.ts already states about
 * CATCH_ALL_IS_RESEARCH_WORTHY: "is this worth researching" and "is this safe to send to"
 * answer different questions and have different costs of being wrong. Note the research gate
 * still fails CLOSED on a status it DOES recognise as unknown, and on no verdict at all.
 * The open case is narrow: a word we have never seen before.
 */
export function isKnownVendorVerdict(
  provider: string | null | undefined,
  rawStatus: string | null | undefined,
): boolean {
  if (!rawStatus) return false
  const key = (provider ?? MYEMAILVERIFIER_PROVIDER_KEY).trim().toLowerCase()
  const table = VENDOR_VERDICTS[key] ?? DEFAULT_VERDICT_MAP
  return rawStatus.trim() in table
}

/**
 * The raw first-pass statuses a second pass is worth PAYING for.
 *
 * Derived from the map rather than typed out, so adding a vendor word in one place cannot
 * leave this list stale. This is the one spot where vendor spellings legitimately reach a
 * database filter: PostgREST has to compare against what is actually stored, and centralising
 * the list here is what keeps that from being scattered across query builders.
 *
 * WHY 'Grey-listed' IS EXCLUDED DESPITE MAPPING TO unknown. The first-pass trigger already
 * retries greylisted addresses up to MAX_RETRY_ATTEMPTS for free, six hours apart. Paying a
 * second vendor while a free retry is still pending spends money to answer a question that
 * was about to answer itself. There are zero greylisted rows in the live database, so this
 * costs nothing today and can be revisited if that changes.
 */
export const SECOND_PASS_WORTH_PAYING_FOR: readonly string[] = Object.entries(
  MYEMAILVERIFIER_VERDICT_MAP as Record<string, CanonicalVerdict>,
)
  .filter(([raw, canonical]) => (canonical === 'risky' || canonical === 'unknown') && raw !== 'Grey-listed')
  .map(([raw]) => raw)
