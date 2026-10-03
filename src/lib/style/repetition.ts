// Words and phrases said too often for a reader who gets four short emails in a row.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE RULE (operator note 3 on the fifth reading, 2026-10-02)
//
// "No phrase repeated more than twice across a sequence, and no word repeated in
// consecutive sentences ('hard to plan' then 'harder to plan')."
//
// Both were visible in the sequences he read. One variant said "good-fit buyers" five
// times across its four emails. One Email 2 closed a sentence on "hard to plan" and opened
// the next paragraph with "harder to plan". Each email passed every rule on its own: the
// fault only exists across sentences and across emails, and nothing read across them.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT COUNTS
//
// A PHRASE is two or three words in a row that open and close on a word with meaning of
// its own ("good-fit buyers", "new clients", "hard to plan"). A hyphen joins two words, so
// "good-fit" and "a good fit" are the same phrase. A plural and its singular are one word.
// A phrase inside a longer phrase that is already reported the same number of times is not
// reported twice. It is NAMED as the copy first wrote it ("sales teams overseas"), never as
// the trimmed forms it was counted by ("sale team oversea"): the name is read by the writer,
// who has to find it in a line.
//
// A WORD, for the consecutive-sentence rule, is one of four letters or more that is not on
// the list of small words below. Two forms of one word count as the same word ("hard" and
// "harder", "grow" and "growth", "scale" and "scaling"): see sameWord, which holds the short
// list of endings that make a form.
//
// WHAT DOES NOT. Small words (the, can, your, more), judged on the word AS WRITTEN: until
// 2026-10-02 the phrase rule trimmed a plural first, so "does" became "doe", which is on no
// list, and "Does that sound ..." three times was reported as the phrase "doe that sound".
// Contractions, which the stiff-wording rule tells the writer to use. "Firm" and "firms",
// which stand where a pronoun would: "Some firms tell us ... So your firm can ..." is the
// shape every follow-up has when no name is held. Words of three letters or fewer.
//
// RULE ZERO. Plain English, no market's wording: the lists hold grammar, not trades.
//
// KNOWN LIMITS. A form is known by its ending, and an ending cannot tell a form from a
// different word that happens to end the same way. So ANY word that equals another word plus
// a listed ending is read as a form of it: "hard" and "harder" rightly, and wrongly "lead"
// and "leader", "sell" and "seller", "corn" and "corner", "custom" and "customer", "form"
// and "former", "good" and "goods", "mean" and "means" (review, 2026-10-02). Only ONE ending
// is taken from each word, so "leads" and "leaders", "accounts" and "accountants" are two
// words. The cost of a false match is a line reworded that did not need it.
//
// And the other way: a stem must be four letters, so two forms of a THREE-letter stem are
// never matched ("runs" and "running", "wins" and "winning", "buys" and "buying", "uses"
// and "using"). The rule before 2026-10-02 missed these too. The cost of that miss is a
// repeat sent.

import { PAIRS as STIFF_PAIRS } from './stiff-forms'

/** Words that carry grammar and no subject of their own. */
const SMALL_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'so', 'if', 'when', 'then', 'than', 'that', 'this', 'these', 'those',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'into', 'over', 'out', 'up', 'down', 'about',
  'after', 'before', 'while', 'because', 'since', 'until', 'through', 'between', 'without', 'within',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'have', 'has', 'had',
  'can', 'could', 'may', 'might', 'will', 'would', 'should', 'must', 'shall',
  'it', 'its', 'they', 'them', 'their', 'theirs', 'you', 'your', 'yours', 'we', 'our', 'ours', 'us', 'i', 'me', 'my',
  'he', 'she', 'him', 'her', 'his', 'who', 'whom', 'whose', 'what', 'which', 'where', 'why', 'how',
  'not', 'no', 'more', 'most', 'less', 'very', 'too', 'also', 'just', 'there', 'here', 'often', 'sometimes',
  'some', 'any', 'each', 'few', 'both', 'all', 'many', 'much', 'such', 'same', 'other', 'another', 'own',
  'again', 'once', 'ever', 'even', 'still', 'only', 'like', 'make', 'makes', 'made', 'get', 'gets', 'got',
  'tell', 'tells', 'told', 'say', 'says', 'said',
  // Contractions, as they read once the apostrophe is kept inside the word.
  //
  // BUILT FROM THE STIFF-WORDING RULE'S OWN LIST, so the two cannot drift. That rule refuses
  // "have not" and tells the writer to write "haven't". Until 2026-10-02 this list was typed
  // out by hand and was nine short of it (haven't, hasn't, wasn't, weren't, wouldn't,
  // couldn't, shouldn't, what's, here's), so a writer who obeyed one rule in two sentences
  // in a row was refused by this one, and each refusal is a paid repair call.
  ...STIFF_PAIRS.map(([, contraction]) => contraction.toLowerCase()),
  // Ones no stiff pair writes out, which read as small words all the same.
  "you'd", "we'd", "now's",
  // What stands for the reader or the reader's peers where a name or a pronoun would.
  'firm', 'firms',
])

/** One word in the form it is counted in: lower case, a plain plural read as its singular. */
function countedForm(word: string): string {
  const w = word.toLowerCase()
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 3 && w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) return w.slice(0, -1)
  return w
}

/** The words of a text, in order. A hyphen and a slash separate words; an apostrophe does not. */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\{\{?[a-z_]+\}?\}/g, ' ')
    .split(/[^a-z0-9']+/)
    .map(word => word.replace(/^'+|'+$/g, ''))
    .filter(Boolean)
}

const hasMeaning = (word: string) => !SMALL_WORDS.has(word) && /[a-z]/.test(word)

export interface RepeatedPhrase {
  phrase: string
  count: number
}

/**
 * Every phrase said more than `max` times across the texts given, most repeated first.
 * The texts are one reader's sequence: a subject and the prose of each email. A phrase
 * never spans two texts, and never spans a sentence end.
 */
export function findRepeatedPhrases(texts: readonly string[], max = 2): RepeatedPhrase[] {
  // Counted by the trimmed forms, so a plural and its singular are one phrase. Named by the
  // words of its first use, so the writer is shown a phrase that is in the copy.
  const counts = new Map<string, { written: string; count: number }>()
  for (const text of texts) {
    for (const sentence of text.split(/[.?!\n]+/)) {
      const words = wordsOf(sentence)
      for (const size of [2, 3]) {
        for (let i = 0; i + size <= words.length; i++) {
          const gram = words.slice(i, i + size)
          // On the word AS WRITTEN: "does" is a small word, and its trimmed form is not.
          if (!hasMeaning(gram[0]) || !hasMeaning(gram[size - 1])) continue
          const key = gram.map(countedForm).join(' ')
          const seen = counts.get(key)
          if (seen) seen.count++
          else counts.set(key, { written: gram.join(' '), count: 1 })
        }
      }
    }
  }
  const over = [...counts.entries()].filter(([, { count }]) => count > max).map(([key, { written, count }]) => ({ key, phrase: written, count }))
  // A phrase inside a longer one reported as often says nothing the longer one did not.
  const reported = over.filter(short => !over.some(long =>
    long.key !== short.key && long.count >= short.count && ` ${long.key} `.includes(` ${short.key} `)))
  return reported
    .sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase))
    .map(({ phrase, count }) => ({ phrase, count }))
}

/**
 * THE ENDINGS THAT MAKE A FORM OF A WORD, and no others (2026-10-02).
 *
 * Until then two words were "the same" when they shared four opening letters and differed by
 * two letters at most. That called "contract" and "control" one word, and "cleaning" and
 * "clear", "general" and "generate", "quotes" and "quota", "leads" and "leaders", "accounts"
 * and "accountants", "plan" and "plant", "count" and "country", "plant" and "planet". The
 * writer was then told that "control" is said in two sentences in a row, about a pair of
 * sentences that holds it once, and paid a repair call to remove it.
 *
 * A closed list of English grammar, the same for every client. "d" and "r" are not on it by
 * name: they are what "ed" and "er" become after a final e, which is restored below.
 */
const ENDINGS = ['s', 'es', 'ed', 'er', 'est', 'ing', 'ly', 'th'] as const
/** Endings that open on a vowel: before one a final e is dropped and a final consonant may double. */
const VOWEL_ENDINGS: ReadonlySet<string> = new Set(['ed', 'er', 'est', 'ing'])
/** A stem is a word the rule would count on its own: four letters or more. */
const MIN_STEM = 4

/**
 * What a word may be a form of: itself, and what is left when ONE listed ending comes off,
 * with the spelling put back as English changes it:
 *
 *   a dropped final e      scal-ing  -> scale     clos-er  -> close    scal-ed -> scale
 *   a doubled consonant    plann-ing -> plan
 *   y turned to i          steadi-ly -> steady    suppli-es -> supply
 *
 * One ending only. "leaders" gives "leader" and never "lead", so it is not a form of "leads".
 */
function stemsOf(word: string): Set<string> {
  const stems = new Set([word])
  const add = (stem: string) => { if (stem.length >= MIN_STEM) stems.add(stem) }
  for (const ending of ENDINGS) {
    if (!word.endsWith(ending)) continue
    const base = word.slice(0, -ending.length)
    // A plain plural, as countedForm reads one: "business" and "focus" do not end in one.
    if (ending === 's' && /(?:s|u|i)$/.test(base)) continue
    // "es" is the plural only after a hiss or an i ("matches", "supplies"). After anything
    // else the e belongs to the word: "quotes" is "quote", never "quot".
    if (ending === 'es' && !/(?:s|x|z|ch|sh|o|i)$/.test(base)) continue
    add(base)
    if (base.endsWith('i')) add(`${base.slice(0, -1)}y`)
    if (VOWEL_ENDINGS.has(ending)) {
      add(`${base}e`)
      if (/([b-df-hj-np-tv-z])\1$/.test(base)) add(base.slice(0, -1))
    }
  }
  return stems
}

/** Two forms of one word: one listed ending apart from a shared stem. "hard" and "harder", "grow" and "growth". */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true
  const stems = stemsOf(a)
  for (const stem of stemsOf(b)) if (stems.has(stem)) return true
  return false
}

/**
 * The OLD, loose test, by opening letters. Kept for wordsInCommon only. It calls "contract"
 * and "control" one word, which is why the writer's rule no longer uses it, and it also
 * joins pairs no ending does: "consultancy" and "consultants", "export" and "exporters".
 */
function sameWordLoosely(a: string, b: string): boolean {
  if (a === b) return true
  let shared = 0
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++
  return shared >= 4 && shared >= Math.min(a.length, b.length) - 2
}

/**
 * The words two short texts share, as the second writes them. For a line built per
 * prospect: an opener that says "you run an HR consultancy" followed by a pain line that
 * opens "HR consultants tell us" says the same thing in two sentences in a row, and code
 * that fills the slots is the only place that can see it.
 *
 * LOOSE ON PURPOSE, where findConsecutiveRepeats is not. This one only decides whether a
 * label is swapped for the brief's other label. A swap that was not needed costs nothing and
 * reads well; a repeat that was missed is sent. The rule the writer is held to is the other
 * way round: a finding that was not needed is a paid repair call.
 */
export function wordsInCommon(first: string, second: string): string[] {
  return repeatsInARow([first, second], sameWordLoosely).map(repeat => repeat.word)
}

export interface ConsecutiveRepeat {
  /** The word as the second sentence writes it. */
  word: string
  /** Where the first of the two sentences stands in the list given, from 0. */
  index: number
  first: string
  second: string
}

/**
 * Every word that two sentences in a row both use, given the sentences of ONE email in the
 * order the reader meets them (across paragraphs: the last sentence of one paragraph and
 * the first of the next are in a row). One finding per pair of sentences and word.
 */
export function findConsecutiveRepeats(sentences: readonly string[]): ConsecutiveRepeat[] {
  return repeatsInARow(sentences, sameWord)
}

function repeatsInARow(sentences: readonly string[], same: (a: string, b: string) => boolean): ConsecutiveRepeat[] {
  const content = (sentence: string) => wordsOf(sentence).filter(word => word.length >= 4 && hasMeaning(word))
  const found: ConsecutiveRepeat[] = []
  for (let i = 0; i + 1 < sentences.length; i++) {
    const before = content(sentences[i])
    const seen = new Set<string>()
    for (const word of content(sentences[i + 1])) {
      if (seen.has(word)) continue
      if (before.some(earlier => same(earlier, word))) {
        seen.add(word)
        found.push({ word, index: i, first: sentences[i].trim(), second: sentences[i + 1].trim() })
      }
    }
  }
  return found
}
