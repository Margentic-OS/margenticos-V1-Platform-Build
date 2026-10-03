// Writing the opening for the email it will land in, then judging the finished artifact.
//
// EXTRACTED, NOT REWRITTEN. Moved out of runProspectResearchAgentV2 on 2026-08-26 so
// phase 2 of the batch path produces openings with the SAME code rather than a copy.
//
// This is the block that decides what a prospect actually receives, so a second copy
// drifting would not show up as an error. It would show up as different copy, and only
// for prospects that happened to go down the other path.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  composeEmail1WithOpening,
  getVariantEmail1Frame,
} from '@/lib/composition/compose-sequence'
import { assignVariantDeterministically } from '@/lib/composition/variant-assignment'
import { chooseOfferLineVariant, type OfferLineChoice } from '@/lib/composition/offer-angle'
import { contentOverlap } from './synthesize'
import { variantOfferAngles } from '@/lib/composition/compose-sequence'
import { writeAndJudgeOpening, buildFindingsBlock, buildFindingsEvidence, type OpeningResult, type AttemptObservation, type NotWrittenReason } from './write-opening'
import { writeFollowups, type FollowupResult } from './write-followups'
import { factCheckOpening } from './fact-check-opening'
import { checkNeedMatchesOffer } from './need-matches-offer'
import { fingerprintEmail1 } from '@/lib/composition/followup-assignment'
import {
  buildFollowupReference,
  EMPTY_FOLLOWUP,
  type FollowupReference,
  type FollowupOutcome,
} from './followup-frame'
import { resolveBuyer } from './resolve-buyer'
import { holdsPersonalisation, reasonTheWritersArgueFrom, resolveApprovedReason, type ApprovedReason, type TriggerWithReason } from './approved-reason'
import { checkBridgeStatesReason } from './reason-match'
import { logger } from '@/lib/logger'
import { FatalApiError } from '@/lib/agents/fatal-api-error'
import type { BatchUniquenessRegistry } from '@/lib/agents/research/batch-uniqueness'
import { ZERO_TOKEN_USAGE, addTokenUsage, type TokenUsage, type ProspectContext, type ObservationCandidate } from './types'
import { hasUsableCandidate } from './synthesize'

/**
 * The messaging document content the opening is written against.
 *
 * Typed as the composition layer's shape via the functions that consume it, and passed
 * IN rather than fetched here, because the two callers get it from different places and
 * that difference is the whole point of the batch split:
 *
 *   the inline agent  fetches the currently approved document, moments before writing
 *   phase 2           reads the SNAPSHOT taken by phase 1, up to 24 hours earlier
 *
 * Phase 2 must not re-fetch. If the document was revised during the batch wait, the
 * writer would be scoped to different copy than phase 1 planned for, and nothing would
 * fail: the email would simply be different. That is precisely why compose was never
 * migrated to the queue.
 */
export type MessagingContent = Parameters<typeof getVariantEmail1Frame>[0]

export interface ProduceOpeningInput {
  apiKey: string
  clientName: string
  ctx: ProspectContext
  candidates: ObservationCandidate[]
  /**
   * The candidate synthesis selected, and its one-sentence relevance reason. Both live on
   * SynthesisOutput rather than on a candidate, so they are the two things the writer used
   * to lose at this boundary while opposite_reading and inference_direction travelled
   * fine inside the candidate objects themselves.
   *
   * Optional. The stored-findings branch makes no synthesis call, so it reaches no
   * selection of its own; since 2026-09-14 it carries the one its source row recorded
   * instead. Where that row has none, buildFindingsBlock simply marks nothing.
   */
  selectedCandidateId?: string | null
  relevanceReason?: string | null
  /** Why the selected finding beat the runner-up, from synthesis. One sentence. */
  selectionReason?: string | null
  /** Why what was found gives THIS prospect a reason. The writer's second line states it. */
  prospectReason?: string | null
  /** A second candidate that strengthens the same reason. */
  supportingCandidateId?: string | null
  messagingContent: MessagingContent
  variantId: string
  /**
   * The client's ICP tier-1 buyer title, tier 2 of the buyer precedence. Passed IN rather
   * than read here for the same reason messagingContent is: the two callers get it from
   * different places, and that difference is the whole point of the batch split. The
   * inline path reads it live; phase 2 reads the snapshot phase 1 took.
   *
   * Optional at the type level because the batch snapshot is JSONB written before the
   * field existed, so an older entry reads back as undefined rather than null.
   */
  icpBuyerTitle?: string | null
  /**
   * The client's positioning document, flattened. When present, every need Email 1 and the
   * follow-ups name must be one a line of that document says the service meets.
   *
   * ABSENT MEANS THE CHECK DOES NOT RUN, and that is the only switch there is. It follows
   * the shape `factCheck` already uses in the writer: a gate that cannot be left out would
   * make every offline test and the template arm impossible to run.
   *
   * Optional at the type level because the batch snapshot is JSONB written before the field
   * existed, so an older entry reads back as undefined rather than null. Same story as
   * icpBuyerTitle above, and the same reason.
   */
  positioningText?: string | null
  /**
   * The client's triggers, each with the reason the operator approved, IN THE ORDER
   * SYNTHESIS READ THEM. The opening argues from the approved reason of the trigger the
   * selected fact matched, verbatim, and a fact that matched none is not personalised.
   * See approved-reason.ts.
   *
   * Passed IN, as the buyer title and the positioning document are, because the two paths
   * read it from different places: the inline path from the live ICP, phase 2 from the
   * snapshot phase 1 took. A candidate's matched_trigger is a position in the list
   * synthesis was given, which is NOT always this one (the inline path reads the documents
   * a second time, and a reuse run carries positions from an earlier day), so the position
   * is checked against the trigger's recorded wording. See resolveApprovedReason.
   *
   * Absent, or carrying no reason at all, means the rule cannot be applied and is not: the
   * writer is briefed as it was before, with a warning logged.
   */
  triggers?: ReadonlyArray<TriggerWithReason> | null
  /**
   * WHETHER THE NEED-MATCH CHECK BLOCKS, OR ONLY REPORTS. Defaults to REPORT.
   *
   * ═══ WHY THIS IS A PARAMETER AND NOT A MODULE CONSTANT ═══
   *
   * activity-verdict and opening-reference both carry their mode as a constant in their own
   * file, which is right for a rule that is either on or off everywhere. This one has to be
   * BOTH AT ONCE: report in production, block in one arm of the A/B, in the same binary on
   * the same commit. A constant cannot do that, and two binaries differing by an edit is the
   * thing an A/B is supposed to rule out.
   *
   * MEASURED, over 56 stored Email 1s on 2026-09-29: blocking would reject 17 of them, and
   * on the operator's own controls it holds 2 of 2 it must catch and 4 of 5 it must pass.
   * Not good enough to gate production on. What is not known is how often a REJECTION IS
   * RECOVERED BY A RETRY, because a replay over stored copy cannot answer that: the writer
   * never runs. The A/B arm is what answers it, which is why the blocking path exists at all.
   *
   * REPORT STILL RUNS THE CHECK AND STILL PAYS FOR IT. It is not a way of turning the call
   * off; it is a way of seeing the verdict without acting on it, which is the only way the
   * rate on live copy becomes visible.
   */
  needMatchMode?: 'report' | 'block'
  /** Batch-scoped. Absent on a single-prospect run, where there is nothing to collide with. */
  uniqueness?: BatchUniquenessRegistry
  /**
   * Per-attempt telemetry, passed straight through to the writer. Observation only, and
   * omitted by both production callers, so it changes nothing about what a prospect gets.
   */
  onAttempt?: (observation: AttemptObservation) => void
  /**
   * THE FLAG. True also writes emails 2 and 3, in their OWN model call with their own
   * prompt, AFTER Email 1 is finished and only if the personalised Email 1 won.
   *
   * DEFAULTS TO FALSE. Who passes true, as of 2026-10-01: phase 2 of the batch path
   * (always, for a prospect on the generated arm), and the inline agent when ITS caller
   * asked for follow-ups, which is the command line and phase 1's stored-findings
   * shortcut. The dashboard's inline research and the queue's single 'research' job do
   * not, because the calls do not fit their time budget; a prospect they personalise is
   * held at upload until the backfill has written its follow-ups.
   *
   * WITH IT FALSE, EMAIL 1 IS NOT MERELY UNAFFECTED, IT IS UNAWARE. writeAndJudgeOpening
   * takes no follow-up parameter and write-opening.ts is byte-identical to main. The flag
   * is read here, after that function has already returned.
   */
  writeFollowupEmails?: boolean
}

/**
 * What produceOpening adds to the writer's result: the two follow-ups, and how they were
 * produced. Separate from OpeningResult because OpeningResult belongs to the Email 1
 * writer, and that file is deliberately untouched.
 */
export interface OpeningWithFollowups extends OpeningResult {
  email2: FollowupOutcome
  email3: FollowupOutcome
  /** Usage of the follow-up call only. ZERO when it did not run. */
  followup_usage: FollowupResult['usage'] | null
  /** Every follow-up attempt, kept so a rejection can be read rather than counted. */
  followup_attempts: FollowupResult['attempts']
  /**
   * The fingerprint of the Email 1 the follow-ups were written against, or null when none
   * were written.
   *
   * RETURNED RATHER THAN RECOMPUTED BY THE CALLER, because the string that was hashed is
   * the exact Email 1 this function handed the follow-up writer, and nothing outside this
   * function can reproduce it without composing the email a second time. A second
   * composition is a second chance to pass a different argument, which is how a fingerprint
   * ends up describing a body nobody sent.
   */
  followup_email1_fingerprint: string | null
  /**
   * What the opening was held to: the client's approved reason for the trigger the selected
   * fact matched, or why there was none. Absent only where the writer was stopped earlier
   * for having no usable candidate. Stored with the rest of this result in
   * prospects.trigger_data.judge, so it can be read back per prospect.
   */
  approved_reason?: ApprovedReason
}

/**
 * Build the tone-and-length reference for emails 2 and 3 from the client's own approved
 * messaging document.
 *
 * ONE EMPTY REFERENCE BORROWS THE OTHER. It does not decline. Changed 2026-09-24.
 *
 * It used to return null whenever either position stripped to nothing, and that turned out
 * to be a live case rather than a theoretical one. Measured on the only active messaging
 * document: variant D's Email 3 has just TWO middle paragraphs, an opener and the closing
 * question. Both are stripped, nothing is left, and every variant-D prospect lost BOTH
 * follow-ups. Two of nine in the backfill of 2026-09-24.
 *
 * Worth knowing what the old value was, because it explains why the strip is right and the
 * decline was wrong: before the closing question was stripped, that variant's entire Email 3
 * reference WAS the approved closing question, nine words and nothing else. So the choice
 * was never between a good reference and no reference. It was between showing the writer
 * only the question, showing it nothing, or showing it the register of the sibling email.
 *
 * The sibling is the best of the three. Emails 2 and 3 are the same client, the same voice
 * and the same buyer, written in the same document; what differs is their JOB, and the job
 * is stated in the prompt rather than inferred from the sample. The substitution is NAMED to
 * the writer through borrowedPosition, so it is not reading a mislabelled block.
 *
 * STILL RETURNS NULL when BOTH strip to nothing, because then there is no sibling to borrow
 * and nothing to substitute. That is a different case from the one this fixes.
 */
export function buildFollowupsFor(
  messagingContent: MessagingContent,
  variantId: string,
  companyName: string | null,
): FollowupReference | null {
  const variant = messagingContent.variants?.[variantId]
  const emails = variant?.emails ?? messagingContent.emails
  if (!emails) return null

  const body = (position: number): string | null =>
    emails.find(e => e.sequence_position === position)?.body ?? null

  const templateBody2 = body(2)
  const templateBody3 = body(3)
  if (!templateBody2 || !templateBody3) return null

  const own2 = buildFollowupReference(templateBody2)
  const own3 = buildFollowupReference(templateBody3)
  if (!own2 && !own3) return null

  const borrowedPosition = !own2 ? 2 : !own3 ? 3 : null
  const reference2 = own2 || own3
  const reference3 = own3 || own2

  return { reference2, reference3, templateBody2, templateBody3, companyName, borrowedPosition }
}

/**
 * The judge_reasoning a prospect carries when the writer was not run because synthesis found
 * no usable candidate. EXPORTED so the export and any report can count these by value rather
 * than by matching prose.
 */
export const NO_USABLE_CANDIDATE_REASON =
  'Not written: synthesis found no usable candidate for this prospect, so the approved template ships.'

/**
 * The judge_reasoning a prospect carries when no opening was written because the selected
 * fact has no approved reason behind it. EXPORTED for the same reason as the one above.
 */
export const NO_APPROVED_REASON_REASON =
  'Not written: the fact research selected matched none of this client\'s triggers that carry an approved reason, ' +
  'so there is no approved account of what it means for the prospect. No personalised opening is written.'

/**
 * What produceOpening returns when the writer is not run. Nothing was written and nothing
 * was compared, so the arrays are empty and the usage is zero. The same shape the batch
 * path's EMPTY_OPENING uses for a prospect that stopped being mailable, and callers already
 * store it: personalisation_trigger stays null and composition ships the approved opener.
 */
function notWrittenOpening(code: NotWrittenReason, reason: string): OpeningWithFollowups {
  return {
    not_written_reason: code,
    opening: null,
    question: null,
    subject: null,
    bridge: null,
    observation: null,
    written_won: false,
    retry_used: false,
    retries_used: 0,
    strong_material: false,
    judge_reasoning: reason,
    usage: ZERO_TOKEN_USAGE,
    comparisons: [],
    gate_failures: [],
    // The writer never ran, so there is nothing to record. Distinct from an empty array on
    // a prospect that DID run: written_won and not_written_reason tell those apart.
    attempts: [],
    // The sixth fallback path, and the only one that never enters writeAndJudgeOpening.
    // The approved template Email 1 ships, so no follow-up may reference it.
    email2: EMPTY_FOLLOWUP,
    email3: EMPTY_FOLLOWUP,
    followup_usage: null,
    followup_attempts: [],
    followup_email1_fingerprint: null,
  } satisfies OpeningWithFollowups
}

/**
 * Resolve which variant this prospect's opening is written for.
 *
 * Read from the prospect row when one has already been assigned. Otherwise chosen by which
 * variant's OFFER LINE answers this prospect's hook, falling back to the same deterministic
 * hash composition uses.
 *
 * ─── WHY THE HOOK NOW DECIDES, AND WHAT THAT CHANGED ─────────────────────────
 *
 * It used to be the hash alone, and the hash knows nothing about the prospect beyond their
 * id. The offer line is the paragraph a personalised Email 1 KEEPS, so pairing it with the
 * hook by chance meant the two halves of the email were about different things as often as
 * not. Six of twenty blind-marked emails drew exactly that complaint from the operator, in
 * both arms of the A/B, which is the most frequent single fault in that review. See
 * offer-angle.ts for the measurement and for why the tag cannot be derived from the text.
 *
 * ─── THE CHOICE IS WRITTEN BACK, WHICH IT NEVER USED TO BE ───────────────────
 *
 * This function's contract used to end "Nothing is written back: assignment stays
 * composition's job", and that was safe only because both sides computed the SAME hash from
 * the SAME prospect id. An angle-based choice cannot work that way: the writer must choose
 * before it writes, and composition can only see the finished trigger, which is a different
 * string from the candidate observation the choice was made on. Two sides deriving from two
 * different strings is the producer-and-consumer-disagree shape, and here it would ship a
 * researched opening above an offer line it was not written for, with nothing to notice.
 *
 * So the caller persists the answer and composition honours prospects.variant_id, which it
 * already did. The `assignedVariantId ?? ` precedence is what keeps that safe on a RE-RESEARCH:
 * the second run reads the variant the first run stored and does not choose again, so the
 * writer and composition stay on one variant for the life of the prospect.
 */
export function resolveVariantId(
  prospectId: string,
  assignedVariantId: string | null,
  messagingContent: MessagingContent,
  /**
   * The hook this opening will be built on: the selected candidate's observation, NOT the
   * written opening, which does not exist yet.
   *
   * Omitted by callers that have no hook in hand, and omitting it falls straight through to
   * the hash, which is the behaviour every caller had before this parameter existed.
   */
  hookText?: string | null,
): { variantId: string; basis: OfferLineChoice['basis'] | 'assigned' } {
  const availableVariants = messagingContent.variants
    ? Object.keys(messagingContent.variants).sort()
    : ['A', 'B', 'C', 'D']

  // AN ASSIGNED VARIANT THE DOCUMENT NO LONGER HAS IS NOT AN ASSIGNMENT. Returning it sent
  // getVariantEmails to its fallback, so the opening was written and judged against the
  // FIRST variant's offer line under the missing variant's name, nothing was written back
  // (basis 'assigned' writes nothing), and upload later hashed the prospect across the
  // survivors: an opening above an offer line it was never written for, with no record.
  // Composition has reassigned such prospects since 2026-09-20; research never did. Found
  // 2026-10-01, when brief-generated templates dropped from four variants to three.
  //
  // Falling through chooses again by hook, then by hash, exactly as for a prospect with no
  // variant, and the caller writes that choice back because the basis is not 'assigned'.
  if (assignedVariantId && availableVariants.includes(assignedVariantId)) {
    return { variantId: assignedVariantId, basis: 'assigned' }
  }

  const hashed = assignVariantDeterministically(prospectId, availableVariants)
  if (!hookText?.trim()) return { variantId: hashed, basis: 'no_tags' }

  const choice = chooseOfferLineVariant(
    hookText,
    hashed,
    variantOfferAngles(messagingContent),
    prospectId,
    contentOverlap,
  )
  return { variantId: choice.variantId, basis: choice.basis }
}

/**
 * The candidates a follow-up may be written from: the one Email 1 opened on, and the one
 * that supports the same reason. Nothing else research found.
 *
 * ─── WHY THE FOLLOW-UP WRITER IS NOT SHOWN EVERYTHING ────────────────────────
 *
 * Operator note 4 on the second reading (2026-10-01): when Email 1 is personalised, Email 2
 * or 3 carries THAT thread forward. The follow-up writer's prompt has always said "one
 * finding, developed across the three", and it was then handed every candidate, with one
 * line of the prompt inviting it to use a second fact in Email 3. Measured on the 71 stored
 * follow-ups of the live client the same day: five open on a different fact from the one
 * Email 1 used. A reader who was told about their new hire on Monday is told about their
 * award on Thursday, and the sequence reads as two unrelated emails.
 *
 * A prompt instruction is advisory (ADR-028). A fact the writer was never shown cannot be
 * opened on, so the rule is enforced by what is passed in.
 *
 * WHEN NO SELECTION IS KNOWN the whole list is returned, as before. That happens only on
 * rows whose source run reached no selection, and narrowing to nothing would leave the
 * writer with no finding at all.
 *
 * The EVIDENCE corpus the gates read is deliberately NOT narrowed. Email 1's body is shown
 * to the writer in full and may name something from another finding; a narrower corpus
 * would reject a follow-up for repeating what Email 1 itself said.
 */
export function candidatesForThread(
  candidates: ObservationCandidate[],
  selectedCandidateId: string | null | undefined,
  supportingCandidateId: string | null | undefined,
): ObservationCandidate[] {
  if (!selectedCandidateId) return candidates
  const selected = candidates.find(c => c.id === selectedCandidateId)
  if (!selected) return candidates
  const supporting = supportingCandidateId && supportingCandidateId !== selectedCandidateId
    ? candidates.find(c => c.id === supportingCandidateId)
    : undefined
  return supporting ? [selected, supporting] : [selected]
}

/**
 * The evidence the Email 1 fact-check reads: the findings, plus the client's approved reason
 * as one more numbered line when there is one.
 *
 * ─── WHY THE APPROVED REASON IS IN THE FACT-CHECK'S EVIDENCE ─────────────────
 *
 * The fact-check asks whether each thing the email says is carried by a finding. Since
 * 2026-10-01 the second line IS the client's approved reason, restated about the event, and
 * no finding about one prospect can carry a general statement about firms. So the verifier
 * rejected the very sentence the rule asks for. Measured on the second trial of that rule:
 * "A big project starting means a firm will soon need the next one lined up", the approved
 * reason almost word for word, was rejected as unsupported, and so were two others.
 *
 * It is approved, so it is given as what it is: a numbered line the verifier may cite,
 * labelled as a general statement and NOT a finding about this reader. A second line that
 * goes beyond it ("three managers in one year") still has to find its support in the real
 * findings, and still fails when it cannot.
 *
 * ONLY THE FACT-CHECK READS THIS. The writer's own gates read buildFindingsEvidence, where a
 * name or a number must trace to something research actually found.
 */
export function evidenceWithApprovedReason(candidates: ObservationCandidate[], approvedReason: string | null): string {
  const evidence = buildFindingsEvidence(candidates)
  if (!approvedReason) return evidence
  return (
    `${evidence}
${candidates.length + 1}. A general statement, approved in advance. It is true of firms ` +
    `in general and is NOT a finding about this reader: ${approvedReason}
` +
    '   source: approved in advance | not research about this reader'
  )
}

/** Read the organisation's name, used as the client name the writer is briefed with. */
export async function loadClientName(
  supabase: SupabaseClient,
  client_id: string,
): Promise<string> {
  const { data: org } = await supabase
    .from('organisations').select('name').eq('id', client_id).single()
  return (org?.name as string | null) ?? 'the client'
}

export async function produceOpening({
  apiKey,
  clientName,
  ctx,
  candidates,
  selectedCandidateId,
  relevanceReason,
  selectionReason,
  prospectReason,
  supportingCandidateId,
  messagingContent,
  variantId,
  icpBuyerTitle,
  positioningText,
  triggers,
  needMatchMode = 'report',
  uniqueness,
  onAttempt,
  writeFollowupEmails = false,
}: ProduceOpeningInput): Promise<OpeningWithFollowups> {
  // THE DO-NOT-WRITE VERDICT HAS A READER, AND THIS IS IT. Added 2026-09-11.
  //
  // When synthesis's selection rule finds nothing that clears even SPECIFIC + VERIFIABLE +
  // RELEVANT, the writer has no finding it may build on. Until now it ran anyway: on the
  // pinned 41, four of the five prospects with that verdict got a personalised opening, and
  // an opening written from material synthesis rejected is where a sentence names a thing
  // there is no fact for.
  //
  // HERE, because every research path converges on this function: the inline agent, phase 2
  // of the batch path, and the export. One check, one place, the same verdict everywhere.
  //
  // WHAT HAPPENS INSTEAD IS DECIDED BY WHAT IS RETURNED, and only that: the not-written
  // result below, which every caller already stores as it stores an opening that lost, so
  // the approved template ships. Holding the prospect for review, or excluding it from the
  // batch, are separate decisions and neither is taken here.
  if (!hasUsableCandidate(candidates)) {
    logger.info('research/produce-opening: not written, synthesis found no usable candidate', {
      prospect_id: ctx.id,
      variant_id: variantId,
      candidate_count: candidates.length,
    })
    return notWrittenOpening('no_usable_candidate', NO_USABLE_CANDIDATE_REASON)
  }

  // ═══ THE OPENING ARGUES FROM THE CLIENT'S APPROVED REASON, OR IS NOT WRITTEN ═══
  //
  // Operator note 5, 2026-10-01. HERE, for the reason the check above is here: every
  // research path converges on this function, so the rule is applied once, in one place,
  // and the inline agent, phase 2 of the batch path and the export cannot disagree about it.
  //
  // BEFORE the frame is read and before anything is paid for: a prospect held here costs
  // nothing more than the research that found it had no approved reason.
  const approved = resolveApprovedReason(candidates, selectedCandidateId, triggers)
  if (holdsPersonalisation(approved)) {
    logger.info('research/produce-opening: not written, the selected fact has no approved reason behind it', {
      prospect_id: ctx.id,
      variant_id: variantId,
      state: approved.state,
      selected_candidate_id: selectedCandidateId ?? null,
    })
    return { ...notWrittenOpening('no_approved_reason', NO_APPROVED_REASON_REASON), approved_reason: approved }
  }
  if (approved.state === 'not_checked') {
    // WARN, because this is the rule NOT being applied, and that has to be visible. It is
    // the state every client is in whose ICP predates the reason field.
    logger.warn('research/produce-opening: no approved trigger reason to hold the opening to', {
      prospect_id: ctx.id, why: approved.why,
    })
  }
  // THE REASON THE WRITER AND THE FOLLOW-UPS ARGUE FROM. The approved sentence, verbatim,
  // wherever there is one. Synthesis's own sentence for this prospect is no longer the
  // target: it is a paraphrase the client never saw, and it is where the drift from "what
  // the event points to" to "what the reader must now do" came from.
  // Where the rule is not applied the value passes through untouched, undefined included: an
  // unset field must arrive as unset, not as a different value wearing its name.
  const reasonForWriter = reasonTheWritersArgueFrom(approved, prospectReason)
  const approvedReasonText = approved.state === 'approved' ? approved.reason : null

  const frame = getVariantEmail1Frame(messagingContent, variantId)

  // THE ONE PLACE THE PRECEDENCE IS DECIDED. Both research paths converge here, so
  // resolving it at either call site would be the two-implementations-that-must-agree
  // shape, and a drift between them would show up as different copy rather than as an
  // error. The writer and the judge are then handed the same resolved string, which is
  // what stops the personalisation layer being graded against a different reader than
  // it was written for.
  const buyer = resolveBuyer(ctx.job_title, icpBuyerTitle)

  // LOGGED AT EVERY CALL, so an email that reads wrong can be traced to the input that
  // caused it rather than argued about. The source matters more than the value: a
  // description that came from the ICP is a statement about the client's whole audience,
  // and one that came from the prospect row is a statement about this person only.
  logger.info('research/produce-opening: buyer resolved', {
    prospect_id: ctx.id,
    variant_id: variantId,
    buyer_source: buyer.source,
    buyer_description: buyer.description,
  })

  // ═══ THE VERIFIERS' TOKENS, COUNTED. Added 2026-09-30. ═══
  //
  // The factCheck closure returns `string[]`, the failures and nothing else, so both paid
  // calls inside it had their usage computed, returned and dropped. `opening.usage` is what
  // every cost figure in this project is built from, so for every Email 1 attempt that got
  // past the deterministic gates, ONE Sonnet call (and since the need-match check, up to
  // TWO) was billed by Anthropic and counted by nothing here.
  //
  // WHY IT MATTERS NOW RATHER THAN IN GENERAL: the A/B runs under a hard dollar cap, and a
  // cap enforced against a number missing two of the calls it is capping is not a cap.
  //
  // THIS MOVES EVERY COST FIGURE UP FOR THE SAME WORK. That is the correct number, not a
  // regression, and it is said out loud here because the step will otherwise be read as one.
  let verifierUsage: TokenUsage = ZERO_TOKEN_USAGE

  const writerResult = await writeAndJudgeOpening({
    apiKey,
    clientName,
    buyer: buyer.description,
    prospectFirstName: ctx.first_name,
    // For the capacity gate's blocking subset. A claim naming the firm rather than the
    // reader does not block without it, and both stored examples are that shape.
    prospectCompanyName: ctx.company_name ?? null,
    candidates,
    selectedCandidateId,
    relevanceReason,
    // ═══ THE THREE FIELDS THAT NEVER REACHED EMAIL 1'S WRITER UNTIL 2026-09-24 ═══
    //
    // selectionReason has been declared on WriteAndJudgeParams since 2026-09-23 and was
    // never passed here, so it was `undefined` in production for its whole life. The other
    // two shipped the same way one day later, in the commit whose entire purpose was to put
    // the reason in front of this writer.
    //
    // WHY NOTHING FAILED. All three are optional on WriteAndJudgeParams, so tsc is silent;
    // the assignment block's REASON section is built with `?? null` and then `?.trim()`, so
    // an absent value renders as an empty string rather than throwing; and the tests cover
    // the two ENDS of the hop, the writerInputFromSynthesis mapping and the prompt text,
    // and nothing covered the hop itself. That is this project's "half-tests cannot see a
    // join" exactly: both ends green, the join missing.
    //
    // It was an active regression, not just a gap: the same commit REPLACED the writer's
    // only other target instruction, so the prompt told the model to read a block section
    // that was never emitted, while emails 2 and 3 argued from a reason Email 1 never saw.
    selectionReason,
    prospectReason: reasonForWriter,
    reasonIsApproved: approvedReasonText !== null,
    supportingCandidateId,
    p3: frame.p3,
    // frame.cta is deliberately NOT passed. See WriteAndJudgeParams.
    // The version the written opening has to beat: the variant's own approved opener.
    templateOpening: frame.authoredOpening,
    // The judge must read the real artifact, so this calls the exact production path.
    // first_name resolved so the judge reads exactly what the prospect receives.
    // question omitted keeps the variant's approved CTA, which is how the template side
    // of the comparison stays a complete, genuinely sendable email.
    //
    // RENDERED WITH ITS SUBJECT LINE, not as a bare body. The reader of this string is a
    // model being asked to judge a finished email, and an email without a subject is not
    // one. `subject` omitted keeps the variant's authored subject, so the template side of
    // the comparison stays complete too.
    composeEmail1: (text: string, question?: string | null, subject?: string | null) => {
      const email1 = composeEmail1WithOpening(
        messagingContent, variantId, text, question ?? null, ctx.first_name, subject ?? null,
      )
      return `Subject: ${email1.subject_line ?? ''}\n\n${email1.body}`
    },
    prospectId: ctx.id,
    uniqueness,
    onAttempt,
    // ═══ EMAIL 1'S FACT-CHECK, WIRED HERE BECAUSE THIS IS WHERE THE CORPUS LIVES ═══
    //
    // Injected as a closure rather than imported inside the writer, for the reason the
    // parameter's doc gives: the key and the findings belong to the caller, and a writer
    // test must be able to run the whole attempt loop offline.
    //
    // THE SAME CORPUS THE WRITER READ, built from the same `candidates` array. Rebuilding
    // it from a different source would be a second corpus that could disagree with the
    // first, and a citation check against a list nobody saw checks nothing.
    factCheck: async ({ bridge, question }) => {
      if (!bridge.trim() && !question.trim()) return []
      const fc = await factCheckOpening({
        apiKey,
        bridge,
        question,
        // WITH THE APPROVED REASON AS ONE MORE NUMBERED LINE, where there is one. See
        // evidenceWithApprovedReason. Only this verifier reads the longer list.
        findingsEvidence: evidenceWithApprovedReason(candidates, approvedReasonText),
        prospectId: ctx.id,
        companyName: ctx.company_name ?? null,
      })
      verifierUsage = addTokenUsage(verifierUsage, fc.usage)

      // ═══ THE NEED-MATCH CHECK, SECOND, AND ONLY ON COPY THE FIRST ONE ACCEPTED ═══
      //
      // TWO DIFFERENT QUESTIONS, ONE BEHIND THE OTHER. The fact-check asks whether a claim
      // about the PROSPECT is carried by the findings: the left-hand side of the bridge.
      // This asks whether the NEED the sentence points at is work the client actually does:
      // the right-hand side. A sentence can pass the first and fail the second, which is
      // how a closing question came to offer work nobody sells.
      //
      // ORDER IS COST, the same rule write-followups.ts applies to its own fact-check. An
      // attempt the first check rejected is going to be rewritten whatever this says, so
      // paying a second Sonnet call to describe it buys nothing. Returning early is
      // therefore the cheap branch AND the correct one, and they cannot drift apart.
      if (fc.failures.length > 0) return fc.failures

      // ═══ THE REASON CHECK: THE SECOND LINE SAYS WHAT THE APPROVED REASON SAYS ═══
      //
      // AFTER the fact-check, for the cost rule stated above: a line the fact-check
      // rejected is about to be rewritten, and reading it against the reason buys nothing.
      // BEFORE the need-match check, because that one only reports and this one blocks: a
      // rejection here ends the attempt and the need-match call is not paid for.
      //
      // ONLY WHERE THERE IS AN APPROVED REASON. The not_checked state has nothing to hold
      // the line to. See reason-match.ts for what is asked and what code verifies.
      if (approvedReasonText !== null && bridge.trim()) {
        const match = await checkBridgeStatesReason({
          apiKey, approvedReason: approvedReasonText, bridge, prospectId: ctx.id,
        })
        verifierUsage = addTokenUsage(verifierUsage, match.usage)
        if (match.failures.length > 0) return match.failures
      }

      // NO DOCUMENT, NO CHECK. Not a silent pass dressed as one: without the client's
      // positioning document there is nothing to check a need against, and a verifier
      // guessing at what the service does is worse than no verifier.
      if (!positioningText) return []

      const needs = await checkNeedMatchesOffer({
        apiKey,
        positioningText,

        // The bridge and the question, labelled as the fact-check labels them, and nothing
        // else. The observation is a finding quoted back and names no need; the offer line
        // is fixed template text the writer never sees and is the client's own words.
        sections: [
          { id: 1, heading: 'Email 1, the paragraph that gives the reason to reply', text: bridge },
          { id: 1, heading: 'Email 1, the closing question', text: question },
        ],
        shown: 'one email',
        labelOf: () => 'Email 1',
        prospectId: ctx.id,
      })
      verifierUsage = addTokenUsage(verifierUsage, needs.usage)

      // REPORT OR BLOCK, decided by the caller. The check ran either way and the verdict is
      // already in the log line checkNeedMatchesOffer writes; what the mode decides is
      // whether the writer is told. Returning [] here is the whole of "report only".
      if (needMatchMode === 'report') {
        if (needs.failures.length > 0) {
          logger.info('research/produce-opening: need-match would have rejected, reporting only', {
            prospect_id: ctx.id,
            mode: 'report',
            failures: needs.failures,
          })
        }
        return []
      }
      return needs.failures
    },
  })

  // Folded once, here, so every return below carries it and none can forget to. AFTER the
  // writer has returned, because the closure runs inside it and verifierUsage is only
  // populated by then.
  // approved_reason travels on the result, and from there into prospects.trigger_data.judge,
  // so what the opening was held to can be read back per prospect without re-running anything.
  const opening = { ...writerResult, usage: addTokenUsage(writerResult.usage, verifierUsage), approved_reason: approved }

  // ═══════════════════════════════════════════════════════════════════════════
  // EMAILS 2 AND 3, IN THEIR OWN CALL, AFTER EMAIL 1 IS FINISHED
  //
  // EVERYTHING ABOVE THIS LINE IS UNCHANGED FROM MAIN. writeAndJudgeOpening has already
  // returned; it was given no follow-up parameter and write-opening.ts is byte-identical
  // to main in this branch. So Email 1's prompt, parser, gates, attempts, token ceiling
  // and judge cannot be affected by anything below, and the positive control for that is
  // a `diff` of one file returning nothing rather than an argument about which changes
  // were safe.
  //
  // THE FIRST VERSION OF THIS FEATURE DID NOT HAVE THAT PROPERTY. It asked the Email 1
  // writer for the follow-ups in the same response, and Email 1's gate failures went from
  // 23 to 66 with offer_line_echo appearing 19 times from a control of 0, because Email
  // 2's job (explain the mechanism) contradicts Email 1's rules (never name the service)
  // and the framing bled upward. See the header of write-followups.ts.
  //
  // ═══ THE COHERENCE RULE: ONE CONDITION, READ ONCE ═══
  //
  // `opening.written_won` is false on all five fallback paths inside the writer and on the
  // sixth above, and every one of them means THE APPROVED TEMPLATE EMAIL 1 SHIPS. So the
  // follow-up call is not made at all in those cases, and the fields are EMPTY_FOLLOWUP.
  //
  // This is stronger than gating the STORAGE of a follow-up, because there is no generated
  // follow-up in existence to mis-store: a callback pointing at an observation the
  // prospect never received cannot be written, let alone shipped. The condition is also
  // the same expression that decides whether the call is worth paying for, so the correct
  // behaviour and the cheap behaviour are the same branch and cannot drift apart.
  if (!writeFollowupEmails || !opening.written_won || opening.opening === null) {
    return { ...opening, email2: EMPTY_FOLLOWUP, email3: EMPTY_FOLLOWUP, followup_usage: null, followup_attempts: [], followup_email1_fingerprint: null }
  }

  const reference = buildFollowupsFor(messagingContent, variantId, ctx.company_name ?? null)
  if (reference === null) {
    logger.info('research/produce-opening: no usable follow-up reference, template follow-ups ship', {
      prospect_id: ctx.id, variant_id: variantId,
    })
    return { ...opening, email2: EMPTY_FOLLOWUP, email3: EMPTY_FOLLOWUP, followup_usage: null, followup_attempts: [], followup_email1_fingerprint: null }
  }

  // THE EMAIL 1 THAT ACTUALLY SHIPS, rendered by the production composer with the written
  // opening, the written question and the written subject all applied. The callback has to
  // point at what was really sent, and this is the only place those three exist together
  // in their final wording.
  const email1Body = composeEmail1WithOpening(
    messagingContent, variantId, opening.opening, opening.question, ctx.first_name, opening.subject,
  ).body

  // ═══ THE FINGERPRINT IS TAKEN WITH THE MERGE TAG UNRESOLVED, AND IT MATTERS ═══
  //
  // The writer above is given the body with {{first_name}} already replaced, because it is
  // being asked to read the email as the prospect will. Composition does NOT resolve the
  // tag: composedToVariables does that at upload, after composeSequence has finished.
  //
  // So the two strings differ by exactly the prospect's first name, and fingerprinting the
  // resolved one would mismatch on EVERY prospect at composition. The follow-ups would be
  // discarded 100% of the time, the template would ship, and nothing would look broken:
  // the feature would simply never fire, and the fingerprint would be blamed for working.
  //
  // A prospect's first name is also not what this guard is about. The question is whether
  // EMAIL 1 CHANGED, and the tag is the one part of the body that is identical in both
  // versions of it. Composing a second time costs nothing: it is a pure function of values
  // already in hand.
  const email1BodyForFingerprint = composeEmail1WithOpening(
    messagingContent, variantId, opening.opening, opening.question, undefined, opening.subject,
  ).body

  // ═══ A FAILED FOLLOW-UP CALL COSTS THE FOLLOW-UPS, NEVER THE RESEARCH ═══
  //
  // writeFollowups rethrows any API error. Email 1 has already won by this point, and the
  // callers store the research AFTER this function returns: on the full-price route a
  // throw here discarded the sources, the synthesis and the winning Email 1, with no row
  // left for a re-run to reuse. A spent balance still aborts the run (FatalApiError); any
  // other failure returns the opening with no follow-ups, the run is stored, and the
  // prospect is held at upload until the backfill writes one. On the batch path the job
  // used to fail and its retry rewrote everything; it now completes, and the backfill
  // owes that prospect its follow-ups.
  let followups: Awaited<ReturnType<typeof writeFollowups>>
  try {
    followups = await writeFollowups({
    apiKey,
    clientName,
    buyer: buyer.description,
    // The name the gate refuses to see in the prose. THE SAME VALUE that was substituted
    // into the email 1 body above, which is where the writer learns it.
    prospectFirstName: ctx.first_name ?? null,
    email1Body,
    offerLine: frame.p3,
    // ONLY THE FINDING EMAIL 1 OPENED ON, and its supporting event. See candidatesForThread.
    findings: buildFindingsBlock(candidatesForThread(candidates, selectedCandidateId, supportingCandidateId), {
      selectedCandidateId: selectedCandidateId ?? null,
      relevanceReason: relevanceReason ?? null,
      selectionReason: selectionReason ?? null,
    }),
    // THE SAME FACT, THE SAME SUPPORTING EVENT AND THE SAME REASON THE WRITER HAD. All four
    // emails then argue one thing. Before this, emails 2 and 3 were written from the
    // findings block alone and were free to pick a different angle from Email 1, which is
    // how a sequence ends up making four separate cases to one reader.
    // The approved reason where there is one: the same sentence Email 1 was held to.
    prospectReason: reasonForWriter ?? null,
    supportingEvent: supportingCandidateId
      ? candidates.find(c => c.id === supportingCandidateId)?.observation ?? null
      : null,
    findingsEvidence: buildFindingsEvidence(candidates),
    // The same list the year-count gate checks Email 1 against, so a duration legal there
    // is legal here and the two cannot demand different numbers.
    datedCandidates: candidates,
    // `now` omitted so writeFollowups takes the real run clock. produceOpening carries no
    // clock of its own, and inventing one here would be a second source of "today" beside
    // the one Email 1's gate uses, which is the shape that produced the wrong figures.
    reference,
    // THE SAME DOCUMENT EMAIL 1 WAS CHECKED AGAINST, so a need legal in Email 1 is legal in
    // its follow-ups and the two cannot demand different things. Undefined turns the check
    // off there exactly as it does above.
    positioningText,
    // AND THE SAME MODE. An arm that blocked Email 1 and only reported on its follow-ups
    // would be measuring two different rules in one number.
    needMatchMode,
    prospectId: ctx.id,
    })
  } catch (err) {
    if (err instanceof FatalApiError) throw err
    logger.warn('research/produce-opening: the follow-up call failed; the opening is kept and no follow-up is stored', {
      prospect_id: ctx.id, variant_id: variantId, error: err instanceof Error ? err.message : String(err),
    })
    return { ...opening, email2: EMPTY_FOLLOWUP, email3: EMPTY_FOLLOWUP, followup_usage: null, followup_attempts: [], followup_email1_fingerprint: null }
  }

  return {
    ...opening,
    email2: followups.email2,
    email3: followups.email3,
    followup_usage: followups.usage,
    followup_attempts: followups.attempts,
    // Hashed from the SAME string the writer was given, above. Null when nothing shipped,
    // so a fingerprint never outlives the copy it describes.
    followup_email1_fingerprint:
      // EITHER email shipping means a personalised follow-up exists that was written against
      // this Email 1, so the fingerprint is owed. Keyed on email 2 alone, a prospect whose
      // email 3 shipped and whose email 2 did not would carry personalised copy with no
      // record of the Email 1 it was written for.
      followups.email2.prose !== null || followups.email3.prose !== null
        ? fingerprintEmail1(email1BodyForFingerprint) : null,
  }
}
