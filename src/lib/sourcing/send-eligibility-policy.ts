// Whether RESEARCH is worth paying for on a given prospect.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
//
// Measured 2026-08-25 on the first real queue batch: 12 of 13 prospects had already been
// verified as unmailable BEFORE research ran, and research ran on them anyway. The run
// cost $2.56 and bought ONE prospect that could actually be emailed.
//
// A send-eligibility gate already existed, but only DOWNSTREAM, at
// src/app/dashboard/operator/clients/[id]/actions.ts:329, whose own comment justifies it
// as avoiding paying "Anthropic to compose four emails for addresses already known to be
// dead". Research costs roughly 60x what composition costs per prospect and sat upstream
// of that gate with no equivalent predicate. This is that predicate, applied where the
// money actually is.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS READS THE RAW VERDICT AND NOT prospects.email_send_eligible
//
// The obvious implementation is `.eq('email_send_eligible', true)`, matching the send
// gate. It is wrong here, for two independent reasons.
//
// 1. email_send_eligible IS MATERIALISED, NOT EVALUATED. It is written once, at
//    verification time, by verification-trigger.ts:304 as
//    `eligibilityCheck.is_eligible && result.send_eligible`, where send_eligible is
//    computed in the MyEmailVerifier handler as `status === 'Valid' && !catch_all`
//    (adapter-myemailverifier.ts:76). So the Catch All policy is baked into the column at
//    the moment of verification. Flipping the policy would NOT change that column for the
//    29 prospects already on file: it would require RE-VERIFYING every one of them and
//    paying for it. Reading the raw verdict and applying policy here means one flag
//    changes one place and takes effect immediately, on data already bought.
//
// 2. THE COLUMN DEFAULTS TO false. It cannot distinguish "verified and ineligible" from
//    "never verified", because both read false. That distinction is the entire question of
//    what to do with an unverified prospect, so a predicate built on it is blind to the
//    case that matters most.
//
// The send gate is right to keep using the column: at send time the materialised verdict
// IS the decision, and it is the last word. This is a spend filter sitting in front of it,
// not a replacement for it.
// ═════════════════════════════════════════════════════════════════════════════

import { toCanonicalVerdict, isKnownVendorVerdict } from '@/lib/sourcing/verification-verdict'

/**
 * THE ONE LINE THAT CHANGES IF THE CATCH ALL POLICY CHANGES.
 *
 * A "Catch All" domain accepts mail for every address, so the verifier cannot confirm the
 * specific mailbox exists. It is not a dead address. It is an unconfirmable one, and
 * whether to send to it is a commercial judgement about bounce risk, not a fact.
 *
 * Currently false, matching the send gate, so the two do not disagree. It is 10 of the 28
 * unsuppressed prospects in the live organisation as at 2026-08-25 — 36% of the pool — so
 * this flag is worth more than any other single decision in this file.
 *
 * A catch-all deliverability test was queued separately. When it reports, change this
 * constant and nothing else. Do NOT also change adapter-myemailverifier.ts:76: that governs
 * SENDING, is materialised into a column, and would need a re-verification run to take
 * effect. Changing them independently is intended, because they answer different questions:
 * "is this worth researching" and "is this safe to send to" have different costs of being
 * wrong.
 */
export const CATCH_ALL_IS_RESEARCH_WORTHY = false

/** The verification columns this policy reads. Deliberately the raw ones. */
export interface VerificationFacts {
  independent_verified_at: string | null
  independent_email_status: string | null
  email_send_ineligible_reason: string | null
  /**
   * Which vendor produced independent_email_status. Optional: the column has a default of
   * the first-pass vendor's name and predates the second pass, so an absent value is read
   * as the first-pass vendor rather than rejected.
   */
  verification_provider?: string | null
  /**
   * The paid second pass, added 2026-08-25. Optional so every existing caller still
   * type-checks; absent or null means it has not run.
   *
   * A CATCH-ALL THE SECOND PASS RESOLVED IS WORTH RESEARCHING, and without this field it
   * would be refused. The whole point of paying for the second pass is that it converts an
   * unconfirmable address into a confirmed one, so the gate that decides whether to spend
   * research money has to be able to see the newer, better evidence.
   */
  second_pass_status?: string | null
  second_pass_provider?: string | null
}

export type IneligibleReason =
  | 'no_verdict'
  | 'undeliverable'
  | 'catch_all'
  | 'country_excluded'

export type ResearchEligibility =
  | { eligible: true }
  | { eligible: false; reason: IneligibleReason; detail: string }

// UNDELIVERABLE_STATUSES was here, holding ['Invalid', 'Unknown', 'Grey-listed'].
//
// It is DELETED rather than moved. It was one vendor's vocabulary embedded in a shared
// policy module, listed as leak L7 in the catch-all handover and flagged there as the only
// one of seven that costs anything on a live code path. The handover's advice was to fix it
// when a second vendor arrives and not before, because it is only wrong once two
// vocabularies exist. That is now.
//
// The same three facts are expressed by toCanonicalVerdict returning 'undeliverable' or
// 'unknown', which every vendor's words map into. Note the mapping is deliberately finer
// than the old list: Invalid is 'undeliverable' (a confirmed dead mailbox) while Unknown and
// Grey-listed are 'unknown' (no verdict reached). Both are refused research, for different
// stated reasons, where the flat list could not tell them apart.

/**
 * Should we spend research money on this prospect?
 *
 * NO VERDICT FAILS CLOSED, and here is the reasoning, because it is the half of this that
 * could plausibly have gone the other way.
 *
 * Failing OPEN reproduces exactly the bug being fixed: it spends the most expensive step in
 * the pipeline on a prospect whose mailability is unknown, which is the same error as
 * spending it on one known unmailable, just with less information to show for it.
 *
 * Failing CLOSED was rejected at first glance because verification cannot currently be
 * triggered from any UI or cron, so it looked like a permanent block. Two measurements
 * changed that, both taken 2026-08-25:
 *
 *   - EVERY prospect in the live organisation already has a verdict. 0 of 29. All 22
 *     unverified prospects on the platform sit in ARCHIVED organisations, which
 *     enqueueResearchForOrganisation already refuses before reaching this function. So
 *     failing closed blocks nothing that is reachable today.
 *   - The verification route EXISTS and works: POST /api/operator/verify-enriched. What is
 *     missing is a button, not the capability. That is a small, separately tracked gap.
 *
 * So failing closed costs nothing now, and when it does bite it forces the cheap step
 * (verification) to happen before the expensive one (research), which is the correct order.
 * It converts a silent money leak into a loud, cheap blocker, and it makes the missing
 * verification trigger visible instead of hiding it behind wasted spend.
 *
 * The caller MUST report skipped prospects rather than dropping them silently. An operator
 * who asks to research an organisation and gets fewer jobs than prospects needs to be told
 * which reason applied, or this predicate becomes the next invisible behaviour.
 */
export function checkResearchEligibility(p: VerificationFacts): ResearchEligibility {
  // Ordered so the reported reason is the most actionable one. A prospect with no verdict
  // in an excluded country is reported as no_verdict, because verifying it is the next
  // step either way and the country rule may not even be reached.
  if (p.independent_verified_at === null) {
    return {
      eligible: false,
      reason: 'no_verdict',
      detail: 'Never verified. Run email verification before spending research on it.',
    }
  }

  // Country exclusion is a hard commercial rule and is already materialised into its own
  // column by checkSendEligibility. Nothing about researching changes it.
  if (p.email_send_ineligible_reason !== null) {
    return {
      eligible: false,
      reason: 'country_excluded',
      detail: `Send-ineligible for a non-verification reason: ${p.email_send_ineligible_reason}.`,
    }
  }

  // TRANSLATED, NOT COMPARED TO VENDOR WORDS. This block used to test the raw strings
  // 'Invalid' / 'Unknown' / 'Grey-listed' / 'Catch All' directly, which was one vendor's
  // vocabulary sitting in a shared policy module. That was harmless while one vendor
  // existed and is not any more: a second vendor writes different words for the same facts.
  const firstPass = toCanonicalVerdict(p.verification_provider ?? null, p.independent_email_status)
  const secondPass = toCanonicalVerdict(p.second_pass_provider ?? null, p.second_pass_status ?? null)

  // THE SECOND PASS IS CONSULTED FIRST, because it is strictly newer and better evidence.
  // A catch-all resolved to deliverable is an ordinary confirmed address and is worth
  // researching regardless of what CATCH_ALL_IS_RESEARCH_WORTHY says: that flag governs the
  // UNRESOLVED case, which is the only case it was ever about.
  if (secondPass === 'deliverable') {
    return { eligible: true }
  }

  if (firstPass === 'undeliverable') {
    return {
      eligible: false,
      reason: 'undeliverable',
      detail:
        `Verification returned "${p.independent_email_status}". This address cannot be ` +
        'emailed under any policy, and a second opinion does not overturn it.',
    }
  }

  // A word we have NEVER SEEN is treated as "the vendor renamed something", not as a
  // verdict, and does not block research. See isKnownVendorVerdict for why this one case
  // fails open while everything else here fails closed. Checked before the 'unknown' branch
  // because toCanonicalVerdict collapses both into 'unknown'.
  if (!isKnownVendorVerdict(p.verification_provider ?? null, p.independent_email_status)) {
    return { eligible: true }
  }

  if (firstPass === 'unknown') {
    return {
      eligible: false,
      reason: 'undeliverable',
      detail:
        `Verification returned "${p.independent_email_status}", which reached no verdict. ` +
        'Not worth research spend until something confirms the mailbox.',
    }
  }

  if (firstPass === 'risky' && !CATCH_ALL_IS_RESEARCH_WORTHY) {
    return {
      eligible: false,
      reason: 'catch_all',
      detail:
        'Catch-all domain, so the mailbox cannot be confirmed, and the paid second pass has ' +
        'not resolved it' +
        (secondPass ? ` (it returned "${p.second_pass_status}")` : ' yet') +
        '. Policy currently treats these as not worth researching. Change ' +
        'CATCH_ALL_IS_RESEARCH_WORTHY to include them.',
    }
  }

  // A verdict exists, no country rule applies, and the status is neither undeliverable nor
  // a policy-excluded catch-all. Anything else — including a status the verifier's
  // vocabulary grows to include later — is treated as worth researching, because the send
  // gate downstream is still the last word and a new status should not silently halt the
  // pipeline.
  return { eligible: true }
}

/** Groups skipped prospects by reason, for an operator-readable message. */
export function summariseIneligible(reasons: IneligibleReason[]): string {
  const counts = new Map<IneligibleReason, number>()
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1)

  const LABELS: Record<IneligibleReason, string> = {
    no_verdict:       'never verified',
    undeliverable:    'verified undeliverable',
    catch_all:        'catch-all domain',
    country_excluded: 'excluded country',
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${LABELS[reason]}`)
    .join(', ')
}
