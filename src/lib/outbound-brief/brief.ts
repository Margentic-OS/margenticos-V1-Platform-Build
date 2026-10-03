// The outbound brief: the ONLY client input the outbound template generator reads.
//
// Plan: Notion "Firm-fact tier: plan (decided 30 September)", Round 7, part 1.
//
// WHY A BRIEF AND NOT THE STRATEGY DOCUMENTS. Round 6 showed the generator used the
// client's documents faithfully and the documents themselves were wrong or too loose for
// outbound: a hook that led with the wrong thing, a line framing the service as a substitute
// for a hire, tone-of-voice idioms that break the reader rules. Fixing the
// generator could not fix that. The fix is to the INPUT: a short, confirmed, per-client
// statement of what outbound may say, drafted FROM the documents and confirmed by a person.
//
// WHERE IT LIVES. content.outbound_brief inside the client's MESSAGING document, never the
// ICP. Putting it in the ICP would force an ICP re-approval before the sourcing fix lands.
//
// CONFIRMATION, NOT APPROVAL. confirmed_by / confirmed_at record that a person confirmed
// these facts. That is not client approval of a strategy document, so ADR-047 is untouched.
//
// Every item carries an `id` and a `source`. Generated template lines cite item ids in
// their `from` field, and the validator refuses an id that does not exist here, so every
// line in an email traces back to a confirmed statement.

import { findAmbiguousReferents } from '@/lib/style/ambiguous-referent'
import { wordsInCommon } from '@/lib/style/repetition'
// No import cycle: peer-kind.ts imports only TYPES from this file, and neither it nor the
// industry list imports anything that reaches back here. Keep it that way: a runtime cycle
// passes tsc and vitest and fails `npm run build`.
import { singularOf, unreachablePeerKinds } from '@/lib/sourcing/peer-kind'
import { CANONICAL_INDUSTRIES } from '@/lib/agents/icp-filter-spec'
import {
  FIRM_KIND_MAX_WORDS,
  findUnexplainedAcronyms,
  kindEndsOnItsNoun,
  kindHoldsAName,
  kindIsGeneric,
} from '@/lib/agents/research/firm-fact-checks'

export type PainReach = 'most_buyers' | 'some_buyers'

/**
 * WHAT THE READER GETS (operator rule 1 of the second reading, 2026-10-01). An offer line
 * sells an outcome, never a feature: it leads with one of these and says what the sender
 * does second. A feature of how the sender works (a dashboard, a report) is supporting
 * proof and lives in proof_points or a proof_only scope item, never here.
 */
export interface ReaderOutcome {
  id: string
  /** The outcome in the reader's terms: what changes for THEIR business. */
  statement: string
  source: string
}

/**
 * A KIND OF COMPANY THAT SELLS WHAT THE CLIENT SELLS (operator rule 7 of the second
 * reading). Such a prospect is a competitor, not a buyer, and is excluded before research
 * is paid for. `statement` describes the category for a person and for the model that
 * judges a borderline company. `phrases` are the lower-case signals code looks for in what
 * the provider says the company does; a company with none of them is never excluded and
 * never costs a model call. `not_this` names the neighbours that STAY in scope, because a
 * category drawn too wide excludes buyers: a general agency that also mentions the service
 * is not a competitor.
 */
export interface CompetitorCategory {
  id: string
  statement: string
  phrases: string[]
  not_this?: string
  source: string
}

export interface PainAngle {
  id: string
  rank: number
  /** Outcome level: lost deals, unpredictable revenue, stalled growth. */
  outcome: string
  statement: string
  /**
   * THE PAIN AS THE READER FEELS IT (operator rule 5, 2026-10-01). Copy states this, never
   * the diagnosis. "Orders arrive late" is a symptom a reader recognises. "They never agreed
   * delivery dates with the carrier" is a diagnosis most readers would reject, however true.
   * `statement` may hold the diagnosis for the record; the generator is shown the symptom.
   */
  symptom: string
  consequence: string
  /** Email 1 may only use most_buyers angles. Follow-ups may use either. */
  reach: PainReach
  /**
   * must_not_exclude ids this angle cannot be written about without excluding (rule 11).
   * An angle about firms whose last supplier let them down cannot be stated without
   * implying the reader had a supplier. An angle with any conflict is never planned into a
   * sequence, never shown to the generator, and may not be cited by any line.
   */
  conflicts_with?: string[]
  /**
   * The outcome ids that ANSWER this pain (operator rule 2 of the second reading). An offer
   * line placed under this pain must cite one of them, so "you can see who we contact"
   * cannot follow "there are too few conversations": it resolves nothing above it.
   */
  resolved_by: string[]
  source: string
}

export type ProofPlacement = 'offer' | 'value_note'

export interface ProofPoint {
  id: string
  rank: number
  /** The SENDER's own claim. May carry the sender's own numbers. */
  claim: string
  reader_outcome: string
  evidence: string
  allowed_in: ProofPlacement[]
  source: string
}

export interface ScopeItem {
  id: string
  statement: string
  /** A proof-only scope item can support a claim but never be the offer's cited scope. */
  proof_only?: boolean
  source: string
}

export interface PhraseRule {
  id: string
  statement: string
  /** Lower-case phrases. Any line containing one is rejected, deterministically. */
  phrases: string[]
  source: string
}

export interface PeerGroup {
  id: string
  /** Colloquial PLURAL a reader would call themselves, e.g. "furniture importers". */
  label: string
  /** The canonical industry from the client's ICP this label stands for. */
  industry: string
  /**
   * What ONE firm in this group is, as it would be said to its owner: "a" or "an" plus up
   * to five words, lower case except an acronym, ending on the noun for the organisation
   * ("a furniture importer", "an HR consultancy"). Optional. With it, composition can open
   * Email 1 on "you run <kind>" for a prospect whose stored industry is this group's and
   * whose own name or keywords say what kind of firm it is: a line built from stored data,
   * with no model and no judge (operator note 1 on the fifth reading, 2026-10-02). It
   * follows "you run", so it names a firm, never a person.
   */
  kind?: string
  source: string
}

export interface ThirdParty {
  id: string
  term: string
  source: string
}

export interface VoiceItem {
  id: string
  rule: string
  source: string
}

export interface OutboundBrief {
  brief_version: number
  confirmed_by: string | null
  confirmed_at: string | null
  /** Item ids drafted but not yet confirmed by a person. Empty when fully confirmed. */
  unconfirmed_items: string[]
  pain_angles: PainAngle[]
  /** What the client achieves for the reader. Every offer line leads with one. */
  outcomes: ReaderOutcome[]
  /** Kinds of company that sell the same service: excluded before research. May be empty. */
  competitor_categories: CompetitorCategory[]
  proof_points: ProofPoint[]
  scope: {
    does: ScopeItem[]
    never_claims: PhraseRule[]
  }
  must_not_exclude: PhraseRule[]
  peer_groups: PeerGroup[]
  /**
   * The slot-free peer noun, used when a prospect's peer group is unknown.
   *
   * `after_opener` is what stands where the label would when the opener has just said what
   * kind of firm the reader runs: "Can see you run an HR consultancy. HR consultants tell
   * us ..." says the same thing twice in two sentences, and "Firms like yours tell us ..."
   * does not. Up to PEER_LABEL_MAX_WORDS words, and it opens the pain line. REQUIRED when
   * any peer group has a kind (2026-10-02): the opener built from a kind is always followed
   * by this label, so that line never rests on a test for shared words. Optional otherwise.
   * It must itself share no word with any kind.
   */
  peer_group_default: { label: string; source: string; after_opener?: string }
  third_parties: ThirdParty[]
  voice: VoiceItem[]
  /**
   * The ONE proof point that is the client's lead differentiator, or null when there is
   * none (operator rule 4, 2026-10-01). Only this proof point may appear in an Email 1
   * offer; every other proof point belongs to a follow-up. Must be the rank 1 proof point.
   */
  lead_differentiator: string | null
  /**
   * Wording this client's outbound must not use, with the reason. Per-client, because what
   * is a narrow consequence or a manual-task word depends on what the client sells: "hiring"
   * is a narrow consequence for one client and the whole offer for another (rules 2 and 6).
   * Checked on the authored words of every email.
   */
  avoid_wording: PhraseRule[]
  /**
   * Per-client slot use (Round 4, decision 1). for_whom_in_offer: the offer names the
   * prospect's OWN customers with {for_whom}. True only when the client's service is
   * getting prospects more customers; for most clients it must stay false, because a
   * prospect's customers have nothing to do with what the client sells them.
   */
  slot_policy?: { for_whom_in_offer: boolean; source: string }
  /**
   * WORDS THAT ARE TRUE OF EVERY FIRM ON THIS CLIENT'S LIST, lower case, one word each.
   *
   * The firm-fact opener says what a prospect does ("you run an HR consultancy"). A line
   * made only of words every prospect shares names nothing: for a client who sells to
   * consultancies, "you run a consulting firm" could be sent to all of them unchanged.
   * WHICH words those are depends on who the client sells to, so they live here and never
   * in shared code. A fixed list of one market's words was in the shared check until
   * 2026-10-01, which is a Rule Zero fault: it called another client's most specific word
   * generic, and it missed this client's.
   *
   * Required, and may be empty: a person decides, an absent list is not a decision. The
   * words of the default peer label are always added to it (clientGenericWords).
   *
   * MATCHED BY INFLECTION ONLY: a plural, a tense, an -ing form. "exporters" covers
   * "exporter" and nothing else; "export" covers "exports" and "exporting". A related word
   * with a different ending is a different entry and has to be listed: "exporter" beside
   * "export", "consultancy" beside "consulting". (Until 2026-10-02 this comment said
   * "exporters" covered "exporting". It does not, and a person listing words from the
   * comment would have listed too few.)
   */
  generic_kind_words: string[]
}

/** Every item id in the brief, mapped to its kind. Used to check a line's `from` ids. */
export type BriefItemKind =
  | 'pain_angle' | 'proof_point' | 'scope_does' | 'never_claim'
  | 'must_not_exclude' | 'avoid_wording' | 'peer_group' | 'third_party' | 'voice'
  | 'outcome' | 'competitor_category'

export function briefItemIndex(brief: OutboundBrief): Map<string, BriefItemKind> {
  const index = new Map<string, BriefItemKind>()
  const add = (items: ReadonlyArray<{ id: string }>, kind: BriefItemKind) => {
    for (const item of items) index.set(item.id, kind)
  }
  add(brief.pain_angles, 'pain_angle')
  add(brief.outcomes ?? [], 'outcome')
  add(brief.competitor_categories ?? [], 'competitor_category')
  add(brief.proof_points, 'proof_point')
  add(brief.scope.does, 'scope_does')
  add(brief.scope.never_claims, 'never_claim')
  add(brief.must_not_exclude, 'must_not_exclude')
  add(brief.avoid_wording ?? [], 'avoid_wording')
  add(brief.peer_groups, 'peer_group')
  add(brief.third_parties, 'third_party')
  add(brief.voice, 'voice')
  return index
}

/** Every phrase a line may never contain: never_claims and must_not_exclude together. */
export function forbiddenPhrases(brief: OutboundBrief): Array<{ id: string; phrase: string }> {
  return [...brief.scope.never_claims, ...brief.must_not_exclude, ...(brief.avoid_wording ?? [])].flatMap(rule =>
    rule.phrases.map(phrase => ({ id: rule.id, phrase: phrase.toLowerCase() })),
  )
}

export function mostBuyersAngles(brief: OutboundBrief): PainAngle[] {
  return brief.pain_angles
    .filter(a => a.reach === 'most_buyers')
    .sort((a, b) => a.rank - b.rank)
}

/**
 * Angles a sequence may be written about: those with no declared conflict against a
 * must_not_exclude buyer, in rank order. Lead (most_buyers) angles are always usable: the
 * brief validator refuses a lead angle that declares a conflict.
 */
export function usableAngles(brief: OutboundBrief): PainAngle[] {
  return brief.pain_angles
    .filter(a => (a.conflicts_with ?? []).length === 0)
    .sort((a, b) => a.rank - b.rank)
}

/** Every angle id that declares a conflict: never planned, never shown, never cited. */
export function conflictedAngleIds(brief: OutboundBrief): Set<string> {
  return new Set(brief.pain_angles.filter(a => (a.conflicts_with ?? []).length > 0).map(a => a.id))
}

/**
 * THE OUTCOMES THE NEUTRAL OFFER MAY LEAD WITH: those that answer EVERY lead angle.
 *
 * One variant's offer is the neutral line (offer_angle null). The offer-line selector hands
 * it to a researched prospect whose opening matches no tagged offer, so it sits under a
 * pain nobody chose in advance. An offer answers the pain above it (rule 2), so the only
 * outcome the neutral line can sell is one that answers all of them. Before this the
 * neutral variant was held to its OWN pain, and the stored line led with the outcome for
 * that one pain: neutral in name, and the wrong-pain offer its fallback exists to prevent.
 */
export function neutralOutcomeIds(brief: OutboundBrief): string[] {
  const lead = mostBuyersAngles(brief)
  if (lead.length === 0) return []
  return (lead[0].resolved_by ?? []).filter(id => lead.every(a => (a.resolved_by ?? []).includes(id)))
}

/**
 * Every word that is generic for THIS client's list: generic_kind_words, plus the words of
 * the default peer label, which by definition describes every reader.
 */
export function clientGenericWords(brief: Pick<OutboundBrief, 'generic_kind_words' | 'peer_group_default'>): Set<string> {
  const fromLabel = (brief.peer_group_default?.label ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1)
  return new Set([...(brief.generic_kind_words ?? []).map(w => w.toLowerCase().trim()).filter(Boolean), ...fromLabel])
}

/** Proof that may sit in an Email 1 offer: the lead differentiator only. */
export function isLeadDifferentiator(brief: OutboundBrief, id: string): boolean {
  return brief.lead_differentiator !== null && brief.lead_differentiator === id
}

/** Ids that count as proof: proof points and proof-only scope items. */
export function proofIds(brief: OutboundBrief): Set<string> {
  return new Set([...brief.proof_points.map(p => p.id), ...brief.scope.does.filter(d => d.proof_only).map(d => d.id)])
}

/** The longest peer group label, in words. The generator's length budget is built on it. */
export const PEER_LABEL_MAX_WORDS = 4

/** Grammar words of two or three letters: never an echo. Longer ones are repetition.ts's to judge. */
const SHORT_GRAMMAR_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'so', 'if', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'as', 'up', 'out',
  'is', 'are', 'was', 'be', 'am', 'do', 'did', 'has', 'had', 'can', 'may', 'it', 'its', 'you', 'we', 'our', 'us',
  'me', 'my', 'he', 'she', 'him', 'her', 'his', 'who', 'why', 'how', 'not', 'no', 'too', 'all', 'any', 'few', 'own',
  'get', 'got', 'say',
])

/**
 * THE WORDS OF A PEER LABEL THAT ECHO THE OPENER ABOVE IT, as the label writes them.
 *
 * wordsInCommon (repetition.ts) is asked first. It reads words of four letters or more,
 * and counts two words as one when they share their opening letters: at least four, and
 * within two of the shorter word's length ("consultancy" and "consultants" are one word to
 * it, "general" and "generators" too). Corrected 2026-10-02: this said it matched only a
 * plain form of the other, which is findConsecutiveRepeats, not wordsInCommon. It still
 * misses exactly the pairs this place produces, a kind of firm followed by a label for
 * firms of that kind (review of 2026-10-02):
 *
 *   "an IT consulting firm"  then  "IT consultants"    "IT" is two letters; one stem, two words
 *   "a law firm"             then  "law firms"         "law" is three letters
 *   "a recruitment agency"   then  "recruiters"        one stem, two words
 *
 * So, for a label under an opener only, a word of the label is also an echo when the
 * clause holds:
 *   - the same ALL-CAPITALS token of two letters or more (HR, IT). In capitals only: "it"
 *     the pronoun is not "IT" the trade;
 *   - the same word once a plural is read as its singular, whatever its length;
 *   - a word sharing its first six letters ("consulting" and "consultants").
 * Grammar words never count, and neither does "firm", which stands where a pronoun would:
 * for words of four letters or more that is repetition.ts's own judgement, asked of it
 * here so there is one list, and below four it is the short list above.
 *
 * LOOSE ON PURPOSE, as that rule is. The cost of a false match is a pain line that opens
 * on "Firms like yours" when the group's own label would have done.
 */
export function peerLabelEchoes(does: string, label: string): string[] {
  const tokens = (text: string) => text.split(/[^A-Za-z0-9]+/).filter(Boolean)
  const counts = (word: string) => (word.length >= 4 ? wordsInCommon(word, word).length > 0 : word.length >= 2 && !SHORT_GRAMMAR_WORDS.has(word))
  const said = tokens(does)
  const echoes = new Set(wordsInCommon(does, label))
  for (const raw of tokens(label)) {
    const word = singularOf(raw.toLowerCase())
    const echoed = said.some(other => {
      if (/^[A-Z][A-Z0-9]+$/.test(raw) && raw === other) return true
      const earlier = singularOf(other.toLowerCase())
      if (!counts(word) || !counts(earlier)) return false
      return word === earlier || (word.length >= 6 && earlier.length >= 6 && word.slice(0, 6) === earlier.slice(0, 6))
    })
    if (echoed) echoes.add(raw.toLowerCase())
  }
  return [...echoes]
}

/**
 * The label that opens the pain line under an opener, given the label it would otherwise
 * carry. NO WORD IN TWO SENTENCES IN A ROW (operator note 3 on the fifth reading), where
 * code fills both: the opener says what kind of firm the reader runs ("you run an HR
 * consultancy"), and a pain line opening "HR consultants tell us" says it again. When the
 * label echoes the opener (peerLabelEchoes) and the brief gives a label for exactly this
 * place, that label is used. One function, called by composition and by the template
 * validator, so what is checked at generation is what is sent.
 */
export function peerLabelUnderOpener(
  brief: Pick<OutboundBrief, 'peer_group_default'>,
  does: string,
  label: string | null,
  /**
   * `kindOfThisGroup`: the opener IS the kind of firm this label is the plural of (the
   * peer rung, and the kind read from their site when the stored label's group has a kind
   * of its own). Then the two say the same thing whatever their words, and no test for an
   * echo is asked at all.
   */
  opts: { kindOfThisGroup?: boolean } = {},
): { label: string | null; replaced: string | null } {
  const plain = label ?? brief.peer_group_default.label
  const after = typeof brief.peer_group_default.after_opener === 'string' ? brief.peer_group_default.after_opener.trim() : ''
  if (after !== '' && (opts.kindOfThisGroup === true || peerLabelEchoes(does, plain).length > 0)) return { label: after, replaced: plain }
  return { label, replaced: null }
}

/**
 * What is wrong with the FORM of a peer group's kind, as plain reasons. Empty when sound.
 * The same form the page-stated kind is held to (firm-fact-checks), minus its quote: this
 * one is the client's own wording, confirmed by a person.
 */
export function peerKindFormProblems(kind: unknown, clientGeneric: ReadonlySet<string>): string[] {
  if (typeof kind !== 'string' || !kind.trim()) return ['must be a non-empty phrase when it is given']
  const phrase = kind.trim()
  const words = phrase.split(/\s+/)
  const problems: string[] = []
  if (!/^(a|an)$/.test(words[0])) problems.push(`"${phrase}" must start with "a" or "an"`)
  if (words.length < 2 || words.length > FIRM_KIND_MAX_WORDS) problems.push(`"${phrase}" must be "a" or "an" plus one to ${FIRM_KIND_MAX_WORDS - 1} words`)
  if (/[.!?;:,&/+|]|[\u2013\u2014]|--|\s-\s/.test(phrase)) problems.push(`"${phrase}" holds punctuation, a slash, a dash or an ampersand`)
  if (/\b(you|your|yours)\b/i.test(phrase)) problems.push(`"${phrase}" holds "you" or "your"`)
  if (!kindEndsOnItsNoun(phrase)) problems.push(`"${phrase}" must end on the noun for the firm ("... consultancy", "... importer"), not on a word for the work`)
  if (kindHoldsAName(phrase)) problems.push(`"${phrase}" is lower case except an acronym: a capitalised word reads as a name`)
  for (const acronym of findUnexplainedAcronyms(phrase)) problems.push(`"${phrase}" holds the acronym "${acronym}", which a reader may not know`)
  if (kindIsGeneric(phrase, clientGeneric)) problems.push(`"${phrase}" names nothing specific: it is true of any firm on this client's list`)
  return problems
}

function containsPhrase(text: string, phrase: string): boolean {
  const escaped = phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(text.toLowerCase())
}

/**
 * Structural check of a brief. Returns every problem, empty when valid.
 *
 * This checks SHAPE, not truth: that ids are unique, every list the generator needs is
 * present, at least one angle may lead Email 1, and every phrase list is usable. Whether a
 * pain is really true for most buyers is the confirming person's call, not code's.
 */
export function validateOutboundBrief(value: unknown): string[] {
  const problems: string[] = []
  if (!value || typeof value !== 'object') return ['brief is not an object']
  const brief = value as Partial<OutboundBrief>

  if (!Number.isInteger(brief.brief_version) || (brief.brief_version as number) < 1) {
    problems.push('brief_version must be a positive integer')
  }
  if (brief.lead_differentiator === undefined) problems.push('lead_differentiator must be a proof point id or null')
  if (!Array.isArray(brief.unconfirmed_items)) problems.push('unconfirmed_items must be an array')
  if (!Array.isArray(brief.generic_kind_words)) {
    problems.push('generic_kind_words must be an array: the words true of every firm on this client\'s list (it may be empty)')
  } else if (brief.generic_kind_words.some(w => typeof w !== 'string' || !/^[a-z0-9]{2,}$/.test(w))) {
    // ONE WORD, as the check reads words: lower case, letters and digits, no hyphen. The
    // check splits a hyphenated word into its parts, so an entry with a hyphen in it
    // validated and then matched nothing. Two characters are allowed, so a client whose
    // whole list is one acronym can say so.
    problems.push('generic_kind_words: every entry is one lower-case word of letters or digits, at least 2 characters, with no hyphen or space')
  }

  const lists: Array<[string, unknown]> = [
    ['pain_angles', brief.pain_angles],
    ['proof_points', brief.proof_points],
    ['scope.does', brief.scope?.does],
    ['scope.never_claims', brief.scope?.never_claims],
    ['must_not_exclude', brief.must_not_exclude],
    ['peer_groups', brief.peer_groups],
    ['third_parties', brief.third_parties],
    ['voice', brief.voice],
    ['avoid_wording', brief.avoid_wording],
    ['outcomes', brief.outcomes],
    ['competitor_categories', brief.competitor_categories],
  ]
  for (const [name, list] of lists) {
    if (!Array.isArray(list)) problems.push(`${name} must be an array`)
  }
  if (problems.length > 0) return problems

  const b = brief as OutboundBrief
  const seen = new Set<string>()
  for (const [name, list] of lists) {
    for (const item of list as Array<{ id?: unknown; source?: unknown }>) {
      if (typeof item.id !== 'string' || item.id.trim() === '') {
        problems.push(`${name}: an item has no id`)
        continue
      }
      if (seen.has(item.id)) problems.push(`duplicate item id ${item.id}`)
      seen.add(item.id)
      if (typeof item.source !== 'string' || item.source.trim() === '') {
        problems.push(`${item.id}: every item needs a source`)
      }
    }
  }

  if (b.pain_angles.length === 0) problems.push('pain_angles is empty')
  if (mostBuyersAngles(b).length === 0) {
    problems.push('no pain angle has reach = most_buyers, so Email 1 has nothing it may lead with')
  }
  for (const a of b.pain_angles) {
    if (a.reach !== 'most_buyers' && a.reach !== 'some_buyers') {
      problems.push(`${a.id}: reach must be most_buyers or some_buyers`)
    }
  }
  const ranks = b.pain_angles.map(a => a.rank)
  if (new Set(ranks).size !== ranks.length) problems.push('pain_angles ranks must be unique')

  if (b.scope.does.filter(d => !d.proof_only).length === 0) {
    problems.push('scope.does needs at least one item an offer may cite (not proof_only)')
  }
  for (const rule of [...b.scope.never_claims, ...b.must_not_exclude, ...b.avoid_wording]) {
    if (!Array.isArray(rule.phrases) || rule.phrases.length === 0) {
      problems.push(`${rule.id}: phrases must be a non-empty list`)
    } else if (rule.phrases.some(p => typeof p !== 'string' || p.trim().length < 3)) {
      problems.push(`${rule.id}: every phrase must be at least 3 characters`)
    }
  }
  if (!b.peer_group_default || typeof b.peer_group_default.label !== 'string' || !b.peer_group_default.label.trim()) {
    problems.push('peer_group_default.label is required')
  }
  for (const pg of b.peer_groups) {
    if (typeof pg.label !== 'string' || !pg.label.trim()) problems.push(`${pg.id}: label is required`)
  }
  // A label fills {peer_group}, and every length rule downstream (the 15-word sentence, the
  // firm-fact Email 1 ceiling, the budget the generator is given) is computed from a label
  // of at most this many words. Unenforced, the arithmetic rested on a number nothing held.
  for (const { id, label } of [
    { id: 'peer_group_default', label: b.peer_group_default?.label },
    { id: 'peer_group_default.after_opener', label: b.peer_group_default?.after_opener },
    ...b.peer_groups,
  ]) {
    if (typeof label === 'string' && label.trim().split(/\s+/).length > PEER_LABEL_MAX_WORDS) {
      problems.push(`${id}: label "${label}" is over ${PEER_LABEL_MAX_WORDS} words`)
    }
  }
  if (b.peer_group_default?.after_opener !== undefined && (typeof b.peer_group_default.after_opener !== 'string' || !b.peer_group_default.after_opener.trim())) {
    problems.push('peer_group_default.after_opener must be a non-empty phrase when it is given')
  }

  // A KIND IS SAID TO A STRANGER AS A FACT ABOUT THEIR FIRM, so its form is held here, where
  // a person can fix it. See PeerGroup.kind and src/lib/sourcing/peer-kind.ts.
  {
    const generic = clientGenericWords(b)
    const industries = new Map<string, string>()
    for (const pg of b.peer_groups) {
      if (pg.kind === undefined) continue
      for (const problem of peerKindFormProblems(pg.kind, generic)) problems.push(`${pg.id}: kind ${problem}`)
      if (typeof pg.industry !== 'string' || !pg.industry.trim()) {
        problems.push(`${pg.id}: a peer group with a kind names its industry: that is what a prospect is matched on`)
        continue
      }
      const key = pg.industry.trim().toLowerCase()
      const other = industries.get(key)
      if (other) problems.push(`${pg.id}: its industry "${pg.industry}" already has a kind on ${other}; one kind per industry`)
      industries.set(key, pg.id)
    }

    // FAULTS ONLY THE BRIEF CAN FIX ARE FOUND HERE, WHERE IT COSTS NOTHING (2026-10-02).
    // Each of the three below used to pass this validator and fail the template validator.
    // The generator then handed the fault to the writer, which cannot change a label, a
    // kind or an industry, and paid for repair calls until the spend cap stopped the run:
    // 13 repair calls, measured with a stub client, for a brief whose only fault was a
    // missing after_opener, and the same again on every rerun.
    const withKind = b.peer_groups.filter(pg => typeof pg.kind === 'string' && pg.kind.trim() !== '')

    // 1. A kind no prospect could ever be given: an industry the lookup never returns, or no
    //    word that could evidence it. A group with no industry is already reported above.
    problems.push(...unreachablePeerKinds(
      { ...b, peer_groups: withKind.filter(pg => typeof pg.industry === 'string' && pg.industry.trim() !== '') },
      CANONICAL_INDUSTRIES,
    ))

    // 2. The opener built from a kind is always followed by the after-opener label, so a
    //    brief with a kind has one. Without it that line rested on the shared-word test,
    //    and "you run a law firm" then "Law firms often tell us" went past it. Asked only
    //    when the field is ABSENT: one that is given and unusable is reported above.
    if (withKind.length > 0 && b.peer_group_default?.after_opener === undefined) {
      problems.push('peer_group_default.after_opener is required when a peer group has a kind: it opens the line under "you run <kind>", where the group\'s own label would say the same thing twice ("Firms like yours")')
    }

    // 3. And that label must not itself repeat a kind ("Software firms like yours" under
    //    "you run a software company"). Asked through the function composition calls, so
    //    what is checked here is what is sent. Only once there IS a usable label: without
    //    one the group's own label would stand there, and rule 2 has already said so.
    const afterOpener = typeof b.peer_group_default?.after_opener === 'string' ? b.peer_group_default.after_opener.trim() : ''
    for (const pg of afterOpener === '' ? [] : withKind) {
      const does = `you run ${pg.kind!.trim()}`
      const placed = peerLabelUnderOpener(b, does, typeof pg.label === 'string' ? pg.label : null, { kindOfThisGroup: true }).label ?? ''
      const echoes = peerLabelEchoes(does, placed)
      if (echoes.length > 0) {
        problems.push(`${pg.id}: "${echoes.join('", "')}" is said by the opener ("${does}") and again by the label that opens the line under it ("${placed}"); reword peer_group_default.after_opener so it shares no word with any kind`)
      }
    }
  }

  // An offer sells an outcome: there must be at least one, and every angle a sequence may
  // use names the outcome that answers it, or no offer could legally follow that pain.
  if (b.outcomes.length === 0) problems.push('outcomes is empty: an offer line has nothing it may lead with')
  for (const o of b.outcomes) {
    if (typeof o.statement !== 'string' || !o.statement.trim()) problems.push(`${o.id}: statement is required`)
  }
  const outcomeIds = new Set(b.outcomes.map(o => o.id))
  for (const a of b.pain_angles) {
    const resolvedBy = Array.isArray(a.resolved_by) ? a.resolved_by : []
    for (const id of resolvedBy) {
      if (!outcomeIds.has(id)) problems.push(`${a.id}: resolved_by ${id}, which is not an outcome`)
    }
    if (resolvedBy.length === 0 && (a.conflicts_with ?? []).length === 0) {
      problems.push(`${a.id}: resolved_by is required (the outcome that answers this pain)`)
    }
  }
  // THE NEUTRAL OFFER NEEDS AN OUTCOME THAT ANSWERS EVERY LEAD ANGLE. With two or more lead
  // angles one variant's offer is the neutral line, placed under whichever pain a prospect
  // gets. If no outcome answers all of them, no line can be both neutral and an answer to
  // the pain above it, and the generator would burn every repair round finding that out.
  {
    const lead = mostBuyersAngles(b)
    if (lead.length >= 2 && lead.every(a => (a.resolved_by ?? []).length > 0) && neutralOutcomeIds(b).length === 0) {
      problems.push(
        `no outcome answers every lead angle (${lead.map(a => `${a.id}: ${(a.resolved_by ?? []).join(', ')}`).join('; ')}); ` +
        'the neutral offer line has nothing it may lead with. Add one outcome to resolved_by of each lead angle',
      )
    }
  }
  // THE BRIEF MUST NOT FORBID ITS OWN WORDS. The generator is told to state an outcome and a
  // pain in the brief's own words, and the validator refuses any line holding a never_claims,
  // must_not_exclude or avoid_wording phrase. A phrase that sits inside an outcome, a
  // symptom or a consequence makes both true at once: every variant fails on it, on every
  // repair round, with nothing the generator can rewrite. Refused here, where it can be fixed.
  {
    const forbidden = [...b.scope.never_claims, ...b.must_not_exclude, ...b.avoid_wording]
      .flatMap(rule => (rule.phrases ?? []).map(phrase => ({ id: rule.id, phrase })))
      .filter(f => typeof f.phrase === 'string' && f.phrase.trim())
    const written: Array<[string, unknown]> = [
      ...b.outcomes.map(o => [`${o.id}.statement`, o.statement] as [string, unknown]),
      ...usableAngles(b).flatMap(a => [[`${a.id}.symptom`, a.symptom], [`${a.id}.consequence`, a.consequence]] as Array<[string, unknown]>),
    ]
    for (const [where, text] of written) {
      if (typeof text !== 'string') continue
      for (const { id, phrase } of forbidden) {
        if (containsPhrase(text, phrase)) problems.push(`${where}: holds "${phrase}", which ${id} forbids in copy; the generator is told to use these words and the validator refuses them`)
      }
    }
  }
  // A competitor category is found by its phrases, so it needs some, as every phrase rule does.
  for (const c of b.competitor_categories) problems.push(...competitorCategoryProblems(c))
  // NO PHRASE THAT CAN BE READ TWO WAYS, IN THE BRIEF ITSELF. Copy repeats the brief's
  // words, and the generator's judge never holds the brief's own wording against a line.
  // So an indefinite referent here ("good work can go to someone else") would ship in
  // every variant with nothing able to repair it. It is refused where it can be fixed.
  const wordings: Array<[string, unknown]> = [
    ...b.pain_angles.flatMap(a => [[`${a.id}.outcome`, a.outcome], [`${a.id}.symptom`, a.symptom], [`${a.id}.consequence`, a.consequence]] as Array<[string, unknown]>),
    ...b.outcomes.map(o => [`${o.id}.statement`, o.statement] as [string, unknown]),
    ...b.proof_points.flatMap(pp => [[`${pp.id}.claim`, pp.claim], [`${pp.id}.reader_outcome`, pp.reader_outcome]] as Array<[string, unknown]>),
    ...b.scope.does.map(d => [`${d.id}.statement`, d.statement] as [string, unknown]),
  ]
  for (const [where, text] of wordings) {
    if (typeof text !== 'string') continue
    for (const phrase of findAmbiguousReferents(text)) {
      problems.push(`${where}: "${phrase}" can be read two ways; name who or what is meant`)
    }
  }

  // Rule 5: every angle carries the symptom the reader feels.
  for (const a of b.pain_angles) {
    if (typeof a.symptom !== 'string' || !a.symptom.trim()) problems.push(`${a.id}: symptom is required (the pain as the reader feels it)`)
  }

  // Rule 11: a declared conflict must name a real must_not_exclude item, and a lead angle
  // may declare none, because Email 1 has nothing else to lead with.
  const excludeIds = new Set(b.must_not_exclude.map(x => x.id))
  for (const a of b.pain_angles) {
    for (const id of a.conflicts_with ?? []) {
      if (!excludeIds.has(id)) problems.push(`${a.id}: conflicts_with ${id}, which is not a must_not_exclude item`)
    }
    if (a.reach === 'most_buyers' && (a.conflicts_with ?? []).length > 0) {
      problems.push(`${a.id}: a most_buyers angle cannot conflict with a must_not_exclude buyer; make it some_buyers or fix the conflict`)
    }
  }

  // Rule 4: the lead differentiator is null or the rank 1 proof point.
  if (b.lead_differentiator !== null) {
    const lead = b.proof_points.find(p => p.id === b.lead_differentiator)
    if (!lead) problems.push(`lead_differentiator ${String(b.lead_differentiator)} is not a proof point`)
    else if (lead.rank !== Math.min(...b.proof_points.map(p => p.rank))) {
      problems.push(`lead_differentiator ${lead.id} is not the top-ranked proof point`)
    }
  }

  // Rule 7: a peer label names the reader, so it must be true of ANY in-scope buyer. A label
  // carrying wording the brief itself says would exclude an in-scope buyer cannot be: a
  // default label that names one kind of owner excludes every reader who is another kind.
  // Checked here because the template validator masks slot fills, so it cannot see a label.
  //
  // THIS IS THE FLOOR, NOT THE CHECK. It fires only when the excluding word is already
  // listed as a phrase. Whether a label nobody thought to list excludes a buyer is a
  // judgement, and the generator asks a model that question before it writes anything
  // (judgePeerDefaultLabel in outbound-template-agent.ts).
  const excluding = [...b.must_not_exclude, ...b.avoid_wording].flatMap(r => (r.phrases ?? []).map(p => ({ id: r.id, phrase: p })))
  const labels = [{ id: 'peer_group_default', label: b.peer_group_default?.label ?? '' }, ...b.peer_groups.map(pg => ({ id: pg.id, label: pg.label ?? '' }))]
  // The DEFAULT label is also printed, unmasked, in every slot-free email, where the
  // sender's never_claims phrases are matched against the whole body. A default label
  // carrying one validated here and then failed every variant on every repair round, with
  // nothing the generator could rewrite. Refused where it can be fixed: in the brief.
  for (const rule of b.scope.never_claims) {
    for (const phrase of rule.phrases ?? []) {
      if (typeof phrase === 'string' && phrase.trim() && containsPhrase(b.peer_group_default?.label ?? '', phrase)) {
        problems.push(`peer_group_default: label "${b.peer_group_default.label}" contains the never_claims phrase "${phrase}" (${rule.id}); every slot-free email would fail on it`)
      }
    }
  }
  for (const { id, label } of labels) {
    for (const { id: ruleId, phrase } of excluding) {
      if (typeof phrase === 'string' && phrase.trim() && containsPhrase(label, phrase)) {
        problems.push(`${id}: label "${label}" contains "${phrase}" (${ruleId}); a peer label must be true for any in-scope buyer`)
      }
    }
  }
  return problems
}

/**
 * The brief inside a messaging document's content, or null when there is none or it is
 * not valid. The ONLY path by which the template generator reads a messaging document:
 * it returns the brief section and nothing else, so no other field of the document can
 * reach the generator's prompt.
 */
export function briefFromMessagingContent(content: unknown): OutboundBrief | null {
  return readBrief(content).brief
}

/**
 * What makes ONE competitor category unusable. One function, read by the brief's validator
 * and by the competitor screen's own narrow reader below, so the two cannot disagree about
 * what a usable category is.
 */
export function competitorCategoryProblems(category: unknown): string[] {
  if (!category || typeof category !== 'object') return ['a competitor category is not an object']
  const c = category as Partial<CompetitorCategory>
  const id = typeof c.id === 'string' && c.id.trim() ? c.id : '(no id)'
  const problems: string[] = []
  if (id === '(no id)') problems.push('a competitor category has no id')
  if (typeof c.statement !== 'string' || !c.statement.trim()) problems.push(`${id}: statement is required`)
  if (!Array.isArray(c.phrases) || c.phrases.length === 0) {
    problems.push(`${id}: phrases must be a non-empty list`)
  } else if (c.phrases.some(p => typeof p !== 'string' || p.trim().length < 3)) {
    problems.push(`${id}: every phrase must be at least 3 characters`)
  }
  if (c.not_this !== undefined && typeof c.not_this !== 'string') problems.push(`${id}: not_this must be text`)
  return problems
}

/**
 * The competitor categories of a messaging document, READ ON THEIR OWN.
 *
 * NOT THROUGH readBrief, deliberately. readBrief returns no brief at all on ANY validation
 * problem, and the validator carries copy rules: a phrase that can be read two ways, a pain
 * angle with no resolved_by. Read through it, an unrelated wording fault would switch a
 * client's competitor exclusion off with no error anywhere. Who must not be researched is
 * not a copy question, so it does not inherit copy rules.
 *
 * A category that is itself unusable is dropped and NAMED in `problems`; the others still
 * apply. `present` is false when the document carries no list at all, which is a client
 * with nothing to screen for, and is not a fault.
 */
export function readCompetitorCategories(content: unknown): {
  categories: CompetitorCategory[]
  present: boolean
  problems: string[]
} {
  if (!content || typeof content !== 'object') return { categories: [], present: false, problems: [] }
  const brief = (content as Record<string, unknown>).outbound_brief
  if (!brief || typeof brief !== 'object') return { categories: [], present: false, problems: [] }
  const raw = (brief as Record<string, unknown>).competitor_categories
  if (raw === undefined || raw === null) return { categories: [], present: false, problems: [] }
  if (!Array.isArray(raw)) return { categories: [], present: true, problems: ['competitor_categories must be an array'] }
  const categories: CompetitorCategory[] = []
  const problems: string[] = []
  for (const item of raw) {
    const faults = competitorCategoryProblems(item)
    if (faults.length > 0) problems.push(...faults)
    else categories.push(item as CompetitorCategory)
  }
  return { categories, present: true, problems }
}

/**
 * The same read, keeping WHY there is no brief.
 *
 * "No brief" and "a brief that no longer validates" look identical through
 * briefFromMessagingContent, and they are opposite situations: one is a client who has never
 * had a brief, the other is a client whose tier 2 and wording rotation have just switched
 * off because a field was added to the shape (lead_differentiator, avoid_wording and
 * symptom all arrived on 2026-10-01). Callers that record or log a reason use this, so an
 * older-shape brief is reported as that, with the problems, and not as an absence.
 */
export function readBrief(content: unknown): { brief: OutboundBrief | null; present: boolean; problems: string[] } {
  if (!content || typeof content !== 'object') return { brief: null, present: false, problems: [] }
  const raw = (content as Record<string, unknown>).outbound_brief
  if (raw === undefined || raw === null) return { brief: null, present: false, problems: [] }
  const problems = validateOutboundBrief(raw)
  return problems.length > 0
    ? { brief: null, present: true, problems }
    : { brief: raw as OutboundBrief, present: true, problems: [] }
}
