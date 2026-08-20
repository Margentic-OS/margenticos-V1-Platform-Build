// The observation and the bridge are now SEPARATE PARAGRAPHS.
//
// Both used to sit in one paragraph, which is what pushed the writer to cram two facts
// into one sentence to keep it readable. Splitting them gives each one its own white space.
//
// The stored trigger carries the blank line, and composition replaces the P2 slot with it
// verbatim. That works because applyTriggerToEmail1 substitutes a LINE and then re-joins
// with newlines, so a trigger containing its own blank line becomes two paragraphs. This
// file pins that, because it is a non-obvious consequence of how the substitution works
// and a future refactor to paragraph-wise substitution would silently flatten it.

import { describe, it, expect } from 'vitest'
import { composeEmail1WithOpening } from '../compose-sequence'
import type { MessagingContent } from '../compose-sequence'
import { plainTextToHtml } from '../custom-variables'
import { countWords } from '../personalization'

const OBSERVATION = 'You took two board seats in early 2026, at Hollywood Food Coalition and Sovern LA.'
const BRIDGE = 'Delivery has a deadline. Business development never does, so it waits.'
const QUESTION = 'Is protecting time for new conversations something you are working on?'

const DOC: MessagingContent = {
  variants: {
    A: {
      variant_id: 'A',
      emails: [
        {
          sequence_position: 1,
          subject_line: 'pipeline after referrals',
          body: [
            '{{first_name}}',
            'THE APPROVED OPENER GOES HERE.',
            'We fill the diary with qualified meetings.',
            'Worth a look to see if it fits where you are?',
            'Doug\nMargenticOS',
          ].join('\n\n'),
          word_count: 0,
        },
      ],
    },
  },
} as unknown as MessagingContent

const paragraphs = (body: string) => body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)

describe('a two-paragraph opening survives composition', () => {
  const twoPara = `${OBSERVATION}\n\n${BRIDGE}`

  it('renders the observation and the bridge as their own paragraphs', () => {
    const email = composeEmail1WithOpening(DOC, 'A', twoPara, QUESTION, 'Daedra')
    const paras = paragraphs(email.body)
    expect(paras[0]).toBe('Daedra')
    expect(paras[1]).toBe(OBSERVATION)
    expect(paras[2]).toBe(BRIDGE)
    expect(paras[3]).toBe('We fill the diary with qualified meetings.')
    expect(paras[4]).toBe(QUESTION)
  })

  it('replaces the approved opener rather than sitting alongside it', () => {
    const email = composeEmail1WithOpening(DOC, 'A', twoPara, QUESTION, 'Daedra')
    expect(email.body).not.toContain('THE APPROVED OPENER GOES HERE')
  })

  it('still replaces the CTA and not the sign-off', () => {
    // applyQuestionToEmail1 targets the second-to-last paragraph, and it runs BEFORE the
    // opt-out footer is appended. Adding a paragraph above the CTA must not shift what
    // that resolves to. Order after composition: question, sign-off, footer.
    const email = composeEmail1WithOpening(DOC, 'A', twoPara, QUESTION, 'Daedra')
    const paras = paragraphs(email.body)
    expect(paras[paras.length - 1]).toBe('Not for you? Just reply stop.')
    expect(paras[paras.length - 2]).toBe('Doug\nMargenticOS')
    expect(paras[paras.length - 3]).toBe(QUESTION)
    expect(email.body).not.toContain('Worth a look to see if it fits where you are?')
  })

  it('counts exactly the same words as the one-paragraph version', () => {
    // The 90-word ceiling must measure the same total. A paragraph break is whitespace.
    const two = composeEmail1WithOpening(DOC, 'A', twoPara, QUESTION, 'Daedra')
    const one = composeEmail1WithOpening(DOC, 'A', `${OBSERVATION} ${BRIDGE}`, QUESTION, 'Daedra')
    expect(two.word_count).toBe(one.word_count)
    expect(two.word_count).toBeLessThanOrEqual(90)
  })

  it('counts the body it actually produced, not a stored figure', () => {
    const email = composeEmail1WithOpening(DOC, 'A', twoPara, QUESTION, 'Daedra')
    // The footer is appended after counting and is deliberately excluded from the budget.
    const withoutFooter = email.body.split('\n\nNot for you?')[0]
    expect(email.word_count).toBe(countWords(withoutFooter))
  })

  it('renders as two separate <p> elements, not one with a line break', () => {
    const email = composeEmail1WithOpening(DOC, 'A', twoPara, QUESTION, 'Daedra')
    const html = plainTextToHtml(email.body)
    expect(html).toContain(`<p>${OBSERVATION}</p>`)
    expect(html).toContain(`<p>${BRIDGE}</p>`)
    // The sign-off is the one place a <br> is correct: two lines, one paragraph.
    expect(html).toContain('<p>Doug<br>MargenticOS</p>')
  })

  it('keeps working when the writer returned only an observation', () => {
    // joinOpening drops an empty half, so the trigger is a single paragraph and nothing
    // downstream sees a stray blank line.
    const email = composeEmail1WithOpening(DOC, 'A', OBSERVATION, QUESTION, 'Daedra')
    const paras = paragraphs(email.body)
    expect(paras[1]).toBe(OBSERVATION)
    expect(paras[2]).toBe('We fill the diary with qualified meetings.')
  })
})
