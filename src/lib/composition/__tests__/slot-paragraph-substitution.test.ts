// THE SLOT IS ONE PARAGRAPH OR TWO, AND THE TRIGGER IS ONE PARAGRAPH OR TWO.
//
// All four combinations occur in production, so all four are pinned here:
//
//   1 slot, 1 trigger   every document written before 2026-09-20, meeting one of the 12
//                       legacy single-paragraph triggers still on prospect rows
//   1 slot, 2 trigger   every document written before 2026-09-20, meeting a researched
//                       opening, which is observation plus bridge
//   2 slot, 1 trigger   a new document meeting a legacy trigger
//   2 slot, 2 trigger   a new document meeting a researched opening
//
// THE FAILURE THIS FILE EXISTS TO STOP is the third and fourth rows. Substitution used to
// replace a LINE, so against a two-paragraph slot it overwrote the observation and left
// the authored consequence standing inside a personalised email: a generic sentence about
// the client's ICP wedged between a researched bridge and the offer line. Valid-looking
// output, correct word count, no error, no log.

import { describe, it, expect } from 'vitest'
import {
  composeEmail1WithOpening,
  getVariantEmail1Frame,
  fallbackOpeningParagraph,
  type MessagingContent,
} from '../compose-sequence'

const SIGN_OFF = 'Robin\nNorthwind Advisory'
const OBSERVATION  = 'The rota gets rebuilt by hand every week.'
const CONSEQUENCE  = 'By Thursday nobody trusts the version on the wall.'
const OFFER        = 'We keep it running without anyone rebuilding it.'
const CTA          = 'Worth a look to see if it fits?'

const RESEARCHED_OBS    = 'You opened a second depot in March.'
const RESEARCHED_BRIDGE = 'A second site doubles the rota without doubling the people who can build it.'

function doc(...contentParas: string[]): MessagingContent {
  return {
    variants: {
      A: {
        variant_id: 'A',
        emails: [{
          sequence_position: 1,
          subject_line: 'a short subject',
          body: ['{{first_name}}', ...contentParas].join('\n\n'),
          word_count: 0,
        }],
      },
    },
  } as unknown as MessagingContent
}

const ONE_PARA_SLOT = doc(OBSERVATION, OFFER, CTA, SIGN_OFF)
const TWO_PARA_SLOT = doc(OBSERVATION, CONSEQUENCE, OFFER, CTA, SIGN_OFF)

const TWO_PARA_TRIGGER = `${RESEARCHED_OBS}\n\n${RESEARCHED_BRIDGE}`
const ONE_PARA_TRIGGER = RESEARCHED_OBS

const paras = (body: string) => body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)

// A COMPOSED body has FOUR paragraphs at the end, not three: the opt-out footer is
// appended after the sign-off by appendOptOutFooter. The frame's tail of three is a fact
// about the STORED document, which is what applyTriggerToEmail1 operates on. Getting this
// wrong is how the first draft of this file failed against correct code.
const COMPOSED_TAIL = 4   // offer line, CTA, sign-off, opt-out footer

/** Everything after the greeting and before the composed tail. */
function slotOf(body: string): string[] {
  const p = paras(body)
  return p.slice(1, p.length - COMPOSED_TAIL)
}

const composedOffer = (body: string) => paras(body)[paras(body).length - COMPOSED_TAIL]
const composedCta   = (body: string) => paras(body)[paras(body).length - 3]

describe('a four-paragraph document resolves exactly as it did before this change', () => {
  it('offer line, CTA and sign-off land where they always did', () => {
    const frame = getVariantEmail1Frame(ONE_PARA_SLOT, 'A')
    expect(frame.authoredOpening).toBe(OBSERVATION)
    expect(frame.p3).toBe(OFFER)
    expect(frame.cta).toBe(CTA)
  })

  it('composes with the tail intact', () => {
    const email = composeEmail1WithOpening(ONE_PARA_SLOT, 'A', TWO_PARA_TRIGGER, null, 'Robin')
    const p = paras(email.body)
    expect(composedOffer(email.body)).toBe(OFFER)
    expect(composedCta(email.body)).toBe(CTA)
    expect(p[p.length - 1]).toBe('Not for you? Just reply stop.')
  })
})

describe('a five-paragraph document resolves correctly', () => {
  it('reads the offer line and CTA by job, not by index', () => {
    const frame = getVariantEmail1Frame(TWO_PARA_SLOT, 'A')
    expect(frame.p3).toBe(OFFER)
    expect(frame.cta).toBe(CTA)
  })

  it('hands back both slot paragraphs as the authored opening', () => {
    expect(getVariantEmail1Frame(TWO_PARA_SLOT, 'A').authoredOpening)
      .toBe(`${OBSERVATION}\n\n${CONSEQUENCE}`)
  })
})

describe('shapes outside one or two slot paragraphs still throw', () => {
  it('throws on three content paragraphs, a slot of zero', () => {
    expect(() => getVariantEmail1Frame(doc(OFFER, CTA, SIGN_OFF), 'A')).toThrow(/observation slot/)
  })

  it('throws on six content paragraphs, a slot of three', () => {
    const six = doc(OBSERVATION, CONSEQUENCE, 'A third slot paragraph.', OFFER, CTA, SIGN_OFF)
    expect(() => getVariantEmail1Frame(six, 'A')).toThrow(/observation slot/)
  })
})

describe('a two-paragraph trigger replaces BOTH slot paragraphs', () => {
  const email = () => composeEmail1WithOpening(TWO_PARA_SLOT, 'A', TWO_PARA_TRIGGER, null, 'Robin')

  it('leaves no authored slot text behind', () => {
    expect(email().body).not.toContain(OBSERVATION)
    expect(email().body).not.toContain(CONSEQUENCE)
  })

  it('puts the researched observation and bridge in the slot, as two paragraphs', () => {
    expect(slotOf(email().body)).toEqual([RESEARCHED_OBS, RESEARCHED_BRIDGE])
  })

  it('does not touch the offer line, the CTA or the sign-off', () => {
    expect(composedOffer(email().body)).toBe(OFFER)
    expect(composedCta(email().body)).toBe(CTA)
    expect(paras(email().body)[paras(email().body).length - 2]).toBe(SIGN_OFF)
  })
})

describe('a one-paragraph trigger replaces the whole slot', () => {
  // The 12 legacy single-paragraph triggers still on prospect rows take this path.
  const email = () => composeEmail1WithOpening(TWO_PARA_SLOT, 'A', ONE_PARA_TRIGGER, null, 'Robin')

  it('strands NO authored consequence, which is the defect this file is named for', () => {
    expect(email().body).not.toContain(CONSEQUENCE)
    expect(email().body).not.toContain(OBSERVATION)
  })

  it('leaves exactly one slot paragraph, the researched one', () => {
    expect(slotOf(email().body)).toEqual([RESEARCHED_OBS])
  })

  it('does the same against a one-paragraph slot', () => {
    const e = composeEmail1WithOpening(ONE_PARA_SLOT, 'A', ONE_PARA_TRIGGER, null, 'Robin')
    expect(slotOf(e.body)).toEqual([RESEARCHED_OBS])
    expect(e.body).not.toContain(OBSERVATION)
  })
})

// The standalone-opening check reads this. It must be the paragraph that actually opens
// the email, and only that one: the consequence has the observation above it, so the
// question "does this read as a first line" does not apply to it.
describe('fallbackOpeningParagraph returns the first slot paragraph', () => {
  it('returns the observation from a two-paragraph slot, not the whole slot', () => {
    const emails = [{ sequence_position: 1, body: TWO_PARA_SLOT.variants.A.emails[0].body }]
    expect(fallbackOpeningParagraph(emails as never)).toBe(OBSERVATION)
  })

  it('returns the observation from a one-paragraph slot', () => {
    const emails = [{ sequence_position: 1, body: ONE_PARA_SLOT.variants.A.emails[0].body }]
    expect(fallbackOpeningParagraph(emails as never)).toBe(OBSERVATION)
  })

  it('returns a whole soft-wrapped paragraph, not its first line', () => {
    const wrapped = doc(`${OBSERVATION}\nand it never gets easier.`, OFFER, CTA, SIGN_OFF)
    const emails = [{ sequence_position: 1, body: wrapped.variants.A.emails[0].body }]
    expect(fallbackOpeningParagraph(emails as never)).toContain('never gets easier')
  })
})
