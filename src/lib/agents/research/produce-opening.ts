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
import { writeAndJudgeOpening, buildFindingsBlock, buildFindingsEvidence, type OpeningResult, type AttemptObservation, type NotWrittenReason } from './write-opening'
import { writeFollowups, type FollowupResult } from './write-followups'
import { fingerprintEmail1 } from '@/lib/composition/followup-assignment'
import {
  buildFollowupReference,
  EMPTY_FOLLOWUP,
  type FollowupReference,
  type FollowupOutcome,
} from './followup-frame'
import { resolveBuyer } from './resolve-buyer'
import { logger } from '@/lib/logger'
import type { BatchUniquenessRegistry } from '@/lib/agents/research/batch-uniqueness'
import { ZERO_TOKEN_USAGE, type ProspectContext, type ObservationCandidate } from './types'
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
   * DEFAULTS TO FALSE AND NEITHER PRODUCTION CALLER PASSES IT. The inline agent and phase
   * 2 of the batch path both call produceOpening without it, so the feature is off in
   * production by virtue of the call sites rather than by a constant someone could edit.
   * The export script is the only caller that passes true.
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
}

/**
 * Build the tone-and-length reference for emails 2 and 3 from the client's own approved
 * messaging document.
 *
 * RETURNS NULL RATHER THAN A PARTIAL REFERENCE. If either follow-up is missing from the
 * variant, or either has no recognisable frame, or either strips down to nothing, the
 * feature declines for this prospect and the template follow-ups ship. A half-reference
 * would leave the writer inferring one email's register from the other's, which is a
 * quieter failure than not running at all.
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

  const reference2 = buildFollowupReference(templateBody2)
  const reference3 = buildFollowupReference(templateBody3)
  if (!reference2 || !reference3) return null

  return { reference2, reference3, templateBody2, templateBody3, companyName }
}

/**
 * The judge_reasoning a prospect carries when the writer was not run because synthesis found
 * no usable candidate. EXPORTED so the export and any report can count these by value rather
 * than by matching prose.
 */
export const NO_USABLE_CANDIDATE_REASON =
  'Not written: synthesis found no usable candidate for this prospect, so the approved template ships.'

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
 * Read from the prospect row when composition has already assigned one, otherwise
 * resolved with the same deterministic hash composition uses, so the writer targets the
 * variant that will actually ship. Nothing is written back: assignment stays
 * composition's job.
 */
export function resolveVariantId(
  prospectId: string,
  assignedVariantId: string | null,
  messagingContent: MessagingContent,
): string {
  const availableVariants = messagingContent.variants
    ? Object.keys(messagingContent.variants).sort()
    : ['A', 'B', 'C', 'D']
  return assignedVariantId ?? assignVariantDeterministically(prospectId, availableVariants)
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

  const opening = await writeAndJudgeOpening({
    apiKey,
    clientName,
    buyer: buyer.description,
    prospectFirstName: ctx.first_name,
    candidates,
    selectedCandidateId,
    relevanceReason,
    p3: frame.p3,
    cta: frame.cta,
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
  })

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

  const followups = await writeFollowups({
    apiKey,
    clientName,
    buyer: buyer.description,
    email1Body,
    offerLine: frame.p3,
    findings: buildFindingsBlock(candidates, {
      selectedCandidateId: selectedCandidateId ?? null,
      relevanceReason: relevanceReason ?? null,
      selectionReason: selectionReason ?? null,
    }),
    // THE SAME FACT, THE SAME SUPPORTING EVENT AND THE SAME REASON THE WRITER HAD. All four
    // emails then argue one thing. Before this, emails 2 and 3 were written from the
    // findings block alone and were free to pick a different angle from Email 1, which is
    // how a sequence ends up making four separate cases to one reader.
    prospectReason: prospectReason ?? null,
    supportingEvent: supportingCandidateId
      ? candidates.find(c => c.id === supportingCandidateId)?.observation ?? null
      : null,
    findingsEvidence: buildFindingsEvidence(candidates),
    reference,
    prospectId: ctx.id,
  })

  return {
    ...opening,
    email2: followups.email2,
    email3: followups.email3,
    followup_usage: followups.usage,
    followup_attempts: followups.attempts,
    // Hashed from the SAME string the writer was given, above. Null when nothing shipped,
    // so a fingerprint never outlives the copy it describes.
    followup_email1_fingerprint:
      followups.email2.prose !== null ? fingerprintEmail1(email1BodyForFingerprint) : null,
  }
}
