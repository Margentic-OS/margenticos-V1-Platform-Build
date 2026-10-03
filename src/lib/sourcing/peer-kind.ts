// What kind of firm a prospect runs, BUILT from stored data. No model, no judge.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE RULE (operator note 1 on the fifth reading, 2026-10-02)
//
// "Build, don't check: wherever a line can be assembled by code from stored data, do that
// instead of generating and judging it. Apply now to the broadest semi-personal rung, 'Can
// see you run [peer label]' from the stored industry through the brief's peer labels,
// deterministic, no model or judge."
//
// The rungs above this one read the prospect's own website with a model and check what it
// wrote with a second model and a page of form rules. Three rounds of review each found a
// shape those rules missed. This rung has none of that surface: the sentence is the
// client's own wording for a kind of firm, chosen by a lookup.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT MAKES THE SENTENCE TRUE: TWO PIECES OF STORED EVIDENCE, NOT ONE
//
//   1. THE FIELD comes from the data provider's industry for the company, read through the
//      exact industry lookup (canonicalIndustryExact) to a canonical industry, and from
//      there to the one peer group in the client's brief that stands for it.
//   2. THAT IT IS THIS KIND OF FIRM AT ALL comes from the company's own name or the
//      keywords on its record: one of them must hold a word the client's brief lists as
//      true of every firm it writes to (generic_kind_words), or the head noun of the kind
//      where that noun is more than a word for "a firm". See WHAT COUNTS AS EVIDENCE below.
//
// The first alone is not enough, and that is measured. The provider's industry is coarse:
// "information technology & services" is a software company as readily as an IT
// consultancy, and "human resources" a staffing agency. A sentence that told a software
// company it runs an IT consultancy would be wrong in the first line of the email. With
// the second, "an IT consultancy" is said only to a firm whose own name or keywords say
// consulting.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT COUNTS AS EVIDENCE (tightened twice by the review of 2026-10-02)
//
//   FROM THE NAME: an evidence word anywhere in it, in any form. "Kessel Consultancy",
//      "Kessel Consultants".
//   FROM A KEYWORD: only a keyword that is ITSELF a description of the kind of firm. All of:
//        - at most three words;
//        - its LAST word an evidence word IN THE SINGULAR. A keyword ending on a plural
//          ("consultants", "advisors", "advisers", "consultancies", "exporters") never
//          counts: a plural in a keyword usually names the firm's customers or users, not
//          the firm. A word ending in s (not -ss, -us or -is) is read as a plural, so a mass
//          noun such as "logistics" never counts from a keyword either. That fails closed;
//        - none of the joining words for, to, of, with, and, in, by, via, from, on, at, 4;
//        - none of the marks & / + | or a comma, and no word ending in a hyphen.
//      "management consulting", "it consultancy" and "it-consulting" count. A word inside a
//      longer keyword never does.
//
// Until the first tightening any evidence word in any keyword passed. A provider holds
// dozens of keywords per company, and many name the firm's CUSTOMERS or its PRODUCT:
// "software for consultants", "crm for financial advisors", "tools for hr consultants",
// "consulting services" beside six software keywords. Each told a software maker it runs a
// consultancy. The second tightening (round two) closed the shapes the first still let
// through: a bare customer plural ("hr consultants" on an HR software maker's record),
// joining words not on the first list ("software by consultants", "specialists in
// consulting") and marks ("crm/consultants", "saas | consultants").
//
// MEASURED on the live client on 2026-10-02, under the FIRST tightening (not this one, and
// not measured again since): of 280 researched prospects, 145 were evidenced by their own
// name and 64 by a keyword; of the 82 with no research-based opening, 41 by name and 23 by
// a keyword. No prospect with a mapped industry and a kind failed evidence. The keyword
// counts are the ones this second tightening can only lower. The "82 of 82" this header
// quoted before the first tightening re-read the sourcing filter (sourcing selects
// companies BY keyword) and is withdrawn.
//
// WHAT THIS STILL LETS THROUGH, stated so the rule is not over-trusted:
//   - a firm of another kind whose own NAME holds the word: a recruiter called "...
//     Recruitment Consultants", a broker called "... Benefits Advisory";
//   - a singular PRODUCT noun that ends on the word: "robo advisor", "payroll advisor";
//   - a three-word singular keyword that names another trade: "contract it consultant" on a
//     staffing firm's record.
// And the INDUSTRY must map as well (exact, static table, to a group with a kind), which
// none of the above escapes. Two more layers stand behind it. The stored fact is a VETO at
// composition, when the prospect's own site was read and names a kind of firm that is not
// this one (storedKindContradicts; it covers the recruiter whose site says "a recruitment
// consultancy", and it cannot help when the site was never read or named no kind). And the
// operator reads the list: before the tier is switched on for a client, count how many
// stored prospects get this sentence while research or the firm-fact extraction read them
// as another kind of firm, read every one, and read the keyword-evidenced ones for a
// product noun.
//
// Anything missing returns a reason and no sentence. The prospect then gets the template.
//
// RULE ZERO. Nothing here names a market. The kinds, the labels and the words that count as
// evidence all come from the client's brief.
//
// TOOL-AGNOSTIC. This reads a CompanyRecord (name, industry, tags), which the sourcing
// layer builds from whatever the provider stored. No provider is named here.

import type { OutboundBrief, PeerGroup } from '@/lib/outbound-brief/brief'
import { isClientGeneric, kindIsGeneric } from '@/lib/agents/research/firm-fact-checks'
import { canonicalIndustryExact } from './industry-mapping'

/** What the provider holds about a company, as the sourcing layer reads it. */
export interface PeerKindRecord {
  name: string | null
  industry: string | null
  tags: readonly string[]
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

/**
 * The record for one prospect row. The keywords are read from the stored enrichment as the
 * provider wrote it (an `organization.keywords` list); a row with none simply has no tags.
 * Null when the row holds no name and no industry: nothing to build from.
 */
export function peerKindRecordFromRow(row: {
  company_name?: string | null
  company_industry?: string | null
  enrichment?: unknown
}): PeerKindRecord | null {
  const stored = row.enrichment
  const organisation = stored && typeof stored === 'object'
    ? ((stored as Record<string, unknown>).organization as Record<string, unknown> | undefined) ?? null
    : null
  const keywords = Array.isArray(organisation?.keywords) ? organisation.keywords.map(text).filter((tag): tag is string => tag !== null) : []
  const name = text(row.company_name)
  const industry = text(row.company_industry)
  if (!name && !industry) return null
  return { name, industry, tags: keywords }
}

export type PeerKindDecision =
  | {
      ok: true
      /** The clause the opener carries: "you run an HR consultancy". */
      does: string
      peer_group_id: string
      /** The group's plural label, for the pain line. */
      label: string
      kind: string
      /** The canonical industry the stored one resolved to. */
      industry: string
      /** The word that says it is this kind of firm, and where it was found. */
      evidence: { word: string; found_in: 'name' | 'tag' }
    }
  | { ok: false; reason: PeerKindRefusal }

/**
 * Why there is no sentence.
 *
 * 'industry_not_in_static_table' was 'industry_not_mapped' until 2026-10-02. The old name
 * pointed at a remedy this code never reads: tiering resolves a provider industry through
 * the operator's own industry_tag_mappings rows first, and adding a row there changes
 * nothing here. This lookup is the static table only (canonicalIndustryExact), on purpose:
 * an operator mapping is a fair guess for a tiering score and is not held to the standard
 * of a sentence a prospect reads about their own firm. So a prospect tiered under an
 * operator mapping gets no peer rung, and the reason now says which table was asked.
 */
export type PeerKindRefusal =
  | 'no_record' | 'no_stored_industry' | 'industry_not_in_static_table' | 'no_kind_for_industry' | 'kind_not_evidenced'

const wordsOf = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1)

/**
 * THE WORDS THAT SAY "THIS KIND OF FIRM", for one kind in one client's brief. One function,
 * read by the lookup below, by unreachablePeerKinds and by the stored fact's veto at
 * composition, so the three cannot disagree about what evidence is.
 *
 * The client's own list, and the kind's head noun when that noun says something
 * ("consultancy", "importer"). A head noun that is only a word for "a firm" ("a software
 * company") is no evidence: every company is one. And the words BEFORE the head are never
 * evidence: "HR" in a name is as true of an HR software maker as of an HR consultancy, and
 * the industry has already supplied the field.
 *
 * THE CLIENT'S OWN LIST ONLY (generic_kind_words), and never a plain word for "a firm"
 * from it. clientGenericWords also holds every word of the default peer label, and a
 * label such as "export firms" would make "firms" evidence: a keyword like "law firms",
 * which names the company's CUSTOMERS, would then pass.
 *
 * MAY BE EMPTY: a brief that lists no word, with a kind ending on "company". No record
 * could then ever be evidenced, and unreachablePeerKinds reports the kind.
 */
export function peerEvidenceWords(brief: Pick<OutboundBrief, 'generic_kind_words'>, kind: string): Set<string> {
  const head = wordsOf(kind).pop()
  const saysSomething = (word: string) => !kindIsGeneric(`a ${word}`, new Set())
  return new Set([
    ...(brief.generic_kind_words ?? []).map(word => word.toLowerCase().trim()).filter(word => word && saysSomething(word)),
    ...(head && saysSomething(head) ? [head] : []),
  ])
}

/** The first evidence word a text holds anywhere in it, as the text writes it. For a NAME, and for a stored kind. */
export function peerEvidenceIn(text: string | null | undefined, evidenceWords: ReadonlySet<string>): string | undefined {
  return text ? wordsOf(text).find(word => isClientGeneric(word, evidenceWords)) : undefined
}

/**
 * A plain plural as its singular: "firms", "agencies", "taxes". A word that is not one comes
 * back as it is. Moved here from brief.ts on 2026-10-02 (round two), so the label echo test
 * there, the keyword rule and the stored fact's veto fold a plural the same way.
 */
export function singularOf(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 4 && /(?:ch|sh|x|ss|z)es$/.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1)
  return word
}

/** The words of a kind, articles left out and each plural read as its singular. */
const kindWords = (kind: string) => wordsOf(kind).filter(word => word !== 'an' && word !== 'the').map(singularOf)

/**
 * DOES A KIND OF FIRM STORED FROM THE PROSPECT'S OWN SITE CONTRADICT THE KIND THE RECORD
 * GIVES? For the veto on the peer rung at composition (decideFirmFactEmail1). True, and the
 * line is not written, when the stored kind is not the brief's kind for this record AND
 * either:
 *
 *   - it holds none of the evidence words (peerEvidenceWords): "a recruitment agency" under
 *     "an HR consultancy";
 *   - or it shares none of the words that stand BEFORE the brief kind's head noun ("HR" in
 *     "an HR consultancy", "management" in "a management consultancy"). Added in round two
 *     of the review (2026-10-02): "a recruitment consultancy", "an IT consultancy" and "a
 *     financial advisory firm" each hold an evidence word, and each is another trade.
 *   - or it holds a word of another trade beside the shared one ("an HR recruitment
 *     consultancy" under "an HR consultancy"): a word that is not in the brief's kind, not
 *     evidence, not grammar, and not one the generic-kind test reads as empty.
 *
 * The same kind is matched in any case, with articles left out and plurals folded: "HR
 * consultancies" agrees with "an HR consultancy". A kind with no word before its head
 * ("a consultancy") has nothing to share, so every other stored kind contradicts it. That
 * fails closed, which is the direction this check is for: a veto sends the prospect to the
 * template, never to another sentence.
 */
export function storedKindContradicts(brief: Pick<OutboundBrief, 'generic_kind_words'>, briefKind: string, storedKind: string): boolean {
  const brief_ = kindWords(briefKind)
  const stored = kindWords(storedKind)
  if (stored.join(' ') === brief_.join(' ')) return false
  // A kind that names nothing ("a professional firm") says no other trade: it cannot
  // contradict (merge review, 2026-10-02, read from a real prospect's stored fact).
  if (kindIsGeneric(storedKind.trim(), new Set())) return false
  if (!peerEvidenceIn(storedKind, peerEvidenceWords(brief, briefKind))) return true
  const beforeHead = new Set(brief_.slice(0, -1))
  if (!stored.some(word => beforeHead.has(word))) return true
  // A word of ANOTHER TRADE beside the shared one: "an HR recruitment consultancy" under
  // "an HR consultancy" (merge review, 2026-10-02). Any stored word that is not in the
  // brief's kind, not an evidence word, not grammar, and not a word the generic-kind test
  // already reads as saying nothing ("boutique", "independent", "firm") names something the
  // brief's kind does not. Fails closed: "an HR and payroll consultancy" is vetoed too.
  const evidence = peerEvidenceWords(brief, briefKind)
  const briefSet = new Set(brief_)
  return stored.some(word =>
    !briefSet.has(word) && !KIND_GRAMMAR_WORDS.has(word) && !isClientGeneric(word, evidence)
    && !kindIsGeneric(`a ${word}`, new Set()))
}

/** Words inside a kind that join or relate, and name nothing: "an HR and payroll consultancy". */
const KIND_GRAMMAR_WORDS = new Set(['and', 'of', 'for', 'in', 'to', 'with', 'on', 'at', 'by'])

/**
 * Words that make a keyword a phrase ABOUT something, not the name of a kind of firm.
 * "4" is "for" as a keyword writes it. Round two of the review (2026-10-02) added in, by,
 * via, from, on, at and 4: "software by consultant" and "specialists in consulting" passed.
 */
const KEYWORD_JOINING_WORDS = new Set(['for', 'to', 'of', 'with', 'and', 'in', 'by', 'via', 'from', 'on', 'at', '4'])
/** Marks that join two things in a keyword: "training & consulting", "crm/consultant", "crm + consultant", "saas | consultant", "crm, consultant". */
const KEYWORD_JOINING_MARKS = /[&/+|,]/
const KEYWORD_MAX_WORDS = 3

/**
 * The evidence word of a KEYWORD, when the keyword is itself a description of the kind of
 * firm: at most three words, its last word an evidence word IN THE SINGULAR, no joining
 * word, no joining mark, and no word ending in a hyphen ("crm- consultant"). See WHAT
 * COUNTS AS EVIDENCE in the header.
 */
function peerEvidenceInKeyword(tag: string, evidenceWords: ReadonlySet<string>): string | undefined {
  if (KEYWORD_JOINING_MARKS.test(tag)) return undefined
  if (tag.split(/\s+/).some(word => word.endsWith('-'))) return undefined
  const words = tag.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (words.length === 0 || words.length > KEYWORD_MAX_WORDS) return undefined
  if (words.some(word => KEYWORD_JOINING_WORDS.has(word))) return undefined
  const last = words[words.length - 1]
  // A PLURAL NEVER COUNTS (round two): "hr consultants", "financial advisors" and
  // "freelance consultants" on a software maker's record name its customers or users.
  if (singularOf(last) !== last) return undefined
  return isClientGeneric(last, evidenceWords) ? last : undefined
}

/**
 * The opener for the broadest rung, or why there is none.
 *
 * The verb is always "run": a kind in the brief names a firm (see PeerGroup.kind), and the
 * brief validator holds its form.
 */
export function peerKindFor(brief: OutboundBrief, record: PeerKindRecord | null | undefined): PeerKindDecision {
  if (!record) return { ok: false, reason: 'no_record' }
  if (!record.industry || !record.industry.trim()) return { ok: false, reason: 'no_stored_industry' }
  const industry = canonicalIndustryExact(record.industry)
  if (!industry) return { ok: false, reason: 'industry_not_in_static_table' }
  const group = brief.peer_groups.find((pg: PeerGroup) =>
    typeof pg.kind === 'string' && pg.kind.trim() && typeof pg.industry === 'string' && pg.industry.trim().toLowerCase() === industry.toLowerCase())
  if (!group || !group.kind) return { ok: false, reason: 'no_kind_for_industry' }

  const kind = group.kind.trim()
  const evidenceWords = peerEvidenceWords(brief, kind)
  const inName = peerEvidenceIn(record.name, evidenceWords)
  const inTag = inName ? undefined : record.tags.map(tag => peerEvidenceInKeyword(tag, evidenceWords)).find((word): word is string => !!word)
  const word = inName ?? inTag
  if (!word) return { ok: false, reason: 'kind_not_evidenced' }

  return {
    ok: true,
    does: `you run ${kind}`,
    peer_group_id: group.id,
    label: group.label,
    kind,
    industry,
    evidence: { word, found_in: inName ? 'name' : 'tag' },
  }
}

/**
 * Peer kinds in a brief that could never be used, with why. Such a line is born dark: it
 * validates, it is stored, and no prospect ever receives it. Two ways:
 *
 *   - its industry is one the lookup never returns;
 *   - NO WORD COULD EVER EVIDENCE IT (added 2026-10-02): the brief lists no word that names
 *     a kind of firm and the kind ends on a plain word for "a firm", so peerEvidenceWords is
 *     empty and every record is refused as kind_not_evidenced.
 *
 * Reported where a person can fix it: by the brief validator, which runs free, and again
 * at generation.
 */
export function unreachablePeerKinds(brief: OutboundBrief, canonicalIndustries: readonly string[]): string[] {
  const known = new Set(canonicalIndustries.map(name => name.toLowerCase()))
  return brief.peer_groups
    .filter(pg => typeof pg.kind === 'string' && pg.kind.trim())
    .flatMap(pg => {
      if (typeof pg.industry !== 'string' || !known.has(pg.industry.trim().toLowerCase())) {
        return [`${pg.id}: its kind can never be used, because ${typeof pg.industry === 'string' && pg.industry.trim() ? `"${pg.industry}" is not` : 'it has no industry, and that is not'} a canonical industry name a stored industry can resolve to`]
      }
      if (peerEvidenceWords(brief, pg.kind!).size === 0) {
        return [`${pg.id}: its kind can never be used, because no word could say a firm is "${pg.kind!.trim()}": generic_kind_words holds no word that names a kind of firm, and the kind ends on a word that is true of any firm. List the words in generic_kind_words, or end the kind on a noun that says something ("... consultancy", "... studio")`]
      }
      return []
    })
}
