// Flesch-Kincaid reading grade for customer-facing copy.
//
// WHY THIS IS A SEPARATE MODULE FROM readability.ts
// readability.ts already owns a different question: is this sentence too long, does it
// hedge, is it dense with nominalisations. Those are SHAPE checks on a single observation.
// This file asks one number: what school grade does a reader need to follow this prose.
// They disagree usefully. A 12-word sentence with no hedges passes readability.ts and can
// still score grade 11 because every word in it is Latinate. Keeping them apart means
// neither check has to pretend to be the other.
//
//   FKGL = 0.39 * (words/sentences) + 11.8 * (syllables/words) - 15.59
//
// The only judgement call in the formula is the syllable counter, so it carries a
// known-answer test built from words that ACTUALLY APPEAR in the corpus being measured,
// not from a generic word list. A grade produced by an unvalidated syllable counter is a
// measurement of the counter, not of the prose.
//
// The counter was built by auditing the corpus vocabulary (1,061 distinct words) against
// the heuristic and fixing what disagreed. Five classes of error were found and each is
// fixed by a RULE rather than a per-word patch, except the genuine compounds at the
// bottom, which are lexical and have no rule.
//
// Deterministic (ADR-018). Counting syllables is arithmetic on predictable text, not
// judgement, so no LLM is involved.
//
// PROVENANCE: implemented read-only on 2026-09-22 in .writer-export/analysis-20260922/fk.ts
// and promoted here unchanged in logic, so every grade measured during that analysis is
// reproducible by this module.

export function splitSentencesFk(text: string): string[] {
  return text
    // Newlines become spaces, so a paragraph break does NOT by itself end a sentence.
    // Terminal punctuation does. This is deliberate and it is safe on email bodies for a
    // measured reason: after emailProse() strips the greeting and the two sign-off lines,
    // every remaining paragraph in all 16 live template emails ends in '.' or '?', so
    // nothing fuses. The only two unterminated paragraphs are exactly the two that are
    // stripped before scoring.
    //
    // If an unterminated prose paragraph ever did appear, it would fuse with the next one
    // and push words-per-sentence, and therefore the grade, UP. The gate would reject copy
    // it should have passed. That direction is the tolerable one for a hard gate, so this
    // is left as it is rather than guessing sentence boundaries from layout.
    .replace(/\n{2,}/g, ' ')
    .replace(/\n/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => /[A-Za-z]/.test(s))
}

export function wordsOf(text: string): string[] {
  return text
    .replace(/[‘’]/g, "'")
    // Hyphens and dashes separate words: "founder-led" is two words and three syllables,
    // not one word and two. Underscores likewise, for the {{first_name}} merge tag.
    .split(/[\s\-—–_/]+|--+/)
    .map(w => w.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, ''))
    .filter(w => /[A-Za-z0-9]/.test(w))
}

// Numerals are read aloud, so "2018" is four syllables (twen-ty-eigh-teen) not zero.
// Approximated by digit count, which is what FK tooling that handles numerals does.
function numeralSyllables(token: string): number {
  const digits = token.replace(/\D/g, '').length
  return Math.max(1, digits)
}

// Genuine compounds and irregulars. NO RULE REACHES THESE: an internal silent 'e' in a
// compound ("pipeline" = pipe+line) is structurally identical to a pronounced one
// ("delivery" = de-liv-er-y), so the only honest handling is a list.
const EXCEPTIONS: Record<string, number> = {
  pipeline: 2, pipelines: 2, linkedin: 2, coordination: 5,
  client: 2, clients: 2, quiet: 2, science: 2, diet: 2,
  business: 2, businesses: 3, every: 2, people: 2,
  idea: 3, ideas: 3, being: 2, doing: 2, going: 2, seeing: 2,
  ocean: 2, real: 1, hour: 1, hours: 1, our: 1, ours: 1, poem: 2,
  create: 2, creates: 2, created: 3, creating: 3, creation: 3,
  lion: 2, million: 3, billion: 3, opinion: 3, union: 2, onion: 2,
}

// Consonant-initial suffixes. A silent 'e' immediately in front of one behaves exactly
// like a terminal silent 'e': "engage" + "ment" is 2 + 1, not 4. This one rule fixes
// engagement, actively, rarely, entirely, statement, movement and something.
const SUFFIXES: Array<[string, number]> = [
  ['ments', 1], ['ment', 1], ['ness', 1], ['less', 1], ['ful', 1],
  ['things', 1], ['thing', 1], ['ly', 1],
]

function countStem(word: string): number {
  if (EXCEPTIONS[word] !== undefined) return EXCEPTIONS[word]

  let count = (word.match(/[aeiouy]+/g) ?? []).length

  // "ia" and "ua" are two syllables (di-a-ry, u-su-al), EXCEPT after the letters that
  // make them one: -tial, -cial, -sial, -xial, and gua-/qua-.
  count += (word.match(/[^tcsx]ia/g) ?? []).length
  count += (word.match(/[^gq]ua/g) ?? []).length

  // Terminal 'e'.
  if (word.length > 2 && word.endsWith('e') && !word.endsWith('ee') && !word.endsWith('ye')) {
    if (word.endsWith('le')) {
      // "-le" is its own syllable only after a CONSONANT: ta-ble, lit-tle, cir-cle.
      // After a vowel the 'e' is silent: role, while, whole, mile.
      if (/[aeiou]le$/.test(word)) count -= 1
    } else if (/[^aeiou]e$/.test(word)) {
      count -= 1
    }
  }
  // "-ed" is silent except after t or d: "walked" is 1, "wanted" is 2.
  if (word.length > 3 && word.endsWith('ed') && !/[td]ed$/.test(word) && /[^aeiouy]ed$/.test(word)) {
    count -= 1
  }
  // "-es" is silent after a non-sibilant: "makes" is 1, "watches" and "practices" are 2 and 3.
  if (
    word.length > 3 &&
    word.endsWith('es') &&
    !/(s|sh|ch|x|z|g|c|ce|se)es$/.test(word) &&
    /[^aeiouy]es$/.test(word)
  ) {
    count -= 1
  }

  return Math.max(1, count)
}

export function syllables(token: string): number {
  const raw = token.toLowerCase()
  if (/^\d+$/.test(raw)) return numeralSyllables(raw)
  let word = raw.replace(/[^a-z]/g, '')
  if (!word) return numeralSyllables(raw)
  if (EXCEPTIONS[word] !== undefined) return EXCEPTIONS[word]

  // Peel consonant-initial suffixes so the stem's terminal-'e' rule can fire.
  let extra = 0
  let peeled = true
  while (peeled && word.length > 4) {
    peeled = false
    for (const [suf, n] of SUFFIXES) {
      if (word.endsWith(suf) && word.length - suf.length >= 3) {
        word = word.slice(0, -suf.length)
        extra += n
        peeled = true
        break
      }
    }
  }

  return Math.max(1, countStem(word) + extra)
}

export interface ReadingGrade {
  grade: number
  words: number
  sentences: number
  syllables: number
  wordsPerSentence: number
  syllablesPerWord: number
}

/**
 * Returns null for text with no sentences or no words, which is a REFUSAL rather than a
 * grade of zero. A caller that treats null as "passes" would let empty prose through a
 * gate; a caller that treats it as 0 would report a suspiciously good grade. Both are
 * wrong in ways the caller has to decide about, so this does not decide for them.
 */
export function fleschKincaidGrade(text: string): ReadingGrade | null {
  const sents = splitSentencesFk(text)
  const allWords = sents.flatMap(wordsOf)
  if (sents.length === 0 || allWords.length === 0) return null
  const syl = allWords.reduce((a, w) => a + syllables(w), 0)
  const wps = allWords.length / sents.length
  const spw = syl / allWords.length
  return {
    grade: 0.39 * wps + 11.8 * spw - 15.59,
    words: allWords.length,
    sentences: sents.length,
    syllables: syl,
    wordsPerSentence: wps,
    syllablesPerWord: spw,
  }
}

// The grade ceiling for EMAILS 2 TO 4. Prose only: the greeting and the two sign-off lines
// are removed by emailProse() before the grade is taken, because they are fixed text
// identical on every email and would flatter every email equally.
//
// 8, RAISED FROM 5 ON 2026-09-23, AND THE REASON IS THE POINT OF THIS CONSTANT.
//
// 5 was chosen against a benchmark: the line from a campaign that replied at 7 percent
// scores 3.68. That is an IDEAL. This number is now set from what the operator has actually
// APPROVED, which is a different and more honest question for a hard gate to answer.
//
// Measured on v6's twelve approved emails 2 to 4, on this exact surface: they run 3.95 to
// 7.84, worst is B/Email 3 at 7.84, so the ceiling is 8. Every line of approved copy passes
// and anything worse than the worst approved line fails.
//
// WHAT 5 DID WHEN IT WAS APPLIED HERE, and why an ideal was the wrong instrument. Together
// with a 15-word sentence cap it drove emails 2 to 4 to grade 1.70 to 2.99, which is ten
// clipped sentences in a row. It reads worse than the copy it replaced. Two separate costs:
// the email itself is worse, and the FOLLOW-UP WRITER takes its tone from these templates,
// so choppy templates produce choppy generated follow-ups for every prospect.
//
// Email 1 is deliberately NOT governed by this. It keeps the stricter 6, because Email 1 is
// the one a stranger reads cold with no prior message, and it is the only one whose
// observation slot is replaced per prospect.
export const MAX_READING_GRADE = 8

/**
 * Email 1's grade ceiling, which is ONE GRADE LOOSER than the other three carry.
 *
 * DECIDED IN ADVANCE OF THE RUN THAT TRIGGERED IT, which is the only reason it is a rule
 * rather than a rationalisation. The standing instruction was: hold 5, and if the best
 * Email 1 per variant lands between 5.0 and 6.0 after the 12-word sentence cap, take 6 for
 * Email 1 only and land what passes.
 *
 * MEASURED on the run of 2026-09-22, nine attempts, best Email 1 per variant:
 *   A 5.36   B 3.92   C 3.60   D 5.08
 * Two already clear 5. The two that do not sit inside the band, and nothing is above 6.
 *
 * WHY EMAIL 1 AND NOT THE REST. Email 1 carries four fixed jobs in 40 to 90 words: an
 * observation, a consequence, an offer line and a question. Emails 2 to 4 carry one idea
 * each and no frame, which is why they were already passing at 5 while Email 1 was not.
 * The extra grade is bought by structure Email 1 cannot shed, not by weaker writing.
 */
export const EMAIL1_MAX_READING_GRADE = 6

/**
 * The ceiling for one position. A function rather than a lookup table, because a table is a
 * second list that has to stay in step with the four positions by hand.
 *
 * The gap between the two is now THREE grades, not one, and that is deliberate rather than
 * drift: 6 for Email 1 is an ideal the copy is held to, 8 for emails 2 to 4 is the measured
 * floor of what has already been approved. They answer different questions and are allowed
 * to be far apart.
 */
export function readingGradeCapFor(sequencePosition: number): number {
  return sequencePosition === 1 ? EMAIL1_MAX_READING_GRADE : MAX_READING_GRADE
}

// The known-answer controls for the syllable counter. Every word below the separator
// appears in the measured template corpus, so this exercises what the instrument is
// actually pointed at rather than a generic word list.
export const SYLLABLE_CONTROL_WORDS: ReadonlyArray<readonly [string, number]> = [
  ['the', 1], ['cat', 1], ['sat', 1], ['on', 1], ['mat', 1],
  ['implementation', 5], ['comprehensive', 4], ['organisational', 6],
  ['restructuring', 4], ['necessitates', 4], ['considerable', 5],
  ['administrative', 5], ['coordination', 5],
  ['make', 1], ['makes', 1], ['walked', 1], ['wanted', 2], ['watches', 2],
  ['table', 2], ['little', 2],
  // Corpus vocabulary, in descending frequency.
  ['margenticos', 4], ['outbound', 2], ['diary', 3], ['prospecting', 3],
  ['meetings', 2], ['without', 2], ['qualified', 3], ['touching', 2],
  ['reply', 2], ['something', 2], ['pipeline', 2], ['outreach', 2],
  ['delivery', 4], ['running', 2], ['consulting', 3], ['working', 2],
  ['founders', 2], ['linkedin', 2], ['engagement', 3], ['engagements', 3],
  ['conversations', 4], ['role', 1], ['while', 1], ['whole', 1],
  ['referrals', 3], ['actively', 3], ['rarely', 2], ['alongside', 3],
  ['existing', 3], ['practice', 2], ['practices', 3], ['deployment', 3],
  ['usually', 4], ['people', 2], ['entirely', 3], ['relationships', 4],
  ['businesses', 3], ['advisory', 4], ['facilitation', 5], ['circle', 2],
  ['client', 2], ['clients', 2], ['introductions', 4], ['leadership', 3],
  ['attention', 3], ['solutions', 3], ['services', 3], ['published', 2],
  ['2018', 4], ['35', 2],
] as const

// SIMPLE. 6 words, 1 sentence, 6 syllables.
//   0.39*6 + 11.8*1.0 - 15.59 = 2.34 + 11.80 - 15.59 = -1.45
export const CONTROL_SIMPLE = 'The cat sat on the mat.'
export const CONTROL_SIMPLE_GRADE = -1.45

// COMPLEX. 10 words, 1 sentence, 40 syllables by hand:
//   The(1) implementation(5) of(1) comprehensive(4) organisational(6)
//   restructuring(4) necessitates(4) considerable(5) administrative(5) coordination(5)
//   0.39*10 + 11.8*4.0 - 15.59 = 3.90 + 47.20 - 15.59 = 35.51
export const CONTROL_COMPLEX =
  'The implementation of comprehensive organisational restructuring necessitates considerable administrative coordination.'
export const CONTROL_COMPLEX_GRADE = 35.51

// MID-RANGE. Two extremes can both pass on an instrument that is monotonic but wrongly
// scaled, so the third control sits in the middle. This is the benchmark line from the
// 7-percent-reply campaign quoted in readability.ts:
//   "Read through your last 30 reviews on Google." 8w / 1s
//     Read(1) through(1) your(1) last(1) 30(2) reviews(2) on(1) Google(2) = 11
//   "Front desk hold times keep coming up, 4 of the most recent 10." 13w / 1s
//     Front(1) desk(1) hold(1) times(1) keep(1) coming(2) up(1) 4(1) of(1)
//     the(1) most(1) recent(2) 10(2) = 16
//   total 21w / 2s / 27syl -> 0.39*10.5 + 11.8*(27/21) - 15.59
//                           = 4.095 + 15.171 - 15.59 = 3.68
export const CONTROL_BENCHMARK =
  'Read through your last 30 reviews on Google. Front desk hold times keep coming up, 4 of the most recent 10.'
export const CONTROL_BENCHMARK_GRADE = 3.68
