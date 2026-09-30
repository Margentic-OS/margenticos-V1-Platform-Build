// THE OFFER LINE MUST ANSWER THE HOOK IT SITS UNDER.
//
// Six of twenty blind-marked Email 1s drew this complaint from the operator, in both arms of
// the A/B at the same rate, which made it the most frequent single fault in that review. The
// cause was structural: the variant, and so the offer line, came from a hash of the prospect
// id while the hook came from what the prospect actually did, so the pairing was chance.
//
// THE MOST IMPORTANT TESTS HERE ARE THE FALLBACK ONES. A selector that improves the good case
// and strands the rest is worse than the hash, because the hash at least always answers. The
// three fallbacks in order are: a neutral line, then the assigned variant unchanged, and an
// untagged document must behave EXACTLY as it did before this field existed.

import { describe, it, expect } from 'vitest'
import { chooseOfferLineVariant, ANGLE_MATCH_FLOOR, ANGLE_MATCH_RELATIVE } from '../offer-angle'
import { variantOfferAngles } from '../compose-sequence'
import type { MessagingContent } from '../compose-sequence'
import { contentOverlap } from '@/lib/agents/research/synthesize'

const HIRING_HOOK = 'You posted for a client services manager to join the delivery team.'
const CONTENT_HOOK = 'You published a full guide to the framework and promoted it yourself.'

const TAGGED = [
  { variantId: 'A', offerAngle: 'posting for people to join the delivery team while new work still has to be found' },
  { variantId: 'B', offerAngle: 'published material that the right buyers never see' },
  { variantId: 'C', offerAngle: null },
]

const choose = (hook: string, candidates = TAGGED, assigned = 'C', prospect = 'p-1') =>
  chooseOfferLineVariant(hook, assigned, candidates, prospect, contentOverlap)

describe('the hook picks the offer line that answers it', () => {
  it('picks the hiring angle for a hiring hook', () => {
    const choice = choose(HIRING_HOOK)
    expect(choice.basis).toBe('angle_match')
    expect(choice.variantId).toBe('A')
  })

  it('sends a WEAK real match to the neutral line, which is the deliberate trade', () => {
    // MEASURED 2026-09-30: this hook against this angle scores 0.167, below the 0.20 floor,
    // although a human would call it a match. The floor is deliberately on the safe side
    // because the two errors do not cost the same: too high degrades to a line that names no
    // pain, which is never wrong; too low ships a line about a pain the reader does not have,
    // which is the fault this whole file exists to remove.
    //
    // THIS TEST PINS THE TRADE, NOT THE IDEAL. When the floor is measured against real angles
    // it should move, and this expectation should change with it.
    const choice = choose(CONTENT_HOOK)
    expect(choice.basis).toBe('neutral')
    expect(choice.variantId).toBe('C')
  })

  it('picks a strongly-matching angle over a neutral line', () => {
    const strong = [
      { variantId: 'A', offerAngle: 'published a full guide that the right buyers never see' },
      { variantId: 'B', offerAngle: null },
    ]
    const choice = chooseOfferLineVariant(CONTENT_HOOK, 'B', strong, 'p-1', contentOverlap)
    expect(choice.basis).toBe('angle_match')
    expect(choice.variantId).toBe('A')
  })

  it('does not let a uniformly weak field elect a winner', () => {
    // A hook that shares one incidental word with one angle and nothing with the other must
    // reach the neutral line, not the marginally-less-unrelated angle.
    const weak = [
      { variantId: 'A', offerAngle: 'posting for people to join the delivery team' },
      { variantId: 'B', offerAngle: null },
    ]
    const choice = chooseOfferLineVariant(
      'Your firm opened a second office on another continent.', 'B', weak, 'p-1', contentOverlap,
    )
    expect(choice.basis).toBe('neutral')
  })

  it('falls to the neutral line when no angle is close enough', () => {
    // A hook about something neither declared angle covers. The neutral line cannot name the
    // wrong pain, so it beats a mismatched one.
    const choice = choose('Your firm opened a second office on another continent.')
    expect(choice.basis).toBe('neutral')
    expect(choice.variantId).toBe('C')
  })
})

describe('the fallbacks, which are what stop this being worse than the hash', () => {
  it('an untagged document behaves exactly as it did before the field existed', () => {
    // Documents are per-client data and code deploys globally, so every client is in this
    // state until their document is next regenerated. Requiring the tag would strand them all.
    const untagged = [
      { variantId: 'A', offerAngle: null },
      { variantId: 'B', offerAngle: null },
      { variantId: 'C', offerAngle: null },
      { variantId: 'D', offerAngle: null },
    ]
    const choice = chooseOfferLineVariant(HIRING_HOOK, 'D', untagged, 'p-1', contentOverlap)
    expect(choice.basis).toBe('no_tags')
    expect(choice.variantId).toBe('D')
  })

  it('keeps the assigned variant when every variant declares a pain and none is this one', () => {
    const allTagged = TAGGED.filter(c => c.offerAngle !== null)
    const choice = chooseOfferLineVariant(
      'Your firm opened a second office on another continent.',
      'B', allTagged, 'p-1', contentOverlap,
    )
    expect(choice.basis).toBe('no_match_no_neutral')
    expect(choice.variantId).toBe('B')
  })

  it('falls through to the hash when there is no hook at all', () => {
    const choice = choose('')
    expect(choice.basis).toBe('neutral')
  })

  it('treats an empty-string angle as neutral, not as a tag', () => {
    // A model asked for a tag it cannot supply writes "". Reading that as a declared angle
    // would put every prospect whose hook happens to score against nothing onto it.
    const withBlank = [{ variantId: 'A', offerAngle: '   ' }, { variantId: 'B', offerAngle: null }]
    const choice = chooseOfferLineVariant(HIRING_HOOK, 'B', withBlank, 'p-1', contentOverlap)
    expect(choice.basis).toBe('no_tags')
  })
})

describe('a tie does not collapse four variants into one', () => {
  it('spreads tied angles across prospects instead of always taking the first', () => {
    // Two variants declaring the same angle would otherwise send every matching prospect to
    // whichever sorts first, silently turning a four-variant document into a one-variant one
    // for that whole angle.
    // Angles that genuinely clear the floor, so the tie set really has two members.
    const tied = [
      { variantId: 'A', offerAngle: 'published a full guide that the right buyers never see' },
      { variantId: 'B', offerAngle: 'published a full guide that the right buyers never see' },
    ]
    const picked = new Set(
      Array.from({ length: 40 }, (_, i) =>
        chooseOfferLineVariant(CONTENT_HOOK, 'A', tied, `prospect-${i}`, contentOverlap).variantId,
      ),
    )
    expect(picked).toEqual(new Set(['A', 'B']))
  })

  it('gives the same prospect the same answer every time', () => {
    const first = choose(HIRING_HOOK, TAGGED, 'C', 'stable-id')
    for (let i = 0; i < 5; i++) {
      expect(choose(HIRING_HOOK, TAGGED, 'C', 'stable-id')).toEqual(first)
    }
  })
})

describe('the document reader', () => {
  const doc = (angles: Array<string | null | undefined>): MessagingContent => ({
    variants: Object.fromEntries(
      angles.map((angle, i) => [
        String.fromCharCode(65 + i),
        {
          variant_id: String.fromCharCode(65 + i),
          emails: [
            {
              sequence_position: 1,
              subject_line: 's',
              subject_char_count: 1,
              body: '{{first_name}}\n\nopener\n\noffer\n\ncta?\n\nMerrin\nNorthwind Labs',
              word_count: 0,
              ...(angle === undefined ? {} : { offer_angle: angle }),
            },
          ],
        },
      ]),
    ),
  } as unknown as MessagingContent)

  it('reads a declared angle and reports an absent one as neutral', () => {
    expect(variantOfferAngles(doc(['hiring pressure', null, undefined]))).toEqual([
      { variantId: 'A', offerAngle: 'hiring pressure' },
      { variantId: 'B', offerAngle: null },
      { variantId: 'C', offerAngle: null },
    ])
  })

  it('skips a variant with no Email 1 rather than defaulting it', () => {
    const d = doc(['hiring pressure', null])
    d.variants!.B.emails = []
    expect(variantOfferAngles(d).map(c => c.variantId)).toEqual(['A'])
  })

  it('returns nothing for a legacy single-sequence document', () => {
    expect(variantOfferAngles({ emails: [] } as unknown as MessagingContent)).toEqual([])
  })
})

describe('the thresholds are stated, so a change to them is a visible change', () => {
  it('holds the floor and the relative rule the header argues for', () => {
    // These are load-bearing values with a written justification above them. A silent edit is
    // the thing this assertion exists to make loud.
    expect(ANGLE_MATCH_FLOOR).toBe(0.20)
    expect(ANGLE_MATCH_RELATIVE).toBe(0.5)
  })
})
