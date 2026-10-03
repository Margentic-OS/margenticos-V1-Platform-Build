// Write emails 2 and 3 for prospects that already hold a personalised Email 1.
//
//   npx tsx --env-file=.env.local scripts/backfill-followups.ts --dry-run
//   npx tsx --env-file=.env.local scripts/backfill-followups.ts --commit
//   npx tsx --env-file=.env.local scripts/backfill-followups.ts --commit --limit=10
//   npx tsx --env-file=.env.local scripts/backfill-followups.ts --commit --max-usd=1.50
//
// EVERY FLAG THAT TAKES A VALUE IS WRITTEN --name=value, WITH AN EQUALS SIGN. --org, --ids,
// --limit, --after and --max-usd. Written with a space instead, the script refuses to
// start and prints the form to use. Until 2026-10-02 it did not refuse: `--limit 10`
// matched nothing, so it meant NO limit, and a command that looked bounded would run the
// writer, and pay for it, across the whole cohort.
//
// --max-usd=<n> is the most this run may spend, in US dollars. 3 when it is left off. The
// run stops before a prospect the cap could not cover, and prints the --after value to
// carry on from, as it does for --limit. Dry runs are paid, so it applies to them too.
//
// --limit=<n> is a whole number greater than zero. Anything else is refused: "abc" and "0"
// each used to mean NO limit, the same fault as the space above.
//
// --limit bounds how many prospects the WRITER IS RUN FOR, not how many are looked at. A
// prospect skipped before any model call (already carried, or cannot be written for) does
// not use it up, so the same command run again reaches the next ones.
// --after=<id> starts after that prospect id (the cohort is read in id order). A prospect
// whose follow-ups are rejected every time stays in the cohort and is paid for on every
// run; when a limit is reached the script prints the --after value that steps past the
// ones it has just looked at.
//
// WHO IT REACHES (widened 2026-10-01, operator note 4). Every not-yet-uploaded prospect
// with a personalised Email 1 whose follow-ups do not carry it: none stored, one stored, or
// BOTH stored against an Email 1 that has since changed. The last group is new. Approving a
// new messaging document changes the offer line under every personalised opening, which
// retires every stored follow-up at once, and the upload now HOLDS a personalised prospect
// with no follow-up carrying its thread (src/lib/composition/thread-carried.ts). Before
// this, the cohort skipped any prospect holding both columns, so nothing could repair them.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
//
// The follow-up call runs inside the research path, so it reaches prospects researched
// FROM NOW ON. Prospects whose research already ran hold a personalised Email 1 and no
// follow-ups, and re-running research to reach them would re-buy Apify, Apollo, the
// website fetch, web search and synthesis, at roughly twenty times the cost of the two
// calls actually needed, and would REPLACE the Email 1 copy that is being held precisely
// because it is good.
//
// So this reproduces only the paid half that is missing: the follow-up call, against the
// stored Email 1 exactly as it will ship.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE SEQUENCING PROBLEM, WHICH IS THE REASON THIS SCRIPT IS CAREFUL
//
// Another session re-runs Email 1 for these same prospects to fix copy faults. A follow-up
// opens with a callback to a specific observation; under a DIFFERENT Email 1 that callback
// points at something the prospect never read. Nothing would error, the word counts would
// be right, and the only person who notices is the recipient.
//
// TWO INDEPENDENT MECHANISMS, because a single one would be a race:
//
// 1. THIS SCRIPT RECORDS WHAT IT WROTE AGAINST. followup_email1_fingerprint is the sha256
//    of the composed Email 1 body at the moment the follow-ups were written.
//
// 2. COMPOSITION RE-CHECKS IT AT SEND TIME. followupsMatchEmail1 recomputes the hash from
//    the email it is about to send and discards the follow-ups on any mismatch, shipping
//    the approved template ones instead.
//
// The second is what makes this safe to run BEFORE the other session finishes. If Email 1
// changes afterwards, the follow-ups retire themselves; they are never shipped against the
// wrong Email 1. Re-running this script then regenerates them at ~$0.008 each.
//
// It also needs no coordination: the other session does not have to know this feature
// exists. Its write changes the trigger, the hash stops matching, and the guard fires.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IT WRITES, AND THE ONE THING IT MUST NOT TOUCH
//
// Writes exactly three columns, and only on prospects that already satisfy the coherence
// rule: followup_email2, followup_email3, followup_email1_fingerprint.
//
// It NEVER writes personalisation_trigger, personalisation_question or
// personalisation_subject. Those are the Email 1 the other session is fixing, and this
// script's whole purpose is to leave them alone. The update below names three columns and
// there is no code path that names a fourth.
//
// ═════════════════════════════════════════════════════════════════════════════
// DRY RUN IS THE DEFAULT, AND --commit IS THE ONLY WAY TO WRITE
//
// Without --commit it resolves the cohort, composes each Email 1, makes the model calls and
// prints what it would store, and writes nothing. The model calls are PAID either way:
// what --commit controls is the database write, not the spend.

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildFollowupsFor, candidatesForThread } from '@/lib/agents/research/produce-opening'
import type { TriggerWithReason } from '@/lib/agents/research/approved-reason'
import { loadTriggersChecked, openingReasonVerdict } from '@/lib/composition/opening-reason'
import { writeFollowups } from '@/lib/agents/research/write-followups'
import { buildFindingsBlock, buildFindingsEvidence } from '@/lib/agents/research/write-opening'
import { loadStoredFindings, stripNulls } from '@/lib/agents/prospect-research-agent-v2'
import { writerInputForStored, usdForUsage } from './export-writer-run'
import { loadClientContext } from '@/lib/agents/research/synthesize'
import { resolveBuyer } from '@/lib/agents/research/resolve-buyer'
import {
  fetchApprovedMessagingDoc,
  composeEmail1WithOpening,
  getVariantEmail1Frame,
  type MessagingContent,
} from '@/lib/composition/compose-sequence'
import { resolveVariantId, loadClientName } from '@/lib/agents/research/produce-opening'
import { fingerprintEmail1, assignFollowupArm } from '@/lib/composition/followup-assignment'
import type { ProspectContext } from '@/lib/agents/research/types'
import { companyFactsFromRow } from '@/lib/agents/research/company-facts'
import { RunSpend, parseCapUsd, parseLimit, valueFlagProblems } from '@/lib/operator/run-spend'

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

/**
 * The cohort. Every condition here is load-bearing:
 *
 *   personalisation_trigger not null   the personalised Email 1 WON. This is the coherence
 *                                      rule at the source: a follow-up may only exist where
 *                                      the personalised Email 1 ships.
 *   current_research_result_id not null  findings are stored, so no research is re-bought.
 *   outbound_upload_status = 'pending'   NOT YET UPLOADED. Anything already uploaded is
 *                                      mid-sequence at the provider and our gates govern
 *                                      upload, not delivery (ADR-034): writing follow-ups
 *                                      for it would change nothing and record a claim about
 *                                      copy the provider has already sent.
 *   not suppressed                     never mail a suppressed prospect.
 *   (follow-up columns)                NOT filtered here. A prospect whose stored
 *                                      follow-ups still match its Email 1 is skipped in the
 *                                      loop, before any model call, so a re-run stays cheap
 *                                      and idempotent.
 */
/**
 * `ids` NARROWS THE COHORT TO A NAMED SET, and it exists because --limit cannot.
 *
 * ADDED 2026-09-23. --limit takes the first N by id order, which is an arbitrary slice,
 * so there was no way to run this for a SPECIFIC group of prospects. A session that had
 * just re-run Email 1 for 13 prospects had two options: write follow-ups for all 57 in
 * the organisation, or none.
 *
 * That is the sequencing hazard this file's own header describes, in the one direction it
 * did not guard: a follow-up composed against an Email 1 that a DIFFERENT run has since
 * replaced opens with a callback to something the prospect never read. Nothing errors and
 * the word counts are fine. Naming the prospects is how a caller says "these, whose
 * Email 1 I just wrote and am holding".
 *
 * The other filters still apply on top, so an id that is suppressed or already uploaded is
 * still excluded. One whose follow-ups were written against today's Email 1 is skipped
 * before any model call; one whose follow-ups have gone stale is in the cohort and has them
 * replaced. This narrows the cohort; it never widens it.
 */
/**
 * The columns followupsForStoredEmail1 reads from a prospect row. ONE LIST, exported,
 * because the reading report reads the same row for the same function and a second copy
 * of this string would drift. `opening_judge` is the record of the writer run that
 * produced Email 1 (prospects.trigger_data.judge): the second line it wrote, and what that
 * line was held to.
 */
export const STORED_EMAIL1_COLUMNS =
  'id, organisation_id, segment_id, variant_id, first_name, last_name, company_name, country, role, job_title, email, linkedin_url, website_url, personalisation_trigger, personalisation_question, personalisation_subject, company_headcount, company_industry, apollo_enrichment_data, current_research_result_id, followup_email2, followup_email3, followup_email1_fingerprint, opening_judge:trigger_data->judge'

async function loadCohort(supabase: SupabaseClient, orgId: string, ids: string[] | null, after: string | null = null) {
  let q = supabase
    .from('prospects')
    .select(STORED_EMAIL1_COLUMNS)
    .eq('organisation_id', orgId)
    .not('personalisation_trigger', 'is', null)
    .not('current_research_result_id', 'is', null)
    .eq('outbound_upload_status', 'pending')
    // NO FILTER ON THE FOLLOW-UP COLUMNS ANY MORE. It selected on either column being
    // empty, which could not see a prospect whose two stored follow-ups were written
    // against an Email 1 that has since changed. Whether stored copy is still current is
    // only knowable by composing Email 1 and comparing fingerprints, so it is decided per
    // prospect below, before any model call, by followupsAreCurrent.
    .or('suppressed.is.null,suppressed.eq.false')
    .order('id')
  if (ids && ids.length > 0) q = q.in('id', ids)
  if (after) q = q.gt('id', after)
  // NO LIMIT HERE. It used to be applied to the query, and once the cohort stopped
  // filtering on the follow-up columns a second `--limit=10` loaded the same ten ids,
  // found them already carried, and never reached the eleventh. The limit is applied in
  // main(), to the prospects the writer is actually run for.
  const { data, error } = await q
  if (error) throw new Error(`could not load the cohort: ${error.message}`)
  return data ?? []
}

/** The columns of a prospect row this file reads. The cohort select names every one. */
export type StoredEmail1Row = Record<string, unknown> & {
  id: string
  followup_email2?: unknown
  followup_email3?: unknown
  followup_email1_fingerprint?: unknown
  /** prospects.trigger_data.judge: the writer run that produced Email 1. */
  opening_judge?: unknown
}

/**
 * Do BOTH follow-up positions hold copy written against the Email 1 this prospect would
 * receive today? Pure, and decided before any model call.
 *
 * Both, not either: a prospect holding one current follow-up already satisfies the upload's
 * rule, and the other position is still a gap this script exists to fill.
 */
export function followupsAreCurrent(
  row: { followup_email2?: unknown; followup_email3?: unknown; followup_email1_fingerprint?: unknown },
  fingerprint: string,
): boolean {
  return typeof row.followup_email2 === 'string' && row.followup_email2.trim() !== ''
    && typeof row.followup_email3 === 'string' && row.followup_email3.trim() !== ''
    && row.followup_email1_fingerprint === fingerprint
}

/**
 * Why no follow-up was written.
 */
export type FollowupSkipReason =
  | 'template_arm'
  | 'current'
  /** No research row inside the 30-day reuse window. */
  | 'no_stored_findings'
  /** The variant's template follow-ups leave nothing to model the register on. */
  | 'no_reference'
  /** Email 1 was not held to one of the client's approved reasons as they read today. */
  | 'opening_without_approved_reason'

export type FollowupsForStoredEmail1 =
  | {
      status: 'skipped'
      reason: FollowupSkipReason
      /** For opening_without_approved_reason: which way it failed. */
      why?: string
      usd: number
      /** One position already holds copy written against today's Email 1. */
      carriesOne: boolean
    }
  | {
      status: 'ran'
      result: Awaited<ReturnType<typeof writeFollowups>>
      /** Of the Email 1 the follow-ups were written against, merge tag unresolved. */
      fingerprint: string
      /** The research row the findings came from, where the attempts are recorded. */
      storedResultId: string
      usd: number
      carriesOne: boolean
    }

/** Does EITHER position hold copy written against this Email 1? That is the upload's rule. */
export function carriesOneFollowup(
  row: { followup_email2?: unknown; followup_email3?: unknown; followup_email1_fingerprint?: unknown },
  fingerprint: string,
): boolean {
  const holds = (v: unknown) => typeof v === 'string' && v.trim() !== ''
  return row.followup_email1_fingerprint === fingerprint && (holds(row.followup_email2) || holds(row.followup_email3))
}

/**
 * Emails 2 and 3 for ONE prospect whose personalised Email 1 is already written, against
 * the messaging content given. Writes nothing: the caller decides what to store.
 *
 * EXPORTED so the operator's reading file can show a personalised sequence as it would
 * send once this script has run, against a document that is not approved yet. Two callers
 * running one function is what keeps the reading file from showing copy the backfill would
 * not produce.
 */
export async function followupsForStoredEmail1(input: {
  supabase: SupabaseClient
  orgId: string
  row: StoredEmail1Row
  content: MessagingContent
  clientName: string
  apiKey: string
  /** The client's triggers, when the caller has already read them. Read here otherwise. */
  triggers?: ReadonlyArray<TriggerWithReason>
}): Promise<FollowupsForStoredEmail1> {
  const { supabase, orgId, row: p, content, clientName, apiKey } = input
  const id = p.id

  // THE ARM. At GENERATED_ARM_PERCENT = 100 this is every prospect. Read here rather
  // than assumed so that lowering the setting skips the right prospects in the backfill
  // exactly as it does in the research path, from the same function.
  if (assignFollowupArm(id) !== 'generated') return { status: 'skipped', reason: 'template_arm', usd: 0, carriesOne: false }

  // ═══ FIRST, AND FREE: WOULD THE UPLOAD SEND THIS EMAIL 1 AT ALL? ═══
  //
  // A personalised Email 1 is sent only if it was held to one of the client's approved
  // trigger reasons as they read today (opening-reason.ts, the verdict the upload reads).
  // One that was not is held at upload whatever follow-ups it has, so writing them would
  // be paying for copy that cannot ship. Decided BEFORE "already carried", because an
  // opening that already holds a current follow-up is exactly the one that used to slip
  // through: skipped here as carried, passed by the thread rule, sent.
  //
  // The first version of this check lived only here and made a paid model call to read an
  // old second line back against the reason. It is now a comparison of two stored facts.
  const triggers = input.triggers ?? await (async () => {
    const read = await loadTriggersChecked(supabase, orgId, (p.segment_id ?? null) as string | null)
    // A failed read is a failure, never "this client has no approved reasons".
    if (!read.ok) throw new Error(`backfill-followups: ${read.error}`)
    return read.triggers
  })()
  const openingReason = openingReasonVerdict({ tier: 'research', judge: p.opening_judge ?? null, triggers })
  if (!openingReason.ok) return { status: 'skipped', reason: 'opening_without_approved_reason', why: openingReason.why, usd: 0, carriesOne: false }

  // The variant composition WILL assign. Resolved with the same shared function
  // composition uses, so the Email 1 fingerprinted here is the one that ships. These
  // prospects have variant_id NULL because variant assignment happens at composition.
  const variantId = resolveVariantId(id, (p.variant_id ?? null) as string | null, content).variantId

  // ═══ THE STORED EMAIL 1, COMPOSED EXACTLY AS IT WILL SHIP ═══
  //
  // Built from the columns on the row, not from a fresh writer run. That is the whole
  // point: this reaches prospects whose Email 1 is finished and being held.
  //
  // TWO COMPOSITIONS, for the reason produce-opening documents at length: the writer is
  // shown the body with {{first_name}} resolved because it reads the email as the
  // prospect will, and the fingerprint is taken with the tag UNRESOLVED because that is
  // what composition hashes. Fingerprinting the resolved body would mismatch on every
  // prospect and the feature would silently never fire.
  const args = [
    content, variantId,
    p.personalisation_trigger as string,
    (p.personalisation_question ?? null) as string | null,
  ] as const
  const email1Body = composeEmail1WithOpening(
    ...args, (p.first_name ?? null) as string | null, (p.personalisation_subject ?? null) as string | null,
  ).body
  const email1ForFingerprint = composeEmail1WithOpening(
    ...args, undefined, (p.personalisation_subject ?? null) as string | null,
  ).body
  const fingerprint = fingerprintEmail1(email1ForFingerprint)

  // ALREADY CARRIED, decided before anything is paid for. Both positions hold copy written
  // against this exact Email 1, so there is nothing to write.
  if (followupsAreCurrent(p, fingerprint)) return { status: 'skipped', reason: 'current', usd: 0, carriesOne: true }
  // One position already holds copy written against today's Email 1. The upload's thread
  // rule is then already met, so whatever happens below this prospect is NOT held.
  const carriesOne = carriesOneFollowup(p, fingerprint)

  // ═══ THE SAME RESEARCH ROW EMAIL 1 WAS WRITTEN FROM ═══
  //
  // prospects.current_research_result_id is written in the SAME object literal as
  // personalisation_trigger, so it IS the row Email 1 came from. Without the pin this call
  // got whichever row loadStoredFindings scored highest, and measured across the 104 on
  // 2026-09-27 that was a DIFFERENT row for 57 of them: a follow-up arguing from facts its
  // own Email 1 never mentioned, and an audit that judged Email 1 against the follow-up
  // corpus and reported 18 fabrications that were not fabrications.
  const stored = await loadStoredFindings(
    supabase as never, id, orgId, (p.current_research_result_id ?? null) as string | null,
  )
  if (!stored) return { status: 'skipped', reason: 'no_stored_findings', usd: 0, carriesOne }

  const reference = buildFollowupsFor(content, variantId, (p.company_name ?? null) as string | null)
  if (!reference) return { status: 'skipped', reason: 'no_reference', usd: 0, carriesOne }

  const ctx = { ...p, ...companyFactsFromRow(p as never) } as unknown as ProspectContext
  // THE SAME MAPPING THE EXPORT AND THE AGENT USE, imported rather than re-derived, so
  // the findings block this writer reads is the one the Email 1 writer read.
  const writerInput = await writerInputForStored(stored, ctx, orgId)
  const clientCtx = await loadClientContext(orgId, (p.segment_id ?? null) as string | null)
  const buyer = resolveBuyer(ctx.job_title, clientCtx.buyerTitle)

  // A research row written before the Email 1 writer was narrowed may not have the
  // selected fact under its Email 1: until then that writer was shown every candidate and
  // could open on another. For those rows the follow-up writer is shown everything, as
  // this script did before the narrowing. Erring LATE is the safe direction (a narrowed
  // row shown every finding is what the script always did), so the boundary is the hour
  // after the change reached main, not the day it was written.
  const threadIsTheSelectedFact = stored.created_at >= EMAIL1_NARROWED_SINCE
  const threadCandidates = threadIsTheSelectedFact
    ? candidatesForThread(writerInput.candidates, writerInput.selectedCandidateId, writerInput.supportingCandidateId)
    : writerInput.candidates

  const result = await writeFollowups({
    apiKey,
    clientName,
    buyer: buyer.description,
    // Same value composed into email1Body above, which is where the writer reads the name
    // it must not reuse.
    prospectFirstName: (p.first_name ?? null) as string | null,
    email1Body,
    // The variant's approved offer line, for the narrow echo gate. Read from the same
    // frame composition reads, so the gate sees the line the prospect actually got.
    offerLine: getVariantEmail1Frame(content, variantId).p3,
    // ONLY THE FINDING EMAIL 1 OPENED ON, and its supporting event: the same narrowing, by
    // the same function, the research path applies. A backfilled follow-up that could open
    // on a different fact would not carry Email 1's thread, which is what it is for.
    findings: buildFindingsBlock(
      threadCandidates,
      {
        selectedCandidateId: writerInput.selectedCandidateId ?? null,
        relevanceReason: writerInput.relevanceReason ?? null,
        selectionReason: writerInput.selectionReason ?? null,
      },
    ),
    // THE REASON EMAIL 1 WAS HELD TO, which the verdict above has just confirmed is still
    // one of the client's approved reasons. The stored paraphrase only for a client with no
    // approved reasons at all, which is what the research path hands its own writer.
    prospectReason: openingReason.why === 'held_to_a_current_reason' ? openingReason.reason : (writerInput.prospectReason ?? null),
    supportingEvent: writerInput.supportingCandidateId
      ? writerInput.candidates.find(c => c.id === writerInput.supportingCandidateId)?.observation ?? null
      : null,
    findingsEvidence: buildFindingsEvidence(writerInput.candidates),
    // Same list the year-count gate checks Email 1 against.
    datedCandidates: writerInput.candidates,
    reference,
    prospectId: id,
  })

  return { status: 'ran', result, fingerprint, storedResultId: stored.result_id, usd: usdForUsage(result.usage), carriesOne }
}

/**
 * When the Email 1 writer began to be shown ONLY the selected fact. The change (f8384e2e)
 * was written on 2026-09-28 and reached main on 2026-09-30 at 21:40 -03:00, which is
 * 2026-10-01T00:40Z. Rows before this may sit on a different candidate.
 */
export const EMAIL1_NARROWED_SINCE = '2026-10-01T01:00:00Z'

// ─── What is written for one prospect ────────────────────────────────────────

/**
 * The update for one prospect: THREE COLUMNS AT MOST. Never the personalisation columns:
 * those are the Email 1, and leaving it untouched is this script's core promise.
 *
 * A COLUMN THAT ALREADY HOLDS COPY IS NOT OVERWRITTEN. Before 2026-09-25 this wrote both
 * unconditionally, so a run that filled a missing email 3 and had its email 2 rejected
 * would NULL an email 2 that had already passed every gate.
 *
 * UNLESS EMAIL 1 HAS MOVED UNDERNEATH IT. The fingerprint is one column covering both
 * positions. Preserving an old email 2 while stamping a fresh fingerprint would declare
 * stale copy current, and composition would ship a follow-up that refers to an Email 1 the
 * prospect never received. So when the stored fingerprint disagrees with this run's,
 * nothing is preserved: whatever this run produced is what the prospect gets, including a
 * null that sends the template.
 */
export function followupUpdateFor(
  row: { followup_email2?: unknown; followup_email3?: unknown; followup_email1_fingerprint?: unknown },
  written: { email2: string | null; email3: string | null },
  fingerprint: string,
): { update: Record<string, string | null>; email1Moved: boolean } {
  const storedFingerprint = (row.followup_email1_fingerprint ?? null) as string | null
  const email1Moved = storedFingerprint !== null && storedFingerprint !== fingerprint
  const update: Record<string, string | null> = { followup_email1_fingerprint: fingerprint }
  for (const [column, fresh, already] of [
    ['followup_email2', written.email2, row.followup_email2 ?? null],
    ['followup_email3', written.email3, row.followup_email3 ?? null],
  ] as const) {
    if (fresh !== null) update[column] = fresh
    else if (already === null || email1Moved) update[column] = null
    // else: this position already holds copy written against the same Email 1. Keep it.
  }
  return { update, email1Moved }
}

// ─── The run over a cohort ───────────────────────────────────────────────────

/** Why a prospect is still held at upload after this run, and what it needs. */
export type StillHeldReason =
  | 'opening_without_approved_reason'
  | 'no_stored_findings'
  | 'no_reference'
  | 'both_follow_ups_rejected'

/**
 * WHAT EACH ONE NEEDS. One remedy per reason: the first version printed a single closing
 * line telling the operator to run research again for all of them, which is wrong for two.
 */
export const STILL_HELD_REMEDY: Record<StillHeldReason, string> = {
  opening_without_approved_reason:
    'Email 1 was not written to one of the client\'s approved trigger reasons as they read today. Running this script again changes nothing. Run its research again, which writes a new Email 1 and its follow-ups together.',
  no_stored_findings:
    'No research inside the 30-day window. Running this script again changes nothing. Run its research again.',
  no_reference:
    'The template Emails 2 and 3 of its variant leave nothing to model a follow-up on. Fix the messaging document. Running its research again helps only where the prospect has no variant assigned.',
  both_follow_ups_rejected:
    'Both follow-ups were written and refused by their own checks. This may pass on another run of this script; each run pays for the attempt again.',
}

const SKIP_WORDING: Record<FollowupSkipReason, string> = {
  template_arm: 'assigned the template arm, skipping',
  current: 'both follow-ups already carry this Email 1, nothing to write',
  no_stored_findings: 'cannot be written for: no research inside the 30-day window',
  no_reference: 'cannot be written for: the template follow-ups for its variant leave nothing to model on',
  opening_without_approved_reason: 'cannot be written for: its Email 1 was not written to a current approved trigger reason',
}

/**
 * The least the run keeps back for the next prospect, in dollars. See the cap in
 * backfillCohort for where the figure comes from.
 */
export const FOLLOWUP_RESERVE_FLOOR_USD = 0.05

export interface BackfillTotals {
  written: number
  current: number
  skipped: number
  /** Prospects the follow-up writer was actually run for. This is what --limit bounds. */
  ran: number
  usd: number
  /** Prospects in the cohort the run stopped before, when the limit was reached. */
  notLookedAt: number
  /** The last prospect id looked at, for --after on the next run. */
  lastId: string | null
  stillHeld: Map<StillHeldReason, string[]>
}

/**
 * The loop, with everything it touches passed in, so it can be tested without a database
 * or a model. main() wires the real functions.
 */
export async function backfillCohort(input: {
  cohort: ReadonlyArray<StoredEmail1Row>
  limit: number | null
  commit: boolean
  forOne: (row: StoredEmail1Row) => Promise<FollowupsForStoredEmail1>
  /** Record every attempt on the research row. Returns an error message or null. */
  recordAttempts: (storedResultId: string, attempts: unknown) => Promise<string | null>
  /** Write the three columns. Returns an error message or null. */
  store: (id: string, update: Record<string, string | null>) => Promise<string | null>
  log: (line: string) => void
  /**
   * The dollar cap for this run. LEFT OUT, THE RUN STILL HAS ONE: the default cap. A caller
   * that forgets to pass it must not be the caller with no ceiling.
   */
  spend?: RunSpend
}): Promise<BackfillTotals> {
  const { cohort, limit, commit, forOne, recordAttempts, store, log } = input
  const spend = input.spend ?? new RunSpend()
  // The dearest prospect so far in this run, which is what the next one is reserved at.
  let largestUsd = 0
  const totals: BackfillTotals = { written: 0, current: 0, skipped: 0, ran: 0, usd: 0, notLookedAt: 0, lastId: null, stillHeld: new Map() }
  const held = (reason: StillHeldReason, id: string) => totals.stillHeld.set(reason, [...(totals.stillHeld.get(reason) ?? []), id])

  for (const [i, p] of cohort.entries()) {
    const id = p.id
    if (limit && totals.ran >= limit) {
      totals.notLookedAt = cohort.length - i
      log(`--limit=${limit} reached: the writer was run for ${totals.ran}. ${totals.notLookedAt} not looked at.`)
      break
    }
    // ═══ THE SPEND CAP: stop before a prospect the cap could not cover ═══
    //
    // Asked before every prospect, because forOne is where the money goes and whether a
    // prospect turns out to be a free skip is only known by starting it.
    //
    // WHAT IS RESERVED FOR THE NEXT ONE. This script has no worst case to read: the writer
    // retries, and each retry is another paid call. So it reserves the dearest prospect
    // this run has already paid for, the same rule scripts/grade-from-evidence.ts uses,
    // with a floor for the start of a run when nothing has been paid for yet. The floor is
    // five cents against a recorded typical of about $0.008 a prospect (this file's
    // header), so roughly six times typical: room for a prospect whose follow-ups are
    // refused and written again. IT IS A RESERVATION, NOT A PROOF. A prospect dearer than
    // every one before it can pass the cap, by at most its own cost over the reservation.
    const reserveUsd = Math.max(FOLLOWUP_RESERVE_FLOOR_USD, largestUsd)
    if (!spend.canAfford(reserveUsd)) {
      totals.notLookedAt = cohort.length - i
      log(`--max-usd reached: ${spend.summary()}, and the next prospect is reserved at $${reserveUsd.toFixed(4)}. ${totals.notLookedAt} not looked at.`)
      break
    }
    log(`[${i + 1}/${cohort.length}] ${id}`)
    totals.lastId = id

    const outcome = await forOne(p)
    // Counted before anything can skip: a skip can follow a paid call.
    totals.usd += outcome.usd
    spend.add(outcome.usd)
    largestUsd = Math.max(largestUsd, outcome.usd)
    if (outcome.status === 'skipped') {
      log(`  ${SKIP_WORDING[outcome.reason]}`)
      if (outcome.reason === 'current') totals.current++
      else totals.skipped++
      // STILL HELD only when the upload would really hold it: an Email 1 with no approved
      // reason always is, and the others only when neither position carries today's Email 1.
      if (outcome.reason === 'opening_without_approved_reason') held(outcome.reason, id)
      else if ((outcome.reason === 'no_stored_findings' || outcome.reason === 'no_reference') && !outcome.carriesOne) held(outcome.reason, id)
      continue
    }
    totals.ran++
    const { result, fingerprint } = outcome

    // ═══ EVERY ATTEMPT, REJECTED PROSE INCLUDED, BEFORE ANYTHING CAN RETURN EARLY ═══
    //
    // WRITTEN BEFORE THE BOTH-REJECTED BRANCH BELOW, deliberately. That branch is exactly
    // the case worth reading back, and storing attempts only on the success path would
    // reproduce the gap one level in. A FAILURE HERE IS LOGGED, NEVER FATAL: this is
    // diagnostics about the run, and losing it must not cost the copy the run paid for.
    if (commit) {
      const attemptsError = await recordAttempts(outcome.storedResultId, result.attempts)
      if (attemptsError) log(`  attempts not recorded: ${attemptsError}`)
    }

    // ── EACH EMAIL IS STORED ON ITS OWN. A null column means the template ships for that
    // position, which is what null already meant.
    if (result.email2.prose === null && result.email3.prose === null) {
      const why = [...result.email2.failures, ...result.email3.failures]
      log(`  BOTH rejected: ${why.join('; ').slice(0, 170)}`)
      totals.skipped++
      if (!outcome.carriesOne) held('both_follow_ups_rejected', id)
      continue
    }

    // THREE OUTCOMES PER POSITION, not two. 'kept' is a position that already held copy
    // against this Email 1; printing it as TEMPLATE would misreport the prospect.
    const w = (fresh: string | null, already: string | null) =>
      fresh ? `${fresh.split(/\s+/).length}w` : already ? 'kept' : 'TEMPLATE'
    log(`  email2 ${w(result.email2.prose, (p.followup_email2 ?? null) as string | null)}` +
      `  email3 ${w(result.email3.prose, (p.followup_email3 ?? null) as string | null)}` +
      `  fp ${fingerprint.slice(0, 12)}`)
    if (result.email2.prose === null) log(`     email 2 fell back: ${result.email2.failures.join('; ').slice(0, 150)}`)
    if (result.email3.prose === null) log(`     email 3 fell back: ${result.email3.failures.join('; ').slice(0, 150)}`)

    if (!commit) { totals.written++; continue }

    const { update, email1Moved } = followupUpdateFor(p, { email2: result.email2.prose, email3: result.email3.prose }, fingerprint)
    if (email1Moved) log('  Email 1 moved since the stored copy was written, so nothing is preserved')
    const storeError = await store(id, update)
    if (storeError) { log(`  WRITE FAILED: ${storeError}`); totals.skipped++; continue }
    totals.written++
  }
  return totals
}

/** The flags of this script that take a value. Each is read ONLY as --name=value. */
const VALUE_FLAGS = ['org', 'ids', 'limit', 'after', 'max-usd'] as const

async function main() {
  const argv = process.argv.slice(2)

  // REFUSED BEFORE ANY WORK: a value flag written with a space. Every reader below looks
  // for `--name=`, so `--limit 10` is two arguments it does not recognise and the run would
  // go ahead with no limit at all. Same for --ids (the whole cohort instead of the named
  // few), --after (starts again from the top) and --max-usd (a different cap).
  const misread = valueFlagProblems(argv, VALUE_FLAGS, 'equals')
  if (misread.length > 0) {
    console.error('backfill-followups: nothing was run.')
    for (const problem of misread) console.error(`  ${problem}.`)
    process.exit(1)
  }
  const spend = new RunSpend(parseCapUsd(argv.find(a => a.startsWith('--max-usd='))?.slice('--max-usd='.length)))

  const commit = argv.includes('--commit')
  // A whole number greater than zero or the run does not start. Read with Number() it was
  // tested for truth below, so "abc" (NaN) and "0" both meant no limit.
  const limit = parseLimit(argv.find(a => a.startsWith('--limit='))?.slice('--limit='.length))
  const idsArg = argv.find(a => a.startsWith('--ids='))?.split('=')[1]
  const ids = idsArg ? idsArg.split(',').map(x => x.trim()).filter(Boolean) : null
  const after = argv.find(a => a.startsWith('--after='))?.split('=')[1] ?? null
  const orgId = argv.find(a => a.startsWith('--org='))?.split('=')[1] ?? env('BACKFILL_ORG_ID')

  const supabase = createClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'))
  const apiKey = env('ANTHROPIC_API_KEY')

  const cohort = await loadCohort(supabase, orgId, ids, after) as unknown as StoredEmail1Row[]
  console.log(ids
    ? `  Scope        : ${ids.length} named id(s); ${cohort.length} of them meet the cohort filters`
    : `  Scope        : EVERY not-yet-uploaded prospect with a personalised Email 1 (${cohort.length})${after ? `, after ${after}` : ''}`)
  console.log(`backfill-followups: ${cohort.length} prospects.`)
  console.log(commit
    ? 'COMMIT MODE: the three follow-up columns WILL be written.'
    : 'DRY RUN: model calls are made and PAID, nothing is written. Pass --commit to store.')
  console.log(`Spend cap: $${spend.capUsd.toFixed(2)} for this run (--max-usd=<n> to change it).`)

  const messaging = await fetchApprovedMessagingDoc(supabase as never, orgId, null)
  const content = messaging.content as MessagingContent
  console.log(`messaging document ${messaging.doc_id}`)

  const clientName = await loadClientName(supabase as never, orgId)

  // THE CLIENT'S TRIGGERS, ONCE PER SEGMENT, CHECKED. A failed read stops the run: read as
  // an empty list it would switch the approved-reason rule off for that prospect.
  const triggersBySegment = new Map<string | null, ReadonlyArray<TriggerWithReason>>()
  const triggersFor = async (segmentId: string | null) => {
    const cached = triggersBySegment.get(segmentId)
    if (cached) return cached
    const read = await loadTriggersChecked(supabase, orgId, segmentId)
    if (!read.ok) throw new Error(`backfill-followups: ${read.error}. Nothing further was written.`)
    if (!read.triggers.some(t => t.reason.trim() !== '')) {
      console.log('  NOTE: this client has no approved trigger reason, so no opening is held to one.')
    }
    triggersBySegment.set(segmentId, read.triggers)
    return read.triggers
  }

  const totals = await backfillCohort({
    cohort, limit, commit, spend, log: line => console.log(line),
    forOne: async row => followupsForStoredEmail1({
      supabase, orgId, row, content, clientName, apiKey,
      triggers: await triggersFor((row.segment_id ?? null) as string | null),
    }),
    recordAttempts: async (storedResultId, attempts) => {
      const { error } = await supabase
        .from('prospect_research_results')
        .update({ followup_attempts: stripNulls(attempts) })
        .eq('id', storedResultId)
        .eq('organisation_id', orgId)
      return error ? error.message : null
    },
    store: async (id, update) => {
      const { error } = await supabase
        .from('prospects')
        .update(update)
        .eq('id', id)
        .eq('organisation_id', orgId)
        // NOT-YET-UPLOADED RE-CHECKED AT THE WRITE, not only at the read. The model calls
        // take ~20s each, so a prospect can be uploaded between the two, and writing
        // follow-ups onto a row that is already at the provider records a claim about copy
        // it has already sent.
        .eq('outbound_upload_status', 'pending')
      return error ? error.message : null
    },
  })

  console.log('\n' + '='.repeat(70))
  console.log(`${commit ? 'written' : 'would write'}  ${totals.written}`)
  console.log(`already carried      ${totals.current}`)
  console.log(`skipped              ${totals.skipped}`)
  console.log(totals.ran > 0
    ? `anthropic            $${totals.usd.toFixed(4)} total, $${(totals.usd / totals.ran).toFixed(4)} per prospect the writer ran for`
    : `anthropic            $${totals.usd.toFixed(4)} total; the writer was not run for anybody`)
  console.log(`spend                ${spend.summary()}`)
  if (totals.notLookedAt > 0 && totals.lastId) {
    console.log(`not looked at        ${totals.notLookedAt}. To carry on past the ones above: --after=${totals.lastId}`)
  }
  if (totals.stillHeld.size > 0) {
    console.log('\nSTILL HELD AT UPLOAD after this run, with what each one needs:')
    for (const [reason, list] of totals.stillHeld) {
      console.log(`\n  ${reason} (${list.length})`)
      console.log(`  ${STILL_HELD_REMEDY[reason]}`)
      for (const one of list) console.log(`    ${one}`)
    }
    console.log('\n  To run research again for chosen prospects, from the command line:')
    console.log('    npx tsx --env-file=.env.local scripts/run-research.ts --org <id> --ids <ids> --allow-overwrite-trigger')
  }
  if (!commit) console.log('\nDRY RUN: nothing was written. Re-run with --commit to store.')
}

// ONLY WHEN RUN DIRECTLY. followupsForStoredEmail1 is imported by the reading report, and
// an import that started a backfill would be the worst kind of side effect.
if (process.argv[1] && process.argv[1].includes('backfill-followups')) {
  main().catch(err => { console.error(err); process.exit(1) })
}
