// The frame reader must fail loudly on a document whose Email 1 is not the shape its
// positional read assumes, and the composed email that ships must be counted for questions.
//
// Every fixture here is invented and carries no industry, sector, buyer title, revenue
// band or currency. The defect is structural, so the copy does not need to be real to
// exercise it, and a real fixture would date the moment a client's document changed.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getVariantEmail1Frame,
  composeEmail1WithOpening,
  EMAIL1_FRAME_CONTENT_PARAGRAPHS,
  type MessagingContent,
} from '../compose-sequence'
import {
  countComposedQuestions,
  checkComposedQuestionCount,
  bodyWithoutOptOutFooter,
  MAX_QUESTIONS_PER_COMPOSED_EMAIL,
  COMPOSED_QUESTION_GATE_MODE,
} from '@/lib/style/composed-question-count'
import { OPT_OUT_FOOTER } from '../opt-out-footer'

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
import { logger } from '@/lib/logger'

const SIGN_OFF = 'Robin\nNorthwind Advisory'

/** Builds a one-variant document from the content paragraphs given, greeting prepended. */
function doc(...contentParas: string[]): MessagingContent {
  return {
    variants: {
      A: {
        variant_id: 'A',
        emails: [
          {
            sequence_position: 1,
            subject_line: 'a short subject',
            body: ['{{first_name}}', ...contentParas].join('\n\n'),
            word_count: 0,
          },
        ],
      },
    },
  } as unknown as MessagingContent
}

const OBSERVATION = 'The rota gets rebuilt by hand every week and nobody owns the outcome.'
const OFFER = 'We take that rebuild off the desk and keep it running on its own.'
const CTA = 'Worth a look to see if it fits where you are?'

const WELL_FORMED = doc(OBSERVATION, OFFER, CTA, SIGN_OFF)

describe('getVariantEmail1Frame on a well-formed document', () => {
  it('reads the four slots by position, which is the convention being kept', () => {
    const frame = getVariantEmail1Frame(WELL_FORMED, 'A')
    expect(frame.authoredOpening).toBe(OBSERVATION)
    expect(frame.p3).toBe(OFFER)
    expect(frame.cta).toBe(CTA)
    expect(frame.subject).toBe('a short subject')
  })

  it('states the count the positional read depends on, so the guard and the read agree', () => {
    expect(EMAIL1_FRAME_CONTENT_PARAGRAPHS).toBe(4)
  })
})

describe('getVariantEmail1Frame fails loudly on a shape mismatch', () => {
  // THE CORE TEST. Before the guard this returned a REAL paragraph promoted into the offer
  // slot, silently. `paras[1] ?? ''` cannot go out of range, so nothing failed and nothing
  // was empty: it was simply the wrong paragraph, correctly formed.
  it('throws when Email 1 has one content paragraph too many', () => {
    const extra = doc(OBSERVATION, 'An extra paragraph nobody planned for.', OFFER, CTA, SIGN_OFF)
    expect(() => getVariantEmail1Frame(extra, 'A')).toThrow(/5 content paragraphs/)
  })

  it('throws when Email 1 has one content paragraph too few', () => {
    const short = doc(OBSERVATION, OFFER, SIGN_OFF)
    expect(() => getVariantEmail1Frame(short, 'A')).toThrow(/3 content paragraphs/)
  })

  it('names the variant and the required count, so the document can be found and fixed', () => {
    const extra = doc(OBSERVATION, 'One more.', OFFER, CTA, SIGN_OFF)
    expect(() => getVariantEmail1Frame(extra, 'A')).toThrow(/variant "A"/)
    expect(() => getVariantEmail1Frame(extra, 'A')).toThrow(/requires exactly 4/)
  })

  // The exact promotion the guard exists to stop. Without the guard this assertion is what
  // fails: p3 comes back as the extra paragraph rather than the offer line, and the writer
  // is briefed with it.
  it('does not hand back a paragraph that is not the offer line', () => {
    const extra = doc(OBSERVATION, 'A second problem paragraph, not an offer.', OFFER, CTA, SIGN_OFF)
    let p3: string | null = null
    try { p3 = getVariantEmail1Frame(extra, 'A').p3 } catch { p3 = null }
    expect(p3).not.toBe('A second problem paragraph, not an offer.')
  })

  // A five-paragraph document composes CORRECTLY, because composition counts paragraphs
  // from the END of the body while the frame reader counts from the START. That difference
  // is why the mismatch was invisible: nothing downstream of it was wrong.
  it('composes correctly on the same document the frame read rejects', () => {
    const extra = doc(OBSERVATION, 'An extra paragraph nobody planned for.', OFFER, CTA, SIGN_OFF)
    const email = composeEmail1WithOpening(extra, 'A', 'A written observation.', 'A written question?', 'Robin')
    const paras = email.body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
    expect(paras[1]).toBe('A written observation.')
    expect(paras[paras.length - 3]).toBe('A written question?')
  })
})

describe('the composed email is counted for questions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('ships report-only, so the constant is the thing under test', () => {
    expect(COMPOSED_QUESTION_GATE_MODE).toBe('report')
    expect(MAX_QUESTIONS_PER_COMPOSED_EMAIL).toBe(1)
  })

  // THE MEASURED SHAPE, reproduced structurally: a document paragraph that is itself a
  // question, plus the CTA. Both halves passed their own upstream gate; the join did not.
  it('detects two question marks in a composed Email 1', () => {
    const twoQuestions = doc(OBSERVATION, 'Is the rebuild still done by hand?', CTA, SIGN_OFF)
    const email = composeEmail1WithOpening(twoQuestions, 'A', 'A written observation.', null, 'Robin')
    expect(countComposedQuestions(email.body)).toBe(2)
  })

  it('counts one on a well-formed composed Email 1', () => {
    const email = composeEmail1WithOpening(WELL_FORMED, 'A', 'A written observation.', null, 'Robin')
    expect(countComposedQuestions(email.body)).toBe(1)
  })

  // THE FOOTER STRIP IS LOAD-BEARING. The opt-out footer contains a question mark, so a
  // count on the raw body reports two on every correct email and the gate fires on
  // everything. Composition appends the footer, so this is not hypothetical.
  it('excludes the opt-out footer, which contains a question mark of its own', () => {
    const email = composeEmail1WithOpening(WELL_FORMED, 'A', 'A written observation.', null, 'Robin')
    expect(email.body).toContain(OPT_OUT_FOOTER)
    expect((email.body.match(/\?/g) ?? []).length).toBe(2)
    expect(countComposedQuestions(email.body)).toBe(1)
    expect(bodyWithoutOptOutFooter(email.body)).not.toContain(OPT_OUT_FOOTER)
  })

  it('logs the hit but returns no failures in report mode', () => {
    const failures = checkComposedQuestionCount('Two? Questions here?', {
      prospectId: 'p-1', clientId: 'c-1', variantId: 'A',
    })
    expect(failures).toEqual([])
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.warn).mock.calls[0][1]).toMatchObject({ count: 2, mode: 'report' })
  })

  // The blocking path is executed here and nowhere else. A flip that has never been run is
  // a flip nobody has tested.
  it('returns a failure when explicitly run in block mode', () => {
    const failures = checkComposedQuestionCount('Two? Questions here?', {
      prospectId: 'p-1', clientId: 'c-1', variantId: 'A',
    }, 'block')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatch(/2 question marks/)
  })

  it('stays silent on a compliant body in either mode', () => {
    const ctx = { prospectId: 'p-1', clientId: 'c-1', variantId: 'A' }
    expect(checkComposedQuestionCount('One question only?', ctx)).toEqual([])
    expect(checkComposedQuestionCount('One question only?', ctx, 'block')).toEqual([])
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
