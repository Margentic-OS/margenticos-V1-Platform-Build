// A phrase said too often across a sequence, and a word said in two sentences in a row.
// Invented copy only.

import { describe, it, expect } from 'vitest'
import { findConsecutiveRepeats, findRepeatedPhrases } from '../repetition'

const phrases = (texts: string[], max?: number) => findRepeatedPhrases(texts, max).map(p => `${p.phrase} x${p.count}`)
const repeats = (sentences: string[]) => findConsecutiveRepeats(sentences).map(r => r.word)

describe('findRepeatedPhrases: no phrase more than twice across a sequence', () => {
  it('PLANTED: a phrase said three times across four emails is found, with its count', () => {
    const sequence = [
      'pages for buyers abroad',
      'Exporters tell us buyers abroad leave the site. We translate your pages.',
      'Some firms lose buyers abroad to slow pages.',
      'No worries if now is not the time.',
    ]
    // Named as the copy first wrote it. It was 'buyer abroad' until 2026-10-02: the counted form.
    expect(phrases(sequence)).toEqual(['buyers abroad x3'])
  })

  it('twice is allowed (control)', () => {
    expect(phrases(['Buyers abroad leave the site.', 'We write for buyers abroad.', 'No worries.'])).toEqual([])
  })

  it('PLANTED: a hyphen joins two words, so "good-fit" and "a good fit" are one phrase', () => {
    const sequence = ['We find good-fit buyers.', 'Some are not a good fit.', 'Would good-fit calls help?']
    expect(phrases(sequence)).toEqual(['good fit x3'])
  })

  it('PLANTED: a plural and its singular are one word', () => {
    expect(phrases(['A short call is enough.', 'Short calls work well.', 'Would a short call suit you?'])).toEqual(['short call x3'])
  })

  it('PLANTED: a three-word phrase is reported once, not again as the two-word phrases inside it', () => {
    const sequence = ['It can be hard to plan.', 'Growth gets hard to plan.', 'Is it hard to plan?']
    expect(phrases(sequence)).toEqual(['hard to plan x3'])
  })

  it('a phrase made only of small words is never counted, and neither is one that opens or closes on one (control)', () => {
    const sequence = ['It can be slow.', 'It can be late.', 'It can be dear.', 'So your firm waits.', 'So your firm stalls.', 'So your firm slows.']
    expect(phrases(sequence)).toEqual([])
  })

  it('PLANTED: a phrase never spans a sentence end or two emails', () => {
    // "site buyer" would be a phrase if the full stop were read through.
    const sequence = ['We fix the site. Buyers stay.', 'They read the site. Buyers wait.', 'Check the site. Buyers return.']
    expect(phrases(sequence)).toEqual([])
  })

  it('the limit is the caller\'s to set', () => {
    expect(phrases(['new clients', 'new clients'], 1)).toEqual(['new clients x2'])
  })

  it('a merge tag is not a word', () => {
    expect(phrases(['{{first_name}} short call', '{{first_name}} short call', '{{first_name}} short call'])).toEqual(['short call x3'])
  })
})

describe('findConsecutiveRepeats: no word in two sentences in a row', () => {
  it('PLANTED: the operator\'s own example, "hard to plan" then "harder to plan"', () => {
    expect(repeats(['So revenue can be hard to plan.', 'Over time, that can make growth harder to plan.'])).toEqual(['harder', 'plan'])
  })

  it('PLANTED: two forms of one word are the same word', () => {
    expect(repeats(['As a result, growth can stall.', 'We book meetings, so your firm can keep growing.'])).toEqual(['growing'])
    expect(repeats(['We find the right buyers.', 'Would a buyer like that help?'])).toEqual(['buyer'])
  })

  it('only sentences IN A ROW count: the first and third may share a word (control)', () => {
    expect(repeats(['Buyers abroad leave the site.', 'As a result, sales can stall.', 'We translate pages for buyers.'])).toEqual([])
  })

  it('small words, short words and "firm" are not counted (control)', () => {
    expect(repeats(['Some firms tell us they can lose time.', 'So your firm can lose out too.'])).toEqual(['lose'])
    expect(repeats(['Many firms tell us it is slow.', 'Over time, your firm can wait.'])).toEqual([])
    expect(repeats(['We win new work.', 'You win new deals.'])).toEqual([])
  })

  it('PLANTED: each pair of sentences is read, and each finding names both', () => {
    const found = findConsecutiveRepeats(['Pages load slowly.', 'Slow pages lose sales.', 'Lost sales can stall growth.'])
    expect(found.map(f => [f.index, f.word])).toEqual([[0, 'slow'], [0, 'pages'], [1, 'sales']])
    expect(found[0].first).toBe('Pages load slowly.')
    expect(found[0].second).toBe('Slow pages lose sales.')
  })

  it('one sentence, or none, has nothing in a row (control)', () => {
    expect(repeats(['Only one sentence here.'])).toEqual([])
    expect(repeats([])).toEqual([])
  })
})

// ─── Review of 2026-10-02 (fifth reading, pre-merge) ─────────────────────────
//
// Three faults in how the two rules read words, each planted here with a control:
//   - two different words that merely START alike were called one word;
//   - a contraction the stiff-wording rule REQUIRES was counted as a repeated word;
//   - the phrase rule tested a word after trimming its plural, so "does" became "doe" and
//     counted, and the phrase it named was made of stems that are in nobody's copy.

import { PAIRS as STIFF_PAIRS, findStiffForms } from '../stiff-forms'
import { wordsInCommon } from '../repetition'

describe('two forms of one word: the same stem by a listed ending, never by opening letters', () => {
  const same = (a: string, b: string) => repeats([`${a}.`, `${b}.`]).length > 0

  it.each([
    ['hard', 'harder'],       // er
    ['grow', 'growth'],       // th
    ['client', 'clients'],    // s
    ['scale', 'scaling'],     // ing, with the final e dropped
    ['plan', 'planning'],     // ing, with the consonant doubled
    ['steady', 'steadily'],   // ly, with y turned to i
    ['supply', 'supplies'],   // es, with y turned to i
    ['close', 'closer'],      // r: what "er" is after a final e
    ['scale', 'scaled'],      // d: what "ed" is after a final e
    ['slow', 'slowest'],      // est
    ['growth', 'growing'],    // each one ending away from "grow"
    ['plans', 'planned'],
  ])('PLANTED: "%s" and "%s" are one word', (a, b) => {
    expect(same(a, b)).toBe(true)
    expect(same(b, a)).toBe(true)
  })

  it.each([
    ['contract', 'control'],
    ['cleaning', 'clear'],
    ['general', 'generate'],
    ['quotes', 'quota'],
    ['leads', 'leaders'],
    ['accounts', 'accountants'],
    ['plan', 'plant'],
    ['count', 'country'],
    ['plant', 'planet'],
    ['plan', 'plane'],
  ])('PLANTED: "%s" and "%s" are two words, though they start alike', (a, b) => {
    expect(same(a, b)).toBe(false)
    expect(same(b, a)).toBe(false)
  })

  it('PLANTED: the writer is never told a word is repeated that the first sentence does not hold', () => {
    expect(repeats(['The contract can run late.', 'So control of the launch can slip.'])).toEqual([])
    // Control: the same pair of sentences with the word really said twice.
    expect(repeats(['The contract can run late.', 'So the contract can cost more.'])).toEqual(['contract'])
  })

  it('a stem is a word the rule counts: three letters is not one, so "used" and "using" are not held (control)', () => {
    expect(same('used', 'using')).toBe(false)
  })
})

describe('wordsInCommon stays loose: it only chooses a label, and a spare swap costs nothing', () => {
  it('PLANTED: the operator\'s own pair, which no listed ending joins, is still a shared word', () => {
    expect(wordsInCommon('you run an HR consultancy', 'HR consultants')).toEqual(['consultants'])
    expect(wordsInCommon('you run an export house', 'exporters')).toEqual(['exporters'])
  })
  it('the same pairs are two words to the rule the writer is held to (control)', () => {
    expect(repeats(['You run a consultancy.', 'Consultants tell us this.'])).toEqual([])
  })
  it('two texts that share nothing share nothing (control)', () => {
    expect(wordsInCommon('you run a software company', 'furniture makers and importers')).toEqual([])
  })
})

describe('a contraction is a small word: the writer is told to write them, so they are never a repeat', () => {
  it('PLANTED: "haven\'t" in two sentences in a row is not a repeated word', () => {
    expect(repeats(["Some firms tell us they haven't had a full order book lately.", "If you haven't either, reply and we can talk."])).toEqual([])
  })

  it('PLANTED: every contraction the stiff-wording rule asks for is small here: the two lists cannot drift', () => {
    const contractions = STIFF_PAIRS.map(([, write]) => write)
    // The list is really read: it holds the ones this rule used to miss.
    expect(contractions).toEqual(expect.arrayContaining(["haven't", "wasn't", "couldn't", "here's", "what's"]))
    for (const contraction of contractions) {
      expect(repeats([`They ${contraction} ready.`, `We ${contraction} there.`]), contraction).toEqual([])
    }
  })

  it('the pair written out is what the other rule refuses, so one of the two had to give (control)', () => {
    expect(findStiffForms('Some firms have not had a full order book.').map(s => s.write)).toEqual(["haven't"])
  })

  it('a word with meaning beside the contraction is still a repeat (control)', () => {
    expect(repeats(["They haven't had orders lately.", "You haven't had orders either."])).toEqual(['orders'])
  })
})

describe('the phrase rule reads each word as it is written', () => {
  it('PLANTED: "Does that sound ..." three times is no phrase: it opens on a small word', () => {
    // "does" was trimmed to "doe" before the small-word test, and "doe" is not on the list.
    expect(phrases(['Does that sound right?', 'Does that sound familiar?', 'Does that sound like your firm?'])).toEqual([])
  })

  it('"Is this ..." three times is no phrase either (control)', () => {
    expect(phrases(['Is this right?', 'Is this familiar?', 'Is this your firm?'])).toEqual([])
  })

  it('PLANTED: a repeated phrase is named as it was FIRST WRITTEN, not as the stems it was counted by', () => {
    const sequence = ['Our sales teams overseas find it slow.', 'Some sales team overseas can stall.', 'Would your sales teams overseas agree?']
    expect(phrases(sequence)).toEqual(['sales teams overseas x3'])
  })

  it('a plural and its singular are still ONE phrase, however it is named (control)', () => {
    expect(phrases(['Buyer trust is slow to win.', 'So buyers trust less.', 'Is buyer trust the issue?'])).toEqual(['buyer trust x3'])
  })
})
