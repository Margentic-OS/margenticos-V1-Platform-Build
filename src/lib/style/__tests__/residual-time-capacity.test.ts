// THE READER'S WORK PLACED IN TIME SOMETHING ELSE LEAVES.
//
// ═════════════════════════════════════════════════════════════════════════════
// The one assumed-capacity fault that got through a blind operator read of twenty Email 1s on
// 2026-09-30, while the gate was already blocking on Email 1. With its two real names removed:
//
//   "Your pipeline gets worked on in the hours delivery does not take first."
//
// The operator's mark: "We're telling him what happens to his pipeline as a result of his
// hours. We can't know this."
//
// It asserts the ORDER in which the reader's commitments claim their hours. That is not a fact
// about an event; it is a fact about how somebody's week is run, and it is invisible from
// outside. The zero-sum patterns state the same division as an EQUATION and so cannot reach a
// RESIDUE.
//
// ─── HOW THIS FILE IS BUILT, AND WHY IT IS BUILT THAT WAY ───────────────────
//
// The must-not-fire half is the half that matters, and it is NOT a list of sentences chosen to
// pass. Every one of them is a sentence that FIRED during development and was the reason a
// pattern got tightened. They are regression anchors, not reassurance:
//
//   "three weeks left before the deadline"     made `left` unusable on its own
//   "the first week of July"                   is why no pattern pairs `first` with a time noun
//   "whatever is left in the budget"           is why the residue must BE time
//   "the opening hours ... leave Fridays clear" is why a release verb must end its clause
//   "demand did not require more staff"        is why the negation list is present-tense only
//
// EVERY NAME HERE IS INVENTED OR GENERIC. Real cohort wording in a test fixture publishes it.
// ═════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest'
import {
  findAssumedCapacityClaims,
  isSenderSide,
  EMAIL1_RAW_BLOCKING_KINDS,
} from '../assumed-capacity'

/** What the gate actually does to a sentence: fires, and not exempted as sender-side. */
const blocks = (sentence: string): boolean => {
  const hits = findAssumedCapacityClaims(sentence)
  if (hits.length === 0) return false
  return !hits.every(h => isSenderSide(sentence, h.matched))
}
const matched = (sentence: string): string[] =>
  findAssumedCapacityClaims(sentence).map(h => h.matched)

describe('the instrument is live before anything else is asserted', () => {
  it('fires on a claim the detector has always caught', () => {
    // GUARD THE GUARD. Every "does not fire" assertion below is worthless if the module is
    // broken or mis-imported, and a broken module and a clean sentence look identical.
    expect(blocks('Your attention is already spoken for.')).toBe(true)
  })

  it('reports this shape as their_time, which is what makes it block Email 1 raw', () => {
    const hits = findAssumedCapacityClaims(
      'Your pipeline gets worked on in the hours delivery does not take first.',
    )
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every(h => h.kind === 'their_time')).toBe(true)
    // The kind is not decoration: it is the entry in the raw-blocking list that makes this
    // reject an Email 1 without needing the reader to be named.
    expect(EMAIL1_RAW_BLOCKING_KINDS).toContain('their_time')
  })
})

describe('the named fault, and the four grammars a residual claim uses', () => {
  it('catches the sentence that shipped', () => {
    expect(blocks('Your pipeline gets worked on in the hours delivery does not take first.')).toBe(true)
  })

  it('catches it with every name and every industry word removed', () => {
    // The point of the rule is that it is about grammar. If it only worked on the original
    // wording it would be a patch for one sentence.
    expect(blocks('The second business gets attention in the time the first one does not need.')).toBe(true)
  })

  it.each([
    ['negated claim', 'New work happens in whatever hours the main role does not claim.'],
    ['negated claim, no preposition', 'Finding the next customer waits for the afternoons the other side does not need.'],
    ['named residue', 'New client work gets the hours left over from the committed work.'],
    ['named residue, spare', 'Finding the next client happens in spare time.'],
    ['named residue, whatever is left', 'Growth gets whatever hours are left at the end of the week.'],
    ['releasing verb', 'The newer side is built in the gaps the established one leaves behind.'],
    ['releasing verb, finished with', 'The newer business only gets the hours the older one has finished with.'],
    ['priority order', 'The main account fills the week first.'],
    ['priority order, claim first', 'Delivery tends to claim the week first.'],
    ['priority order, first call', 'The older side has first call on the working day.'],
  ])('catches the %s form', (_label, sentence) => {
    expect(blocks(sentence)).toBe(true)
  })

  it('names what it matched, so a rewrite instruction can quote it', () => {
    expect(matched('New client work gets the hours left over from the committed work.'))
      .toContain('hours left over')
  })
})

describe('the sentences that FIRED during development and forced a pattern to tighten', () => {
  it.each([
    // Bare `left` is a countdown, not a residue. These two are why "left over" is required.
    ['a countdown to a deadline', 'There are three weeks left before the deadline.'],
    ['a term remaining on an agreement', 'The lease has two years left on it.'],
    ['a count of places', 'Two seats are left on the retreat.'],
    // `first` beside a time noun is a DATE. This is why no pattern pairs them.
    ['a date', 'You spoke at a conference in the first week of July.'],
    // The residue has to BE time. These three are why the time noun is required.
    ['a budget underspend', 'Whatever is left in the budget at the end of the year goes back.'],
    ['an undelivered part of an order', 'What was left of the first order arrived in a second box.'],
    ['a deadline described as a window', 'Whatever is left of the submission window closes this quarter.'],
    // A release verb must end its clause. This is why "leave Fridays clear" cannot reach it.
    ['a published schedule', 'The opening hours listed on the site leave Fridays clear.'],
    // The negation list is present-tense only. These two are why.
    ['a past observation about staffing', 'In the weeks after launch, demand did not require more staff.'],
    ['a past-perfect observation', 'Within days he had not needed a second meeting.'],
    // `spare` needs a time noun.
    ['a spare object', 'You have a spare room at the office now.'],
    // A release verb with no time noun at all.
    ['a document omission', 'The report left out the regional figures.'],
  ])('allows %s through', (_label, sentence) => {
    expect(blocks(sentence)).toBe(false)
  })
})

describe('a sender describing its own hours is not a claim about the reader', () => {
  it('exempts the shape when the sentence carries a first person', () => {
    const s = 'We do the building in the hours our own week leaves open.'
    // It MATCHES, and is then exempted. Asserting only the exemption would hide the fact that
    // the pattern reaches sender copy at all, which is what the exemption exists to handle.
    expect(findAssumedCapacityClaims(s).length).toBeGreaterThan(0)
    expect(blocks(s)).toBe(false)
  })
})

describe('TWO KNOWN GAPS, pinned so they cannot change silently', () => {
  // These assert what the gate DOES, not what it should do. Both are recorded on the Notion
  // Backlog. A future change that fixes either will fail here, which is the point: the next
  // person has to read this note rather than discover the behaviour.

  it('still fires on a QUESTION, which is the recorded gap', () => {
    // A question invites a correction where a statement invites a reply that opens with one,
    // and two precedents in this codebase already exempt questions: the short-relative check,
    // and the operator's own rule that asking where their work comes from is allowed.
    //
    // NOT FIXED HERE DELIBERATELY. A question exemption cannot be scoped to these patterns
    // alone without splitting the array, and applying it to every pattern in the file would
    // loosen blocking that was measured separately. Measured 2026-10-01: zero question-form
    // hits across 221 real stored openings, so the cost is theoretical today.
    expect(blocks('Is the newer business getting built in the hours left over?')).toBe(true)
  })

  it('still fires on a POPULATION framing, which is deliberate rather than a gap', () => {
    // Email 1 blocks this kind RAW by an explicit operator decision: the bridge sits directly
    // under the reader's own fact, so an impersonal time claim reads as a claim about them.
    expect(blocks('Owners running two things find the second gets the hours the first has finished with.')).toBe(true)
  })
})
