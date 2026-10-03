// The firm-fact tier at composition: decide, render and re-validate one Email 1.
//
// Plan: Notion "Firm-fact tier: plan (decided 30 September)", Design: "Composition gets a
// third branch: researched trigger, then firm fact (only if the variant has approved fact
// lines), then template." Round 3, ripple (j): composition stays model-free.
//
// PURE. No database, no model, no clock beyond what is passed in. Every input is read from
// the approved messaging document and the prospect row composition already holds, so a
// test can prove every branch, and a reading report can call it with a pending document.
//
// FAILS CLOSED, ALWAYS TO THE TEMPLATE. Each reason below ships exactly what the prospect
// would have received if this tier did not exist, and is returned so composition can log
// it and record it against the send.
//
// TWO THINGS ONLY THIS FILE CAN SEE, both added by the review of 2026-10-02:
//   - the reader's REAL clause beside the sentence under it. No word may be in both
//     (operator rule 3). See openerRepeats and the wording loop in composeWithFills.
//   - the stored fact beside the stored company record. A kind of firm their own site
//     states that is not the brief's kind for this record, and either holds none of the
//     client's evidence words or shares none of the words before the brief kind's head noun,
//     stops the line built from the record. See storedKinds, storedKindContradicts
//     (peer-kind.ts) and the veto in decideFirmFactEmail1.

import { readBrief, clientGenericWords, type OutboundBrief } from '@/lib/outbound-brief/brief'
import {
  namedLeadInParagraph,
  openerFrameIndex,
  renderEmail1SlotFree,
  renderFactEmail1,
  renderFollowup,
  renderFollowupSlotFree,
  slotsIn,
  wordingChoiceFor,
  wordingsOf,
  type Email1Lines,
  type SenderSignoff,
  type VariantLines,
  type WordingChoice,
} from '@/lib/outbound-templates/template-shape'
import { FRAME_NAMES_THE_SITE, GRADE_MASK, validateFactEmail1 } from '@/lib/outbound-templates/validate-templates'
import { countWords } from '@/lib/composition/personalization'
import { companyShortName, firmTradeWords } from '@/lib/composition/company-short-name'
import { EMAIL_WORD_LIMITS } from '@/agents/messaging-generation-agent'
import { FIRM_FACT_CHECKS_VERSION, SOURCE_MAX_AGE_DAYS, broadClause, clauseIsGeneric, findUnexplainedAcronyms, kindFormReasons, kindIsGeneric, kindVerbFor } from '@/lib/agents/research/firm-fact-checks'
import { peerKindFor, storedKindContradicts, type PeerKindRecord } from '@/lib/sourcing/peer-kind'
import { findConsecutiveRepeats } from '@/lib/style/repetition'
import { splitSentences } from '@/lib/style/readability'

/** Which rung of the ladder an Email 1 opener came from. */
export type OpenerRung = 'specific' | 'broad' | 'peer'

export type FactTierDecision =
  | {
      tier: 'firm_fact'
      subject: string
      body: string
      word_count: number
      detail: {
        /**
         * Which rung of the ladder shipped: the specific clause from their site, the kind of
         * firm their site says they are, or the kind of firm built from their stored record
         * (`peer`: no model read anything for it; see src/lib/sourcing/peer-kind.ts).
         */
        rung: OpenerRung
        frame_index: number
        fills: { does: string; for_whom: string | null; peer_group: string | null }
        slotted: { subject: boolean; pain: boolean; offer: boolean; question: boolean }
        /** Which wording of each line shipped, and how many each line has. */
        wording: Required<WordingChoice>
        wording_counts: Required<WordingChoice>
        brief_version: number
        research_result_id: string | null
        /** Set when the fact held a customer group that broke a rule once filled in. */
        for_whom_dropped?: string[]
        /** Set when the specific clause broke a rule with its real words and a lower rung shipped. */
        specific_dropped?: string[]
        /** Set when the pain line took the brief's after-opener label, because the peer label repeated the opener. */
        peer_label_replaced?: string
        /**
         * Set when the pain line took its OTHER wording, because the first sentence of the
         * wording this prospect draws repeats a word of the opener above it: the words.
         * `wording.pain` is the wording that shipped.
         */
        opener_repeat_avoided?: string[]
        /** The peer rung only: what the line was built from. */
        peer?: { peer_group_id: string; industry: string; evidence: { word: string; found_in: 'name' | 'tag' } }
        /** The peer rung only: why no rung above it was used. */
        fact_reason?: string
        /** The peer rung only: what the rung above it broke, when one was tried and failed. */
        fact_violations?: string[]
      }
    }
  | {
      tier: 'template'
      /**
       * Why no rung FROM THE STORED FACT shipped: the fact's own reason when it gave no rung
       * ('no_fact', 'stale_source' ...), otherwise the failure of the first of its rungs
       * that was tried, with `violations`. Never the peer rung's failure: until 2026-10-02 a
       * failed peer attempt was reported here, so a prospect who never had a fact was
       * recorded as a fact that failed re-validation.
       */
      reason: string
      violations?: string[]
      /**
       * Why the rung built from the stored record did not ship either. Absent when no
       * record was passed. A refusal before any attempt ('kind_not_evidenced',
       * 'stored_fact_names_another_kind' ...), or one of RUNG_FAILURE_REASONS when the
       * attempt was made and failed, with `peer_violations`.
       */
      peer_reason?: string
      peer_violations?: string[]
    }

/** The reasons one rung, tried with its real words, can fail for. Any of them sends the ladder to the next rung. */
export const RUNG_FAILURE_REASONS = ['revalidation_failed', 'render_failed', 'opener_repeats_next_sentence'] as const

interface StoredFirmFact {
  version?: unknown
  passed?: unknown
  does?: unknown
  kind?: unknown
  kind_verb?: unknown
  kind_quote?: unknown
  for_whom?: unknown
  section?: unknown
  peer_group_label?: unknown
  research_result_id?: unknown
  source_fetched_at?: unknown
  check_reasons?: unknown
}

/**
 * EVERY KIND OF FIRM THE STORED FACT HOLDS, whatever its version, age or pass state, and
 * whether or not the kind itself passed its checks. For the veto on the peer rung only:
 * these words are not trusted to open an email, and they are trusted to stop one.
 *
 * Three places, all read:
 *   - a kind that passed is in `kind`;
 *   - a kind the checks or the judge DROPPED is kept in check_reasons, as "kind dropped [a
 *     recruitment agency]: ..." (firm-fact.ts writes it). That includes a kind the judge gave
 *     NO VERDICT on, recorded as "kind dropped [X]: judge gave no verdict" since round two of
 *     the review (2026-10-02); before that it was stored nowhere and the veto never saw it.
 *     If firm-fact.ts changes that format, this stops seeing dropped kinds, silently;
 *   - a stored clause that IS a kind, "you run a recruitment agency" or "you are a
 *     recruitment consultancy" (round two): facts from checks with no kind field stored the
 *     kind there. Any other clause ("you help manufacturers cut energy costs") says what the
 *     firm does for others, not what kind of firm it is, and is not read.
 */
function storedKinds(firmFact: unknown): string[] {
  const fact = (firmFact ?? null) as StoredFirmFact | null
  if (!fact || typeof fact !== 'object') return []
  const passed = typeof fact.kind === 'string' && fact.kind.trim() ? [fact.kind.trim()] : []
  const dropped = (Array.isArray(fact.check_reasons) ? fact.check_reasons : [])
    .map(reason => (typeof reason === 'string' ? /^kind dropped \[([^\]]+)\]/.exec(reason)?.[1]?.trim() : undefined))
    .filter((kind): kind is string => !!kind)
  const fromClause = typeof fact.does === 'string' ? /^you (?:run|are) (an? .+?)[.\s]*$/i.exec(fact.does.trim())?.[1] : undefined
  return [...new Set([...passed, ...dropped, ...(fromClause ? [fromClause] : [])])]
}

/** The sign-off is the last paragraph of the stored Email 1: first name, then company. */
export function signoffFromBody(body: string): SenderSignoff | null {
  const paras = body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
  const last = paras[paras.length - 1]?.split('\n').map(l => l.trim()).filter(Boolean) ?? []
  if (last.length !== 2) return null
  return { firstName: last[0], companyName: last[1] }
}

interface FactRungs {
  clauses: Array<{ rung: 'specific' | 'broad'; does: string; slogan?: true }>
  /** Why there is no rung from the stored fact. Null when there is at least one. */
  reason: string | null
  forWhom: string | null
  peerGroup: string | null
  researchResultId: string | null
}

/**
 * The rungs a STORED FACT gives, or the reason it gives none. Every reason here used to
 * send the prospect straight to the template. Since the peer rung exists (2026-10-02) they
 * are reasons the upper rungs are missing, and the ladder carries on below them.
 */
function rungsFromFact(firmFact: unknown, brief: OutboundBrief, now: Date, headcount: number | null): FactRungs {
  const none = (reason: string): FactRungs => ({ clauses: [], reason, forWhom: null, peerGroup: null, researchResultId: null })
  const fact = (firmFact ?? null) as StoredFirmFact | null
  if (!fact) return none('no_fact')
  // A fact judged under an older version of the checks is not trusted: the checks it
  // passed may since have been tightened. See FIRM_FACT_CHECKS_VERSION.
  if (fact.version !== FIRM_FACT_CHECKS_VERSION) return none('fact_from_older_checks')
  // THE LADDER (operator note 6 of the second reading). A fact that passed holds one or
  // both of: the specific clause, and the kind of firm.
  const specificClause = typeof fact.does === 'string' && fact.does.trim() ? fact.does.trim() : null
  const kind = typeof fact.kind === 'string' && fact.kind.trim() ? fact.kind.trim() : null
  // THE VERB IS CODE'S, from the kind and the record (operator, 2026-10-03): "you run" for a
  // company, "you are" only for a person, and a person noun on a firm of more than one is no
  // broad line at all. The extraction's stored verb is no longer read. See kindVerbFor.
  const verb = kind ? kindVerbFor(kind, headcount) : null
  const kindClause = kind && verb ? broadClause(kind, verb) : null
  const kindQuote = typeof fact.kind_quote === 'string' ? fact.kind_quote : null
  // A stored kind always has its quote. One without is not read as "nothing to check".
  const kindReads = !!kind && kindQuote !== null && kindFormReasons(kind, kindQuote).length === 0
  if (fact.passed !== true || (!specificClause && !kind)) return none('fact_did_not_pass')
  // A CLAUSE THAT NAMES NOTHING SPECIFIC IS NOT AN OPENER, AND NEITHER IS ONE HOLDING AN
  // ACRONYM A READER MAY NOT KNOW. Checked here as well as at extraction, on the stored
  // words, so each rule reaches a fact that was stored before it. Against THIS client's
  // generic words, read from the brief as it is today: a word the client adds to the list
  // tomorrow reaches every stored fact with no new extraction.
  const genericWords = clientGenericWords(brief)
  const specific = specificClause && !clauseIsGeneric(specificClause, genericWords) && findUnexplainedAcronyms(specificClause).length === 0
    ? [{ rung: 'specific' as const, does: specificClause }]
    : []
  // ...and a kind must read after its verb. "you run an IT consulting" is not a sentence;
  // the form checks run here as well as at extraction, on the stored words.
  const broad = kind && kindClause && kindReads && !kindIsGeneric(kind, genericWords) && findUnexplainedAcronyms(kind).length === 0
    ? [{ rung: 'broad' as const, does: kindClause }]
    : []
  // A SERVICE LINE BEFORE A SLOGAN (operator note 4 on the fifth reading). A clause the
  // extraction took from a tagline ("for a changing world") is used only after the page's
  // own statement of what kind of firm it is, AND after the kind built from the stored
  // record: the caller places a clause marked `slogan` below the peer rung.
  const fromTagline = fact.section === 'tagline'
  const clauses = fromTagline
    ? [...broad, ...specific.map(clause => ({ ...clause, slogan: true as const }))]
    : [...specific, ...broad]
  if (clauses.length === 0) {
    // The reasons need different actions: a firm that says nothing specific about itself, a
    // kind the extraction cut short, and words that are specific and hold an acronym a
    // reader may not know. The last was filed as "not specific" until it was pointed out
    // that the clause it described was nothing but specific.
    const onlyTheKindsEnding = !specificClause && !!kind && (!kindReads || !kindClause) && !kindIsGeneric(kind, genericWords)
    const anAcronymIsAllThatIsWrong =
      (!!specificClause && !clauseIsGeneric(specificClause, genericWords) && findUnexplainedAcronyms(specificClause).length > 0)
      || (!!kind && !!kindClause && kindReads && !kindIsGeneric(kind, genericWords) && findUnexplainedAcronyms(kind).length > 0)
    return none(onlyTheKindsEnding ? 'fact_kind_does_not_read' : anAcronymIsAllThatIsWrong ? 'fact_holds_an_acronym' : 'fact_not_specific')
  }
  // FRESH WEBSITE TEXT, checked again at SEND time. Extraction applied the age cap when it
  // read the page; a prospect composed weeks later must not ship a fact from a page that
  // has aged past it since.
  const fetched = typeof fact.source_fetched_at === 'string' ? Date.parse(fact.source_fetched_at) : NaN
  if (!Number.isFinite(fetched) || now.getTime() - fetched > SOURCE_MAX_AGE_DAYS * 86_400_000) return none('stale_source')

  // THE PEER LABEL MUST STILL BE ONE OF THE BRIEF'S. The fact stores the label as a string
  // from the day it was extracted. The brief can change after that: a label removed, or
  // reworded because it excluded a buyer. Re-validation masks the slot, so nothing else
  // would notice the old label shipping. A label the current brief does not hold falls back
  // to the default, as an unknown peer group always has.
  const storedLabel = typeof fact.peer_group_label === 'string' ? fact.peer_group_label.trim() : ''
  const labelStillInBrief = storedLabel !== '' && brief.peer_groups.some(pg => pg.label === storedLabel)
  return {
    clauses,
    reason: null,
    forWhom: typeof fact.for_whom === 'string' && fact.for_whom.trim() ? fact.for_whom.trim() : null,
    peerGroup: labelStillInBrief ? storedLabel : null,
    researchResultId: typeof fact.research_result_id === 'string' ? fact.research_result_id : null,
  }
}

export function decideFirmFactEmail1(input: {
  messagingContent: unknown
  variantId: string
  prospectId: string
  firmFact: unknown
  /**
   * What the data provider holds about the prospect's company: name, industry, keywords.
   * The peer rung is built from it. Omitted or null, there is no peer rung, and everything
   * behaves as it did before that rung existed.
   */
  company?: PeerKindRecord | null
  /** The variant's stored, slot-free Email 1 body: the source of the sign-off. */
  templateEmail1Body: string
  /** Composition time, for the freshness rule. Passed in so this stays pure. */
  now: Date
  /** The company's stored headcount, for the verb of the kind line ("you are" only for one person). */
  headcount?: number | null
}): FactTierDecision {
  const content = (input.messagingContent ?? {}) as Record<string, unknown>
  const tier = content.firm_fact_tier as { enabled?: unknown } | undefined
  if (tier?.enabled !== true) return { tier: 'template', reason: 'tier_off' }

  // "No brief" and "a brief that no longer validates" are different facts. The second means
  // this client's tier 2 has just switched off because the brief's shape moved on, and it
  // is recorded as that, with the problems, so it is seen and not read as an absence.
  const read = readBrief(content)
  if (!read.brief) {
    return read.present
      ? { tier: 'template', reason: 'brief_invalid', violations: read.problems }
      : { tier: 'template', reason: 'no_brief' }
  }
  const brief = read.brief

  const variants = (content.variants ?? {}) as Record<string, { lines?: VariantLines }>
  const lines = variants[input.variantId]?.lines
  if (!lines?.email1) return { tier: 'template', reason: 'variant_has_no_lines' }
  if (lines.brief_version !== brief.brief_version) return { tier: 'template', reason: 'lines_from_an_older_brief' }

  const frames = Array.isArray(content.opener_frames)
    ? (content.opener_frames as unknown[]).filter((f): f is string => typeof f === 'string')
    : []
  if (frames.length === 0) return { tier: 'template', reason: 'no_opener_frames' }

  const signoff = signoffFromBody(input.templateEmail1Body)
  if (!signoff) return { tier: 'template', reason: 'signoff_unreadable' }

  // THE LADDER, top to bottom: the specific clause from their site (with the customer group,
  // then without it), the kind of firm their site says they are, the kind of firm their
  // stored record says they are, and the template as the floor. {for_whom} IS OPTIONAL
  // (operator rule 9): a specific customer group fills the offer, and without one the offer
  // and subject fall back to their slot-free forms, line by line.
  //
  // Each rung is tried only when every rung above it is missing or broke a rule with the
  // real words in it (too long for a sentence, too hard to read, a list of three).
  const fromFact = rungsFromFact(input.firmFact, brief, input.now, input.headcount ?? null)
  const frameIndex = openerFrameIndex(input.prospectId, frames.length)
  const attempts: Array<{
    rung: OpenerRung
    frameIndex: number
    fills: { does: string; for_whom: string | null; peer_group: string | null }
  }> = []
  const attemptsFor = (clause: FactRungs['clauses'][number]) => {
    if (clause.rung === 'specific' && fromFact.forWhom) {
      attempts.push({ rung: 'specific', frameIndex, fills: { does: clause.does, for_whom: fromFact.forWhom, peer_group: fromFact.peerGroup } })
    }
    attempts.push({ rung: clause.rung, frameIndex, fills: { does: clause.does, for_whom: null, peer_group: fromFact.peerGroup } })
  }
  for (const clause of fromFact.clauses.filter(c => !c.slogan)) attemptsFor(clause)

  // THE PEER RUNG (operator note 1 on the fifth reading: "build, don't check"). The clause
  // comes from the prospect's stored record, so it is carried only by a frame that does not
  // say it was read on their site. A document with no such frame has no peer rung.
  // A caller that passes no record at all asked for no peer rung: nothing is tried and
  // nothing about it is reported, exactly as before the rung existed.
  const peer = input.company === undefined ? null : peerKindFor(brief, input.company)
  const siteFreeFrames = frames.map((frame, index) => ({ frame, index })).filter(({ frame }) => !FRAME_NAMES_THE_SITE.test(frame))
  // THE STORED FACT AS A VETO (review of 2026-10-02). The record's evidence is a word in a
  // name or a keyword, and a recruiter called "... Recruitment Consultants" passes it. When
  // this prospect's own site was read and names a kind of firm with NONE of the evidence
  // words in it ("a recruitment agency"), the row already holds words that contradict the
  // record, and the sentence is not written. Three such facts shipped "Can see you run an
  // HR consultancy." in the review's probe: a stale one, one judged under older checks, and
  // one whose kind held an acronym. The checks version moves often, and every move sends
  // each older fact down this path, so the second will be common in bulk.
  //
  // WHATEVER THE FACT'S VERSION, AGE OR PASS STATE, and whether the kind itself passed its
  // checks: none of that is trusted to OPEN an email, and all of it is trusted to stop one.
  //
  // A STORED KIND OF ANOTHER TRADE, evidence word or not (round two, 2026-10-02). The
  // recruiter above passes on its name, and its site most likely calls it "a recruitment
  // consultancy", which holds an evidence word. So a stored kind also stops the line when it
  // shares none of the words before the brief kind's head noun: "HR" for "an HR
  // consultancy". See storedKindContradicts for the whole rule.
  //
  // ONLY KINDS. The stored kind, a kind the checks or the judge dropped, and a stored clause
  // that is itself a kind ("you run a recruitment agency"). Any other clause ("you help
  // manufacturers cut energy costs") says what the firm does for others and nothing about
  // what kind of firm it is, so a clause from a tagline still sits below this rung and does
  // not stop it. A stored kind that IS the brief's kind for this record agrees with it.
  //
  // WHAT IT DOES NOT COVER: a prospect whose site was never read, or whose site names no
  // kind of firm at all. Then the record is all there is, and the operator's read of the
  // list is the only layer left (see the header of peer-kind.ts).
  // FAILS CLOSED: a veto sends the prospect to the template, never to another sentence.
  const contradicts = (stored: string) => !!peer?.ok && storedKindContradicts(brief, peer.kind, stored)
  let peerReason: string | undefined
  if (peer === null) peerReason = undefined
  else if (!peer.ok) peerReason = peer.reason
  else if (siteFreeFrames.length === 0) peerReason = 'no_frame_without_the_site'
  else if (storedKinds(input.firmFact).some(contradicts)) peerReason = 'stored_fact_names_another_kind'
  else {
    attempts.push({
      rung: 'peer',
      frameIndex: siteFreeFrames[openerFrameIndex(input.prospectId, siteFreeFrames.length)].index,
      fills: { does: peer.does, for_whom: null, peer_group: peer.label },
    })
  }

  // A clause taken from a slogan is the last thing tried: after the kind their site states
  // and after the kind their record gives. It is still their own words, and still better
  // than nothing about them at all.
  for (const clause of fromFact.clauses.filter(c => c.slogan)) attemptsFor(clause)

  if (attempts.length === 0) {
    return { tier: 'template', reason: fromFact.reason ?? 'no_fact', ...(peerReason ? { peer_reason: peerReason } : {}) }
  }

  // THE TWO REASONS ARE KEPT APART: what failed among the fact's own rungs, and what failed
  // on the rung built from the record. One field for both made a failed peer attempt read
  // as a failed fact, and a peer rung that was tried and failed read as one never asked for.
  type Failure = Extract<FactTierDecision, { tier: 'template' }>
  let factFailure: Failure | undefined
  let peerFailure: Failure | undefined
  let forWhomViolations: string[] | undefined
  let specificViolations: string[] | undefined
  for (const attempt of attempts) {
    const result = composeWithFills({
      input, lines, frames, frameIndex: attempt.frameIndex, fills: attempt.fills, rung: attempt.rung, brief, signoff,
      researchResultId: attempt.rung === 'peer' ? null : fromFact.researchResultId,
    })
    if (result.tier === 'firm_fact') {
      // Recorded when a rung was set aside here, with why: a reply-rate comparison by tier
      // should be able to tell the kinds of tier 2 email apart.
      if (forWhomViolations && attempt.rung === 'specific') result.detail.for_whom_dropped = forWhomViolations
      if (specificViolations && attempt.rung !== 'specific') result.detail.specific_dropped = specificViolations
      if (attempt.rung === 'peer' && peer?.ok) {
        result.detail.peer = { peer_group_id: peer.peer_group_id, industry: peer.industry, evidence: peer.evidence }
        // Why no rung above this one shipped: the fact gave none; or one was tried and broke
        // a rule, and what it broke is kept beside the reason; or all the fact held was a
        // clause from a slogan, which is placed below.
        result.detail.fact_reason = fromFact.reason ?? factFailure?.reason ?? 'only_a_slogan_clause'
        if (factFailure?.violations) result.detail.fact_violations = factFailure.violations
      }
      return result
    }
    // A rung that failed is a reason to try the next one, whatever the failure. Until the
    // peer rung existed a render failure ended the ladder; the first failure of each kind
    // is still what is reported if nothing below it ships.
    if (attempt.rung === 'peer') peerFailure ??= result
    else factFailure ??= result
    if (attempt.rung === 'specific' && attempt.fills.for_whom) forWhomViolations ??= result.violations
    if (attempt.rung === 'specific' && !attempt.fills.for_whom) specificViolations = result.violations
  }
  return {
    tier: 'template',
    reason: fromFact.reason ?? factFailure?.reason ?? 'revalidation_failed',
    ...(factFailure?.violations ? { violations: factFailure.violations } : {}),
    ...(peerFailure
      ? { peer_reason: peerFailure.reason, ...(peerFailure.violations ? { peer_violations: peerFailure.violations } : {}) }
      : peerReason ? { peer_reason: peerReason } : {}),
  }
}

function composeWithFills(args: {
  input: { prospectId: string }
  lines: VariantLines
  frames: string[]
  frameIndex: number
  fills: { does: string; for_whom: string | null; peer_group: string | null }
  rung: OpenerRung
  brief: OutboundBrief
  signoff: SenderSignoff
  researchResultId: string | null
}): FactTierDecision {
  const { input, lines, frames, frameIndex, brief, signoff } = args
  // THE SPECIFIC PEER GROUP, NAMED (operator, 2026-10-03). The pain line names its source
  // mid-sentence ("When we chat to HR consultants, a lot of them tell us ..."), so the label
  // that goes there is the reader's own group where it is known, never a stand-in such as
  // "Firms like yours", which read as faceless and cannot sit mid-sentence. The fifth
  // reading's replacement of an echoing label is withdrawn with it. A word the opener and
  // the sentence under it really share is still caught below (operator note 3).
  const fills = { ...args.fills }
  // A line that cannot render slot-free THROWS (renderSlotFree), and with {for_whom} now
  // optional that path is reachable for a document nobody validated: an alternate wording
  // that uses {for_whom} and has no slot_free form. Caught here, it is a reason, and the
  // prospect gets the template; uncaught, it took composition down for that prospect.
  let rendered: ReturnType<typeof renderFactEmail1> = null
  let masked: ReturnType<typeof renderFactEmail1>
  let graded: ReturnType<typeof renderFactEmail1>
  let wording: Required<WordingChoice>
  let repeatAvoided: string[] | undefined
  try {
    const drawn = wordingChoiceFor(input.prospectId, lines.email1)
    wording = drawn
    const realFills = { does: fills.does, ...(fills.for_whom ? { for_whom: fills.for_whom } : {}), ...(fills.peer_group ? { peer_group: fills.peer_group } : {}) }
    // THE OPERATOR'S RULE 3 ON THE EMAIL AS IT IS SENT: "no word repeated in consecutive
    // sentences". The opener is built here, from the frame and the reader's real clause,
    // and the sentence under it is the first of the pain line with the label already
    // placed. The template validator reads invented fills and the slot-free email; only
    // this place holds the real pair, and until 2026-10-02 nothing read it: "you help
    // founders win new clients" went out over a pain line about "new clients", and the
    // frame's own "your site" over a pain line ending "leave the site".
    //
    // The wording this prospect draws is tried first. When it repeats, the pain line's
    // other wording is tried, and what was avoided is recorded. When every wording repeats
    // this rung has failed, as any rung fails, and the ladder moves to the next one.
    const painCount = wordingsOf(lines.email1.pain).length
    const painOrder = [drawn.pain, ...Array.from({ length: painCount }, (_, index) => index).filter(index => index !== drawn.pain)]
    let drawnRepeats: string[] = []
    for (const pain of painOrder) {
      const candidate = renderFactEmail1({
        wording: { ...drawn, pain },
        email1: lines.email1,
        openerFrames: frames,
        frameIndex,
        fills: realFills,
        peerGroupDefault: brief.peer_group_default.label,
        signoff,
      })
      if (!candidate) return { tier: 'template', reason: 'render_failed' }
      // The label's own words are let through only where the opener names the reader's OWN
      // kind (peer and broad rungs). On the specific rung the clause is what they do, and a
      // label word there is usually their customers: "you ship cold rooms for exporters. When
      // we chat to exporters, ..." names the customers as the reader's peers.
      const echoLabel = args.rung === 'specific' ? null : realFills.peer_group ?? brief.peer_group_default.label
      const repeats = openerRepeats(candidate, echoLabel)
      if (repeats.length === 0) {
        rendered = candidate
        wording = { ...drawn, pain }
        if (pain !== drawn.pain) repeatAvoided = drawnRepeats
        break
      }
      if (pain === drawn.pain) drawnRepeats = repeats
    }
    if (!rendered) {
      return {
        tier: 'template',
        reason: 'opener_repeats_next_sentence',
        violations: drawnRepeats.map(word => `opener_repeats_next_sentence: "${word}" is said by the opener and again by the sentence under it, in every wording of the pain line`),
      }
    }
    // THE SAME MASK WORDS AS THE GENERATOR'S VALIDATOR. Until 2026-10-02 this file masked the
    // peer label as "they" while the validator had moved to a noun, so a pain line opening
    // "{peer_group} are often told" passed generation and would have failed here for the
    // words "They are", for every prospect.
    masked = renderFactEmail1({
      wording,
      email1: lines.email1,
      openerFrames: frames,
      frameIndex,
      fills: { does: GRADE_MASK.does, ...(fills.for_whom ? { for_whom: GRADE_MASK.for_whom } : {}), ...(fills.peer_group ? { peer_group: GRADE_MASK.peer_group } : {}) },
      peerGroupDefault: brief.peer_group_default.label,
      signoff,
    })
    // What the FILLED grade reads: the customer group as the prospect will read it, with
    // the opener clause masked (it has its own cap, note 6 on the fourth reading) and the
    // peer label masked: it is the name of the reader's own trade (2026-10-03, the same
    // mask as the generator's validator).
    graded = renderFactEmail1({
      wording,
      email1: lines.email1,
      openerFrames: frames,
      frameIndex,
      fills: { does: GRADE_MASK.does, ...(fills.for_whom ? { for_whom: fills.for_whom } : {}), ...(fills.peer_group ? { peer_group: GRADE_MASK.peer_group } : {}) },
      peerGroupDefault: brief.peer_group_default.label,
      signoff,
    })
  } catch {
    return { tier: 'template', reason: 'render_failed' }
  }
  if (!rendered || !masked || !graded) return { tier: 'template', reason: 'render_failed' }

  const violations = validateFactEmail1({
    body: rendered.body, maskedBody: masked.body, gradeBody: graded.body, opener: rendered.opener,
    subject: rendered.subject, brief, signoff,
  })
  if (violations.length > 0) {
    return { tier: 'template', reason: 'revalidation_failed', violations: violations.map(v => `${v.rule}: ${v.detail}`) }
  }

  return {
    tier: 'firm_fact',
    subject: rendered.subject,
    body: rendered.body,
    word_count: countWords(rendered.body),
    detail: {
      rung: args.rung,
      frame_index: frameIndex,
      fills,
      slotted: {
        subject: rendered.subject_slotted,
        pain: rendered.pain_slotted,
        offer: rendered.offer_slotted,
        question: rendered.question_slotted,
      },
      wording,
      wording_counts: wordingCounts(lines.email1),
      brief_version: brief.brief_version,
      research_result_id: args.researchResultId,
      ...(repeatAvoided ? { opener_repeat_avoided: repeatAvoided } : {}),
    },
  }
}

/**
 * The words the opener and the sentence straight after it both use, as that sentence
 * writes them. The last sentence of the opener paragraph and the first of the paragraph
 * under it (the pain line): the two a reader meets in a row.
 */
function openerRepeats(email: NonNullable<ReturnType<typeof renderFactEmail1>>, label: string | null): string[] {
  const openerSentence = splitSentences(email.opener).pop()
  const next = splitSentences(email.body.split(/\n{2,}/)[2] ?? '')[0]
  // THE LABEL'S OWN WORDS ARE NOT A REPEAT (2026-10-03) on a rung whose opener names the
  // reader's kind. The operator asked for the reader's own group by name under the opener:
  // "Can see you run a management consultancy. When we chat to management consultants, ...".
  // That echo is the point, and counting it would shut the largest group out of every rung
  // that names a kind. The caller passes null on the specific rung. A word repeated outside
  // the label is still caught.
  const labelWords = new Set((label ?? '').toLowerCase().split(/[^a-z0-9']+/).filter(Boolean))
  return openerSentence && next
    ? findConsecutiveRepeats([openerSentence, next]).map(repeat => repeat.word).filter(word => !labelWords.has(word.toLowerCase()))
    : []
}

export type FollowupFillDecision =
  | { filled: true; body: string; word_count: number; fills: { company: string | null; for_whom: string | null; peer_group: string | null }; slotted: boolean[] }
  | { filled: false; reason: string }

/**
 * THE READER'S FIRM BY NAME IN A TEMPLATE FOLLOW-UP (operator note 2 on the fourth
 * reading, 2026-10-02): "Emails 2 and 3 carry light personalisation whenever we hold it".
 *
 * Follow-up bodies are stored slot-free, which is what a prospect with nothing held
 * receives. Where the variant's lines hold {company} or {for_whom} and this prospect has
 * the fill, the body is rendered again from those lines with the fill in.
 *
 * FAILS CLOSED TO THE STORED BODY, on the same proof decideTemplateEmail1 asks for: the body
 * composition is holding must be, byte for byte, the slot-free rendering of some variant's
 * lines for this position, under the current brief. Then the filled rendering is the same
 * approved paragraphs with a name in them, and nothing else. A body that is not a stored
 * template (a generated follow-up), lines that have drifted from the stored body, or a
 * filled body over the position's word band all ship the body exactly as it was.
 *
 * WHICH VARIANT is found by the body, not assumed: for a personalised prospect the
 * coherence step may have put another variant's Email 2 or 3 in place.
 *
 * {for_whom} is filled only from what Email 1 itself shipped, which the faithfulness
 * checks already passed. {company} is companyShortName's, which returns nothing for a name
 * that would read badly in a sentence.
 */
export function decideFollowupFills(input: {
  messagingContent: unknown
  body: string
  position: 2 | 3 | 4
  companyName: string | null
  forWhom: string | null
  /** The reader, so a firm named after them is not written back to them in the third person. */
  reader?: { firstName?: string | null; lastName?: string | null }
  /**
   * The stored company record, the same one the peer rung is built from. Its industry and
   * keywords are the firm's own trade words (firmTradeWords), so a name such as "Logistics
   * Solutions" under the industry "logistics and supply chain" keeps its full name instead
   * of being cut to "Logistics" (round two of the review, 2026-10-02). Omitted or null, the
   * name is cut as it was before.
   */
  company?: PeerKindRecord | null
  /**
   * The reader's own peer group label, where composition knows it (the firm-fact tier's
   * fill). A follow-up names its source by {peer_group} (2026-10-03); with no label held the
   * paragraph keeps its slot-free form, which carries the brief's default label.
   */
  peerGroup?: string | null
}): FollowupFillDecision {
  const content = (input.messagingContent ?? {}) as Record<string, unknown>
  const read = readBrief(content)
  if (!read.brief) return { filled: false, reason: read.present ? 'brief_invalid' : 'no_brief' }
  const brief = read.brief
  const variants = (content.variants ?? {}) as Record<string, { emails?: Array<{ sequence_position?: number; body?: string }>; lines?: VariantLines }>
  const owner = Object.values(variants).find(v =>
    v?.lines?.brief_version === brief.brief_version &&
    v.emails?.find(e => e.sequence_position === input.position)?.body === input.body)
  const followup = owner?.lines?.followups?.find(f => f.position === input.position)
  if (!followup) return { filled: false, reason: 'body_is_not_a_stored_template' }
  if (!followup.paragraphs.some(p => slotsIn(p.text ?? '').length > 0)) return { filled: false, reason: 'no_slots' }
  const signoff = signoffFromBody(input.body)
  if (!signoff) return { filled: false, reason: 'signoff_unreadable' }
  const pgDefault = brief.peer_group_default.label
  let slotFree: string
  try {
    slotFree = renderFollowupSlotFree(followup, pgDefault, signoff)
  } catch {
    return { filled: false, reason: 'lines_do_not_render' }
  }
  if (slotFree !== input.body) return { filled: false, reason: 'stored_body_differs_from_lines' }

  const company = readerShortName(brief, input)
  const forWhom = typeof input.forWhom === 'string' && input.forWhom.trim() ? input.forWhom.trim() : null
  const peerGroup = typeof input.peerGroup === 'string' && input.peerGroup.trim() ? input.peerGroup.trim() : null
  if (!company && !forWhom && !peerGroup) return { filled: false, reason: 'nothing_held' }
  const rendered = renderFollowup(followup, {
    ...(company ? { company } : {}), ...(forWhom ? { for_whom: forWhom } : {}), ...(peerGroup ? { peer_group: peerGroup } : {}),
  }, pgDefault, signoff)
  if (!rendered.slotted.some(Boolean)) return { filled: false, reason: 'nothing_held' }
  const words = countWords(rendered.body)
  const maxWords = { 2: EMAIL_WORD_LIMITS.email2MaxWords, 3: EMAIL_WORD_LIMITS.email3MaxWords, 4: EMAIL_WORD_LIMITS.email4MaxWords }[input.position]
  if (words > maxWords) return { filled: false, reason: 'filled_body_over_band' }
  // WHAT WENT IN, not what was held. Until the review of 2026-10-02 this returned the two
  // values held, so an Email 3 with no {for_whom} paragraph was recorded as carrying one.
  const used = (slot: 'company' | 'for_whom' | 'peer_group') =>
    followup.paragraphs.some((p, i) => rendered.slotted[i] && slotsIn(p.text ?? '').includes(slot))
  return {
    filled: true,
    body: rendered.body,
    word_count: words,
    fills: { company: used('company') ? company : null, for_whom: used('for_whom') ? forWhom : null, peer_group: used('peer_group') ? peerGroup : null },
    slotted: rendered.slotted,
  }
}

/**
 * The reader's firm as a sentence can carry it, or null. One reading for Email 1's lead-in
 * and the follow-ups, so a prospect is never named two ways in one sequence.
 */
function readerShortName(
  brief: OutboundBrief,
  input: { companyName: string | null; reader?: { firstName?: string | null; lastName?: string | null }; company?: PeerKindRecord | null },
): string | null {
  return companyShortName(input.companyName, clientGenericWords(brief), input.reader ?? {}, firmTradeWords(input.company?.industry, input.company?.tags))
}

export type LeadInDecision =
  | { named: true; body: string; word_count: number; company: string }
  | { named: false; reason: 'no_brief' | 'brief_invalid' | 'no_lines' | 'no_lead_in' | 'nothing_held' | 'no_slot_free_lead_in_in_body' | 'named_body_over_band' }

/**
 * THE READER'S FIRM, NAMED IN EMAIL 1'S LEAD-IN (operator, 2026-10-03): "If Kessel is
 * seeing this too, we ...". Every tier: the Email 1 that would ship holds the lead-in's
 * slot-free form ("If you're seeing this too,") at the start of its offer paragraph, and
 * that clause is replaced by the named one. Applied by composition after Email 1 is final
 * and after its fingerprint is taken, so the follow-ups written against it still match.
 * Fails closed: any doubt, and the slot-free clause ships.
 */
export function decideEmail1LeadIn(input: {
  messagingContent: unknown
  variantId: string
  body: string
  companyName: string | null
  reader?: { firstName?: string | null; lastName?: string | null }
  company?: PeerKindRecord | null
  /** The Email 1 word cap for this prospect's tier. */
  maxWords: number
}): LeadInDecision {
  const content = (input.messagingContent ?? {}) as Record<string, unknown>
  const read = readBrief(content)
  if (!read.brief) return { named: false, reason: read.present ? 'brief_invalid' : 'no_brief' }
  const lines = ((content.variants ?? {}) as Record<string, { lines?: VariantLines }>)[input.variantId]?.lines
  if (!lines?.email1) return { named: false, reason: 'no_lines' }
  if (!lines.email1.lead_in) return { named: false, reason: 'no_lead_in' }
  const company = readerShortName(read.brief, input)
  if (!company) return { named: false, reason: 'nothing_held' }
  const paragraphs = input.body.split('\n\n')
  const index = paragraphs.findIndex(p => namedLeadInParagraph(p, lines.email1.lead_in, company) !== null)
  if (index < 0) return { named: false, reason: 'no_slot_free_lead_in_in_body' }
  paragraphs[index] = namedLeadInParagraph(paragraphs[index], lines.email1.lead_in, company)!
  const body = paragraphs.join('\n\n')
  const words = countWords(body)
  if (words > input.maxWords) return { named: false, reason: 'named_body_over_band' }
  return { named: true, body, word_count: words, company }
}

export function wordingCounts(email1: Email1Lines): Required<WordingChoice> {
  return {
    subject: wordingsOf(email1.subject).length,
    pain: wordingsOf(email1.pain).length,
    offer: wordingsOf(email1.offer).length,
    question: wordingsOf(email1.question).length,
  }
}

export type TemplateEmail1Decision =
  | { rebuilt: true; subject: string; body: string; word_count: number; wording: Required<WordingChoice>; wording_counts: Required<WordingChoice> }
  | { rebuilt: false; reason: string; problems?: string[] }

/**
 * TIER 3 WITH TWO WORDINGS (operator rule 8, 2026-10-01). A template-tier prospect's
 * Email 1 is rebuilt from the variant's lines so its pain, offer and question rotate
 * between the two approved wordings, by prospect.
 *
 * FAILS CLOSED TO THE STORED BODY. The rebuild happens only when it can be shown to be the
 * same email the document stores: the variant has lines from the current brief, and
 * rendering WORDING 0 reproduces the stored body and subject byte for byte. If it does not,
 * the lines and the stored body have drifted apart, nobody can say which is the approved
 * copy, and the stored body ships exactly as before with the reason recorded. A document
 * written by the older messaging agent has no lines and always takes that path.
 *
 * Deliberately NOT gated on firm_fact_tier.enabled: rotating approved wordings is not the
 * firm-fact tier.
 */
export function decideTemplateEmail1(input: {
  messagingContent: unknown
  variantId: string
  prospectId: string
  /** The variant's stored Email 1, as composition read it. */
  storedBody: string
  storedSubject: string | null
}): TemplateEmail1Decision {
  const content = (input.messagingContent ?? {}) as Record<string, unknown>
  const read = readBrief(content)
  // WHICH field is wrong travels with the reason. With the tier off this is the only place
  // an invalid brief shows, and "brief_invalid" alone sends the reader to look for it.
  if (!read.brief) return read.present ? { rebuilt: false, reason: 'brief_invalid', problems: read.problems } : { rebuilt: false, reason: 'no_brief' }
  const brief = read.brief
  const variants = (content.variants ?? {}) as Record<string, { lines?: VariantLines }>
  const lines = variants[input.variantId]?.lines
  if (!lines?.email1) return { rebuilt: false, reason: 'variant_has_no_lines' }
  if (lines.brief_version !== brief.brief_version) return { rebuilt: false, reason: 'lines_from_an_older_brief' }
  const signoff = signoffFromBody(input.storedBody)
  if (!signoff) return { rebuilt: false, reason: 'signoff_unreadable' }

  const pgDefault = brief.peer_group_default.label
  let wordingZero: { subject: string; body: string }
  try {
    wordingZero = renderEmail1SlotFree(lines.email1, pgDefault, signoff)
  } catch {
    return { rebuilt: false, reason: 'lines_do_not_render' }
  }
  if (wordingZero.body !== input.storedBody || wordingZero.subject !== (input.storedSubject ?? '')) {
    return { rebuilt: false, reason: 'stored_body_differs_from_lines' }
  }

  // Wording 0 rendering proves nothing about the alternates: one that uses {for_whom} with
  // no slot_free form throws here. Same answer as above: the stored body ships.
  const wording = wordingChoiceFor(input.prospectId, lines.email1)
  let rendered: { subject: string; body: string }
  try {
    rendered = renderEmail1SlotFree(lines.email1, pgDefault, signoff, wording)
  } catch {
    return { rebuilt: false, reason: 'alternate_wording_does_not_render' }
  }
  return {
    rebuilt: true,
    subject: rendered.subject,
    body: rendered.body,
    word_count: countWords(rendered.body),
    wording,
    wording_counts: wordingCounts(lines.email1),
  }
}

