// Back-reference detection for generated email copy.
//
// WHY THIS EXISTS
// Email 1 paragraph 2 is a SLOT. Composition replaces it with a researched observation
// whenever one exists, so no later paragraph may depend on it. Variant D shipped this:
//
//   P2  "Referrals feel like the safe channel. But they're not a pipeline. They're a
//        ceiling. The size of your network sets your revenue cap..."
//   P3  "We break that ceiling by running outbound that puts the right conversations
//        in your diary."
//
// With a real observation swapped into P2 the email reads: "You ran Taffet and the CRC
// Director role side by side for 13 months. That wrapped in August 2025. We break that
// ceiling by..." There is no ceiling. The better the personalisation, the more broken
// the email.
//
// The existing BANNED_PARAGRAPH_OPENERS list missed it because that list only matches
// patterns at the START of a paragraph. "that ceiling" sits mid-sentence, four words in.
//
// TWO SIGNALS, DELIBERATELY TREATED DIFFERENTLY:
//
//   HARD FAIL — a demonstrative determiner (that/this/those/these/such) binding a noun.
//   "that ceiling", "this pattern", "those meetings", "such firms". A demonstrative
//   pointing at a noun has to point at something, and the only thing before it is a
//   paragraph that may not survive composition.
//
//   REPORT ONLY — definite articles. "the gap between projects" leans on P2 the same way,
//   but "without you touching the outreach" is perfectly fine and extremely common. The
//   signal cannot separate the two, so gating on it would reject good copy. Counted and
//   surfaced for a human, never enforced.
//
// Deterministic by design (ADR-018). Pattern matching on predictable text, no LLM.

export const DEMONSTRATIVES = ['that', 'this', 'those', 'these', 'such'] as const

// Words that, following a demonstrative, prove it is NOT binding a noun.
//
// This is the whole false-positive story. English reuses "that" as a complementiser
// ("the assumption is that doing more fixes it"), a relative pronoun ("outbound that
// puts conversations in your diary") and a standalone pronoun ("Does that sound like
// where you are?"). All three are harmless and all three are common in this copy. Only
// the determiner use, where a demonstrative binds a following noun, is a back-reference.
//
// Without a part-of-speech tagger the reliable deterministic proxy is: a demonstrative
// followed by a verb, auxiliary, preposition, pronoun, article or adverb is not a
// determiner. Everything else is treated as a noun.
//
// The list is biased toward avoiding false POSITIVES, because this is a HARD gate and a
// wrongly rejected variant costs a regeneration. The cost is occasional false negatives:
// "that work" is missed because "work" is listed as a verb. A missed back-reference is
// caught by the prompt rule and by review; a wrongly rejected good variant is not.
const NON_NOUN_FOLLOWERS = new Set([
  // Auxiliaries and copulas
  'is', 'isn', 'was', 'wasn', 'are', 'aren', 'were', 'weren', 'be', 'been', 'being',
  'has', 'hasn', 'have', 'haven', 'had', 'hadn',
  'do', 'does', 'doesn', 'did', 'didn', 'don',
  'will', 'won', 'would', 'wouldn', 'can', 'cannot', 'could', 'couldn',
  'should', 'shouldn', 'shall', 'may', 'might', 'must',
  // Common verbs that follow a pronoun demonstrative
  'sound', 'sounds', 'sounded', 'seem', 'seems', 'seemed', 'mean', 'means', 'meant',
  'work', 'works', 'worked', 'happen', 'happens', 'happened',
  'change', 'changes', 'changed', 'matter', 'matters', 'mattered',
  'apply', 'applies', 'applied', 'come', 'comes', 'came', 'go', 'goes', 'went',
  'get', 'gets', 'got', 'make', 'makes', 'made', 'take', 'takes', 'took',
  'keep', 'keeps', 'kept', 'look', 'looks', 'looked', 'feel', 'feels', 'felt',
  'say', 'says', 'said', 'tell', 'tells', 'told', 'show', 'shows', 'showed',
  'leave', 'leaves', 'left', 'land', 'lands', 'landed', 'stop', 'stops', 'stopped',
  'run', 'runs', 'ran', 'break', 'breaks', 'broke', 'fit', 'fits', 'help', 'helps',
  'put', 'puts', 'give', 'gives', 'gave', 'bring', 'brings', 'brought',
  'start', 'starts', 'started', 'end', 'ends', 'ended', 'cost', 'costs',
  'tend', 'tends', 'need', 'needs', 'want', 'wants',
  // Gerunds after a complementiser "that"
  'doing', 'being', 'having', 'getting', 'making', 'running', 'sending', 'writing',
  'working', 'fixing', 'building',
  // Articles, pronouns, determiners
  'a', 'an', 'the', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'one', 'ones', 'someone', 'everyone', 'nobody',
  // Indefinite pronouns. "Is this something you're trying to fix?" is a standard CTA and
  // reads correctly after any P2, so it must not be treated as a back-reference.
  'something', 'anything', 'nothing', 'everything',
  'most', 'many', 'much', 'all', 'some', 'any', 'every', 'no', 'none',
  // Prepositions and conjunctions
  'of', 'to', 'in', 'on', 'for', 'with', 'from', 'at', 'by', 'as',
  'and', 'or', 'but', 'if', 'when', 'while', 'because', 'so', 'than', 'then',
  'who', 'which', 'what', 'where', 'how', 'why', 'whether',
  // Adverbs and negations
  'not', 'never', 'just', 'only', 'still', 'always', 'often', 'usually', 'typically',
  'first', 'again', 'too', 'also', 'instead', 'anyway', 'though', 'yet', 'now',
  'here', 'there', 'back', 'properly', 'entirely', 'altogether', 'completely', 'quickly',
])

// Demonstrative + noun pairs that are idiomatic time or stage references rather than
// back-references. "at this stage" and "founders in that position" point at the
// prospect's circumstances, not at the paragraph above. Kept deliberately short: every
// entry here is a hole in the gate.
const IDIOMATIC_NOUNS = new Set([
  'stage', 'point', 'position', 'spot', 'days', 'week', 'month', 'year',
])

export interface BackReferenceHit {
  /**
   * Position in the body counting the {{first_name}} greeting as paragraph 1, so the
   * number matches the documented P1..P5 frame: P2 is the observation slot, P3 is what
   * changes. Reported this way in every email, since all four open with the greeting.
   */
  paragraph: number
  /** The demonstrative, lowercased. */
  demonstrative: string
  /** The noun it binds. */
  noun: string
  /** The two-word phrase as written. */
  phrase: string
}

export interface DefiniteArticleHit {
  paragraph: number
  phrase: string
}

export interface BackReferenceReport {
  /** Demonstrative-plus-noun back-references. HARD FAIL: any hit rejects the variant. */
  demonstratives: BackReferenceHit[]
  /** Definite-article phrases. REPORT ONLY: never gates, surfaced for a human. */
  definiteArticles: DefiniteArticleHit[]
}

// Splits a body into content paragraphs, dropping the {{first_name}} greeting chunk so
// paragraph numbering matches the P1..P5 frame used everywhere else.
export function contentParagraphs(body: string): string[] {
  return body
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .filter(p => !/^\{\{first_name\}\},?\s*$/.test(p))
}

/**
 * Scans paragraphs 2 onward for back-references.
 *
 * Paragraph 1 is exempt: in Email 1 it IS the slot that gets replaced, and a
 * demonstrative inside it can only refer to something in its own text, which always
 * ships together with it.
 */
export function findBackReferences(body: string): BackReferenceReport {
  const paras = contentParagraphs(body)
  const demonstratives: BackReferenceHit[] = []
  const definiteArticles: DefiniteArticleHit[] = []

  // Normalise curly apostrophes so "that's" is recognised and skipped consistently.
  const normalise = (s: string) => s.replace(/[''ʼ‘’]/g, "'")

  for (let i = 1; i < paras.length; i++) {
    const para = normalise(paras[i])
    // +2, not +1: contentParagraphs dropped the greeting, which is paragraph 1 of the body.
    // This makes index 1 report as P3, the "what changes" paragraph in the frame.
    const paragraphNumber = i + 2

    // A demonstrative followed by whitespace then a word. "that's" never matches,
    // because an apostrophe follows the demonstrative rather than whitespace.
    const demoRe = /\b(that|this|those|these|such)\s+([A-Za-z][A-Za-z-]*)/gi
    let m: RegExpExecArray | null
    while ((m = demoRe.exec(para)) !== null) {
      const demonstrative = m[1].toLowerCase()
      const noun = m[2].toLowerCase()
      if (NON_NOUN_FOLLOWERS.has(noun)) continue
      if (IDIOMATIC_NOUNS.has(noun)) continue
      demonstratives.push({
        paragraph: paragraphNumber,
        demonstrative,
        noun,
        phrase: `${m[1]} ${m[2]}`,
      })
    }

    // Report-only. Never gates: "without you touching the outreach" is good copy.
    const theRe = /\bthe\s+([A-Za-z][A-Za-z-]*)/gi
    while ((m = theRe.exec(para)) !== null) {
      definiteArticles.push({ paragraph: paragraphNumber, phrase: `the ${m[1]}` })
    }
  }

  return { demonstratives, definiteArticles }
}
