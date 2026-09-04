import type { SupabaseClient } from '@supabase/supabase-js'
import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import { logger } from '@/lib/logger'
import {
  mapApolloToSpecIndustry,
  mapApolloToSpecIndustryWithDatabase,
  loadIndustryTagMappings,
} from './industry-mapping'
import {
  evaluateBuyerCriterion,
  seniorityScoreFor,
  type BuyerVerdict,
} from './buyer-criterion'

export interface EnrichedProspect {
  id: string
  organisation_id: string
  email_status: string | null
  enrichment_status: string | null
  job_title: string | null
  company_headcount: number | null
  company_industry: string | null
  company_name?: string | null
}

// Every reason a prospect can be REMOVED at stage 1. One list, and the reporting
// counts are derived from it rather than hand-listed beside it, so a new
// disqualifier cannot be added without its count appearing in the log.
//
// It is a `const` array rather than a bare union type because a type alone would
// vanish at run time and the counting code would be back to a hand-maintained
// second list. Anything not in here still gets counted, under `removed_other`,
// with the raw reasons named: a reason that falls through must be visible rather
// than silently absent, which is the whole point of this file's changes.
//
// THIS LIST IS THE REASONS THE CURRENT CODE CAN PRODUCE, not every reason a stored row
// can carry. `industry_not_consulting` was renamed to `industry_off_target` and is gone
// from here because nothing writes it any more, but rows removed under the old name are
// still in the database and still have to render. Operator-facing wording therefore
// keeps BOTH keys, in prospect-status.ts, which is the only place that wording lives.
export const REMOVAL_REASONS = [
  'email_unverified',
  'no_title',
  'not_decision_maker',
  'no_buyer_criterion',
  'company_too_large',
  'industry_excluded',
  'industry_off_target',
] as const

export type RemovalReason = typeof REMOVAL_REASONS[number]

interface TierResult {
  prospect_id: string
  sourced_tier: 'tier_1' | 'tier_2' | 'tier_3' | null
  fit_score: number | null
  // For a removed prospect this is a RemovalReason. For a survivor it is the
  // free-text score breakdown built at the bottom of classifyTier, which is why
  // the type stays `string` rather than narrowing to the union.
  tiering_reason: string
}

// ─── The hardcoded decision-maker list is DELETED, not parameterised ─────────
//
// DECISION_MAKER_PATTERNS was twelve title fragments applied identically to every
// client. It is a Rule Zero violation that stayed invisible only because every
// prospect sourced so far happened to fit it, and because one live client in a market
// that shares none of its vocabulary passed it by a coincidental substring collision.
//
// Who a client's buyer is now comes from that client's own documents, through
// spec.buyer_criterion. See src/agents/buyer-criterion-agent.ts.
//
// calculateSeniorityScore used to re-list the same fragments inline as a points
// ladder, and had already drifted from the list above: it had no band for one entry
// and scored another only on an exact match. Both now read the one criterion, through
// a single evaluation per prospect, so there is no second copy left to drift.

// ─── The hardcoded consultancy patterns are DELETED, not parameterised ───────
//
// CONSULTANCY_PATTERNS was seven literal fragments naming one market's vocabulary,
// applied identically to every client. It is the same Rule Zero violation as the
// decision-maker list above, arriving one function later, and it survived that
// deletion because it sits on the INDUSTRY axis rather than the buyer axis and so
// was not what anyone was looking at.
//
// It did two jobs and both were wrong for any client outside that one market:
//
//   1. It RESCUED an off-target prospect from disqualifier 6. A firm whose industry
//      tag missed but whose NAME says what it is got a second chance. For a client
//      selling into schools or hospitals, the rescue could only ever fire on a
//      consulting firm, so the rescue was dead code for them and live for one client.
//   2. It awarded 20 fit points for an "adjacent" industry, on the same basis.
//
// What replaces it is the client's OWN keywords, from their own spec. That field
// already exists, is already per client, and is already what the sourcing handler
// post-filters on through keywords_excluded. Reading it here means the rescue speaks
// whatever vocabulary the client's documents use, and a client whose spec names no
// keywords simply gets no rescue rather than another market's.

/**
 * Does the company name or job title carry any of the words THIS client targets?
 *
 * The keywords come from the client's spec and from nowhere else. An empty or absent
 * keyword list returns false, which is the honest answer: no evidence was asked for,
 * so none was found. It must not fall back to a default list, because a default list
 * is what this replaced.
 *
 * Matched as a lowercase substring over `company_name + job_title`, which is what the
 * deleted version did. The matching is unchanged on purpose: this commit changes WHERE
 * the words come from, so that the tier movement it causes is attributable to that and
 * not to a simultaneous change in how they are compared.
 */
function hasTargetKeywordEvidence(
  prospect: EnrichedProspect,
  icpFilterSpec: ICPFilterSpec,
): boolean {
  const keywords = icpFilterSpec.keywords
  if (!keywords || keywords.length === 0) return false

  const signals = [
    prospect.company_name || '',
    prospect.job_title || '',
  ]
    .join(' ')
    .toLowerCase()

  return keywords.some(keyword => {
    const needle = keyword.toLowerCase().trim()
    return needle.length > 0 && signals.includes(needle)
  })
}

/**
 * Seniority points for a prospect, from the SAME verdict the disqualifier used.
 *
 * The verdict is computed once per prospect in classifyTier and passed in, rather than
 * re-derived here. Re-deriving is how the old inline ladder drifted from the list it
 * was supposed to mirror.
 *
 * A survivor always scores. Every verdict that would score zero is now stopped before
 * this point: `reject` and `no_criterion` are disqualifiers 3 and 3b, and `no_title` is
 * disqualifier 2. The zero branch below is therefore unreachable from classifyTier and
 * is kept only so the function is total for any other caller.
 */
function calculateSeniorityScore(verdict: BuyerVerdict): number {
  return seniorityScoreFor(verdict)
}

/**
 * Calculate headcount score based on company size.
 * Returns 0-20 points based on headcount bands.
 */
function calculateHeadcountScore(headcount: number | null): number {
  if (headcount === null || headcount === undefined) return 10 // unknown = 10

  if (headcount >= 1 && headcount <= 20) return 20
  if (headcount >= 21 && headcount <= 50) return 10
  if (headcount >= 51 && headcount <= 100) return 5

  return 0 // Outside the viable range
}

/**
 * The industry axis, 0 to 45.
 *
 * TWO EARLY RETURNS USED TO THROW AWAY THE EVIDENCE THE DISQUALIFIER HAD JUST ACCEPTED,
 * and that is what this rewrite fixes. It is the validate-one-thing-return-another shape
 * from CLAUDE.md, on the scoring side rather than the gating side.
 *
 * Disqualifier 6 REMOVES a prospect whose tag is not on target unless the company carries
 * one of this client's own keywords. So every survivor with an off-target or unreadable
 * tag has keyword evidence BY CONSTRUCTION: the gate is what let it through. This function
 * then returned 0 for two of those three cases, because it bailed out before reaching the
 * keyword branch:
 *
 *   `if (!prospect.company_industry) return 0`  the provider sent no tag at all. This is
 *   not a rare case, it is the ONLY case for a client whose prospects are not yet enriched:
 *   sourcing does not write company_industry, so all 40 rows for the two newest clients
 *   are in it. Disqualifier 6 is skipped entirely for them, so they survive, and then
 *   score zero on an axis worth 45.
 *
 *   `if (!mappedIndustry) return 0`  a tag arrived and no canonical name matched its
 *   wording. Disqualifier 6 required keyword evidence to let this prospect live, and the
 *   next line discarded it.
 *
 * Absence of evidence was being scored as evidence of absence, on the one axis large
 * enough to decide the tier by itself.
 *
 * THE RULE IS NOW ONE RULE, and the three cases collapse into it:
 *
 *   45  the tag resolves to a canonical name this client's specification names.
 *   20  it does not, and the company still carries one of this client's own keywords.
 *        The 20 rather than 45 is deliberate and is not softened here: a keyword in a
 *        company name is weaker evidence than a resolved sector, and when the tag DID
 *        resolve to something else it is evidence in conflict.
 *    0  no evidence either way.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not raise keyword evidence to 45 when the
 * tag is missing. That would let a company in an unrelated sector reach tier 1 on nothing
 * but a word in its name, and the words are broad: a client whose canonical name yields a
 * common head noun would promote anything containing it. The structural consequence is
 * recorded rather than engineered around: tier 1 needs 80, seniority and headcount cap at
 * 55 together, so TIER 1 REQUIRES THE 45. A client whose provider tags never resolve
 * cannot produce a tier 1 prospect at all. That is not fixed here because fixing it means
 * knowing the provider's tag vocabulary, which needs the paid enrichment sample the
 * BACKLOG describes. It is in BACKLOG, with this arithmetic.
 */
function calculateIndustryScore(
  prospect: EnrichedProspect,
  icpFilterSpec: ICPFilterSpec,
  databaseMappings: Record<string, string>,
): number {
  const mappedIndustry = prospect.company_industry
    ? mapApolloToSpecIndustryWithDatabase(prospect.company_industry, databaseMappings)
    : null

  // On target: the resolved sector is one this client's specification names.
  if (
    mappedIndustry &&
    icpFilterSpec.industries &&
    icpFilterSpec.industries.some(
      ind => ind.toLowerCase() === mappedIndustry.toLowerCase()
    )
  ) {
    return 45
  }

  // Not on target, by absence or by conflict. The client's own keywords are the only
  // evidence left, and they are the same evidence disqualifier 6 admitted this prospect on.
  if (hasTargetKeywordEvidence(prospect, icpFilterSpec)) {
    return 20
  }

  return 0
}

/**
 * The headcount ceiling for THIS client, or null when the client stated none.
 *
 * WHAT HAPPENS WHEN A CLIENT HAS NO CAP: the disqualifier does not run, and this logs a
 * warn naming the organisation. It does NOT fall back to a default ceiling and it does
 * NOT withhold the tier.
 *
 * Not a default, because a default ceiling is exactly what this replaced. Inventing 100
 * again for the specification that forgot to say is the same defect with a narrower
 * blast radius, and it would be invisible in precisely the case where the number is
 * least likely to be right.
 *
 * Not a withheld tier either, and this is the part that differs from disqualifier 3b
 * above, deliberately. A missing buyer criterion FABRICATED a value: seniority is 35 of
 * the 100 points and the code scored it 0 while reporting it had not decided, so the
 * verdict froze on the row with a silent ceiling of 65. Nothing comparable happens here.
 * calculateHeadcountScore already handles an unknown headcount explicitly, an oversized
 * company still scores 0 on that axis and lands lower on its own, and no axis is
 * fabricated. Removing every prospect for a client whose specification omits one field
 * would turn a missing input into a total pipeline stop, which is a heavier answer than
 * the input deserves.
 *
 * A specification that reaches here at all has already passed the sourcing orchestrator,
 * which refuses a null spec outright. As of 2026-09-03 every stored spec carries a
 * usable cap, so this branch is unreached in production and exists for specs written
 * before the field, and for a hand-edited one.
 *
 * IT DOES NOT LOG, and that is deliberate rather than an omission. classifyTier runs once
 * per PROSPECT and the missing ceiling is a fact about the RUN, so warning here would
 * emit the same line once per row and bury itself, which is exactly what
 * reportSpecDivergence had to be moved out of the pagination loop to stop doing. The
 * report belongs where the spec is read once: inspectFilterSpec, which the orchestrator
 * calls a single time before the first request and which already reports this field
 * absent or of the wrong type. A non-positive number is reported there too.
 */
function resolveHeadcountCeiling(icpFilterSpec: ICPFilterSpec): number | null {
  const ceiling = icpFilterSpec.company_headcount_max

  if (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling <= 0) {
    return null
  }

  return ceiling
}

/**
 * Two-stage tiering model:
 * STAGE 1: Disqualifiers (binary REMOVE)
 * STAGE 2: Fit Score (0-100) for survivors
 */
export async function classifyTier(
  prospect: EnrichedProspect,
  icpFilterSpec: ICPFilterSpec,
  supabase?: SupabaseClient<any>,
): Promise<TierResult> {
  const prospectId = prospect.id

  // Load database mappings for industry if supabase is provided
  let databaseMappings: Record<string, string> = {}
  if (supabase) {
    try {
      databaseMappings = await loadIndustryTagMappings(supabase)
    } catch (error) {
      logger.warn('Failed to load database mappings, falling back to static', {
        prospect_id: prospectId,
        error: String(error),
      })
      databaseMappings = {}
    }
  }

  // STAGE 1: DISQUALIFIERS (binary REMOVE)

  // Disqualifier 1: Email status must be verified
  if (prospect.email_status !== 'verified') {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      fit_score: null,
      tiering_reason: 'email_unverified' satisfies RemovalReason,
    }
  }

  // Disqualifier 2: Job title missing (seniority unknown)
  if (!prospect.job_title) {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      fit_score: null,
      tiering_reason: 'no_title' satisfies RemovalReason,
    }
  }

  // Disqualifier 3: not this client's buyer.
  //
  // Evaluated ONCE and reused by the fit score below. The same evaluation runs before
  // enrichment in enrichment-selection.ts, so a prospect reaching here has usually
  // already passed it; this is the second gate for anything enriched before the
  // criterion existed, and for the paths that do not run the pre-enrichment gate.
  const buyerVerdict = evaluateBuyerCriterion(icpFilterSpec.buyer_criterion, prospect.job_title)

  if (buyerVerdict.decision === 'reject') {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      fit_score: null,
      tiering_reason: 'not_decision_maker' satisfies RemovalReason,
    }
  }

  // Disqualifier 3b: THERE IS NO CRITERION TO JUDGE BY. Withhold the tier, loudly.
  //
  // This is not a verdict about the prospect. It is a refusal to produce one, and the
  // difference matters because `sourced_tier` is a MATERIALISED VERDICT: nothing
  // re-evaluates it once written except the spec-change thaw in persist-icp-filter-spec.
  //
  // WHAT IT USED TO DO, and why that was worse than either alternative. The gate above
  // fails OPEN on `no_criterion`, deliberately, so an unvalidated criterion cannot
  // quietly stop a client's pipeline. But `seniorityScoreFor` then returns 0 for the
  // same verdict, because there is no rank to read. So the prospect was let through the
  // disqualifier as "we did not check" and scored as "we checked and this person is
  // worth nothing". The seniority axis is 35 of the 100 points and tier 1 needs 80, so
  // a client with no criterion had a SILENT CEILING OF 65 and could never produce a
  // tier 1 prospect however good its prospects were. Nothing said so. The batch looked
  // like poor sourcing rather than a missing input, and the wrong verdict froze on the
  // row.
  //
  // That is the validate-one-thing-return-another shape from CLAUDE.md: the check ran,
  // reported that it had not decided, and the thing downstream decided anyway.
  //
  // FAIL LOUDLY WAS CHOSEN OVER FAIL OPEN, and the choice is narrow on purpose:
  //
  //   - Only the TIER is withheld. The pre-enrichment buyer gate in
  //     enrichment-selection.ts reads the same evaluateBuyerCriterion and still fails
  //     open. Nothing about spend changes, so this cannot make a client pay more.
  //   - It is RECOVERABLE with no new machinery. persistIcpFilterSpec already clears
  //     tiering_reason for every row with a null tier when a new spec is stored, so the
  //     moment an ICP carrying a criterion is approved these rows re-tier by themselves.
  //   - It is VISIBLE. `removed_no_buyer_criterion` is derived from REMOVAL_REASONS, so
  //     it gets its own always-present count in logClassificationStats, and a non-zero
  //     removal count logs at warn.
  //
  // A fabricated tier computed from a missing axis is worse than no tier, because the
  // first looks like data and the second looks like a question.
  if (buyerVerdict.decision === 'no_criterion') {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      fit_score: null,
      tiering_reason: 'no_buyer_criterion' satisfies RemovalReason,
    }
  }

  // Disqualifier 4: the company is larger than THIS CLIENT asked for.
  //
  // The ceiling was the literal 100 for every client, whatever their specification said.
  // That is the same Rule Zero shape as the deleted buyer and keyword lists, arriving on
  // the size axis: a number that describes one market applied to all of them.
  //
  // It is not a harmless approximation in either direction. A client whose specification
  // reaches higher than 100 had everything above it REMOVED, and removed under a reason
  // that reads like a deliberate verdict rather than a stale constant. A client whose
  // specification stops well below 100 had the gate do nothing, and the size axis fell
  // entirely to the 0-to-20 fit points, which cannot remove anything.
  //
  // The bound is inclusive because company_headcount_max is the top of the band the ICP
  // states, not the first value outside it.
  const headcountCeiling = resolveHeadcountCeiling(icpFilterSpec)

  if (
    headcountCeiling !== null &&
    prospect.company_headcount !== null &&
    prospect.company_headcount > headcountCeiling
  ) {
    return {
      prospect_id: prospectId,
      sourced_tier: null,
      fit_score: null,
      tiering_reason: 'company_too_large' satisfies RemovalReason,
    }
  }

  // Disqualifier 5: Industry excluded (hard gate)
  if (prospect.company_industry) {
    const mappedIndustry = mapApolloToSpecIndustryWithDatabase(
      prospect.company_industry,
      databaseMappings,
    )

    if (
      mappedIndustry &&
      icpFilterSpec.industries_excluded &&
      icpFilterSpec.industries_excluded.some(
        ind => ind.toLowerCase() === mappedIndustry.toLowerCase()
      )
    ) {
      return {
        prospect_id: prospectId,
        sourced_tier: null,
        fit_score: null,
        tiering_reason: 'industry_excluded' satisfies RemovalReason,
      }
    }
  }

  // Disqualifier 6: Not on-target AND no evidence in this client's own keywords
  if (prospect.company_industry) {
    const mappedIndustry = mapApolloToSpecIndustryWithDatabase(
      prospect.company_industry,
      databaseMappings,
    )

    // Check if it's on-target (in the ICP industries list)
    const isOnTarget =
      mappedIndustry &&
      icpFilterSpec.industries &&
      icpFilterSpec.industries.some(
        ind => ind.toLowerCase() === mappedIndustry.toLowerCase()
      )

    // Disqualify if: NOT on-target AND no keyword evidence
    // This applies to both unmapped industries and mapped-but-off-target industries
    if (!isOnTarget && !hasTargetKeywordEvidence(prospect, icpFilterSpec)) {
      return {
        prospect_id: prospectId,
        sourced_tier: null,
        fit_score: null,
        tiering_reason: 'industry_off_target' satisfies RemovalReason,
      }
    }
  }

  // STAGE 2: FIT SCORE (0-100) for survivors
  const industryScore = calculateIndustryScore(prospect, icpFilterSpec, databaseMappings)
  const seniorityScore = calculateSeniorityScore(buyerVerdict)
  const headcountScore = calculateHeadcountScore(prospect.company_headcount)

  const fitScore = industryScore + seniorityScore + headcountScore

  // Determine tier based on score thresholds
  let tier: 'tier_1' | 'tier_2' | 'tier_3'
  if (fitScore >= 80) {
    tier = 'tier_1'
  } else if (fitScore >= 50) {
    tier = 'tier_2'
  } else {
    tier = 'tier_3'
  }

  const tiering_reason = `${tier} (score ${fitScore}): industry ${industryScore}, seniority ${seniorityScore}, headcount ${headcountScore}`

  return {
    prospect_id: prospectId,
    sourced_tier: tier,
    fit_score: fitScore,
    tiering_reason,
  }
}

export function logClassificationStats(
  results: TierResult[],
  organisationId: string,
): void {
  const counts = {
    tier_1: 0,
    tier_2: 0,
    tier_3: 0,
    null: 0,
  }

  const reasons: Record<string, number> = {}

  for (const result of results) {
    if (result.sourced_tier) {
      counts[result.sourced_tier]++
    } else {
      counts.null++
    }

    reasons[result.tiering_reason] = (reasons[result.tiering_reason] || 0) + 1
  }

  // ── Flat, greppable removal counts ─────────────────────────────────────────
  //
  // WHY FLAT AND NOT NESTED. `breakdown_by_reason` is a nested object, so in the
  // production log stream the only literal that appears is the outer key. A search
  // for `industry_off_target` finds it inside the JSON blob but nothing can
  // alert or chart on it without parsing the object first. `removed_industry_off_target`
  // is a key in its own right, always present, always a number.
  //
  // ALWAYS PRESENT, including as a zero. A key that only appears when non-zero
  // makes "no prospects were removed for this reason" and "this reason is no longer
  // being counted" look identical downstream, which is the failure mode this whole
  // change exists to remove.
  //
  // Derived from REMOVAL_REASONS with Object.fromEntries rather than written out,
  // so the counts and the reasons cannot drift into the parallel-array shape.
  const removedCounts = Object.fromEntries(
    REMOVAL_REASONS.map(reason => [`removed_${reason}`, reasons[reason] ?? 0]),
  ) as Record<`removed_${RemovalReason}`, number>

  // Anything that removed a prospect without being a registered reason. Counted
  // and NAMED rather than dropped: an unregistered reason is a defect in this
  // file, and it must not be the quiet kind.
  const knownReasons = new Set<string>(REMOVAL_REASONS)
  const otherRemovalReasons = results
    .filter(r => r.sourced_tier === null && !knownReasons.has(r.tiering_reason))
    .map(r => r.tiering_reason)
  const removedOther = otherRemovalReasons.length

  const payload = {
    organisation_id: organisationId,
    total_classified: results.length,
    tier_1_count: counts.tier_1,
    tier_2_count: counts.tier_2,
    tier_3_count: counts.tier_3,
    removed_count: counts.null,
    ...removedCounts,
    removed_other: removedOther,
    ...(removedOther > 0
      ? { removed_other_reasons: Array.from(new Set(otherRemovalReasons)) }
      : {}),
    breakdown_by_reason: reasons,
  }

  // warn when the batch lost prospects, info when it did not.
  //
  // These were already logger.info, which the logger does NOT suppress in
  // production (only `debug` is suppressed, src/lib/logger/index.ts). So the
  // counts did reach the logs. What they did not do is stand out: a batch where
  // every prospect was removed produced a line indistinguishable in level from a
  // batch where none were, sitting in a stream of ordinary run-progress info.
  // warn is what separates them.
  if (counts.null > 0) {
    logger.warn('tier-classification: two-stage model run complete, prospects were removed', payload)
  } else {
    logger.info('tier-classification: two-stage model run complete', payload)
  }
}
