// What the operator actually reads when a client changes an answer.
//
// The template was repointed from an event that never fired (a document revision request,
// removed by ADR-047) onto one that now does. These tests pin the three things it must say
// and the one thing it must never say.

import { describe, it, expect } from 'vitest'
import {
  clientRevisionNotifySubject,
  clientRevisionNotifyTemplate,
  clientRevisionNotifyTemplateText,
  type ClientAnswerChange,
} from '../templates/client-revision-notify'
import { validateEmailContent } from '../send'

const ORG = 'Test Org'
const ORG_ID = '11111111-2222-3333-4444-555555555555'

const ONE: ClientAnswerChange[] = [
  { fieldLabel: 'What does your company do?', previous: 'The old answer.', next: 'The new answer.' },
]
const TWO: ClientAnswerChange[] = [
  ...ONE,
  { fieldLabel: 'Who do you serve?', previous: '(blank)', next: 'A new answer.' },
]

function render(changes: ClientAnswerChange[], flagged: string[]) {
  const params = { orgName: ORG, orgId: ORG_ID, changes, flaggedDocumentTypes: flagged }
  return {
    subject: clientRevisionNotifySubject(ORG, changes),
    html: clientRevisionNotifyTemplate(params),
    text: clientRevisionNotifyTemplateText(params),
  }
}

describe('the subject names the change', () => {
  it('names the one answer when there is one', () => {
    expect(clientRevisionNotifySubject(ORG, ONE))
      .toBe('Client changed an answer: What does your company do?, Test Org')
  })

  it('counts them when there are several', () => {
    expect(clientRevisionNotifySubject(ORG, TWO)).toBe('Client changed 2 answers, Test Org')
  })

  it('always names the organisation, because the operator has more than one client', () => {
    expect(clientRevisionNotifySubject(ORG, ONE)).toContain(ORG)
    expect(clientRevisionNotifySubject(ORG, TWO)).toContain(ORG)
  })
})

describe('it says what changed, from what to what', () => {
  it('carries every label, previous value and new value into both renderings', () => {
    const { html, text } = render(TWO, [])
    for (const change of TWO) {
      for (const body of [html, text]) {
        expect(body).toContain(change.fieldLabel)
        expect(body).toContain(change.previous)
        expect(body).toContain(change.next)
      }
    }
  })

  it('labels which value is which, so "was" cannot be read as "now"', () => {
    const { html, text } = render(ONE, [])
    expect(html).toContain('Was')
    expect(html).toContain('Now')
    expect(text).toContain('Was: The old answer.')
    expect(text).toContain('Now: The new answer.')
  })
})

describe('it says which documents are now flagged', () => {
  it('names them when there are some', () => {
    const { html, text } = render(ONE, ['icp'])
    expect(html).toContain('Now flagged as possibly out of date: ICP.')
    expect(text).toContain('Now flagged as possibly out of date: ICP.')
  })

  it('names all of them', () => {
    const { text } = render(ONE, ['icp', 'positioning'])
    expect(text).toContain('ICP, Positioning')
  })

  it('says so plainly when there are none, rather than staying silent', () => {
    // Silence would leave the operator to guess whether the flagging ran at all.
    const { html, text } = render(ONE, [])
    expect(html).toContain('No live document was newly flagged by this change.')
    expect(text).toContain('No live document was newly flagged by this change.')
  })
})

describe('it never claims anything was regenerated', () => {
  // ADR-047 and the flagging module's own header: an intake edit MARKS and stops. The
  // sentence this template used to carry, "the updated document is ready to view", described
  // work nobody does.
  // The phrases are the CLAIMS the old template made, not the word "regenerated" itself:
  // the email says "Nothing has been regenerated", so banning the stem would ban the
  // sentence that does the work. The first version of this test did exactly that and
  // failed against its own next assertion.
  it.each([
    'the updated document is ready',
    'revision agent',
    'has run and',
    'ready to view',
  ])('does not say "%s"', (phrase) => {
    const { html, text } = render(TWO, ['icp'])
    expect(html.toLowerCase()).not.toContain(phrase.toLowerCase())
    expect(text.toLowerCase()).not.toContain(phrase.toLowerCase())
  })

  it('the phrase check can detect a phrase that IS there, so its negatives mean something', () => {
    // Positive control for the assertion shape above.
    const { html } = render(TWO, ['icp'])
    expect(html.toLowerCase()).toContain('nothing has been regenerated')
  })

  it('says in as many words that nothing was regenerated', () => {
    const { html, text } = render(ONE, ['icp'])
    expect(html).toContain('Nothing has been regenerated.')
    expect(text).toContain('Nothing has been regenerated.')
  })
})

describe('it renders to something the validator will actually send', () => {
  const CASES: [string, ClientAnswerChange[], string[]][] = [
    ['one change, nothing flagged', ONE, []],
    ['one change, one flagged', ONE, ['icp']],
    ['two changes, two flagged', TWO, ['icp', 'positioning']],
  ]

  it.each(CASES)('%s passes the operator validator', (_name, changes, flagged) => {
    const { subject, html, text } = render(changes, flagged)
    expect(validateEmailContent(subject, html, text, 'operator')).toBeNull()
  })

  it('a value containing an em dash is fine, because this is operator mail', () => {
    // The dash ban is a prospect-facing style rule. A client may well type one, and losing
    // the notification over it would be the category error send.ts already corrected.
    const dashed: ClientAnswerChange[] = [
      { fieldLabel: 'A question', previous: 'before', next: 'after — with a dash' },
    ]
    const { subject, html, text } = render(dashed, [])
    expect(validateEmailContent(subject, html, text, 'operator')).toBeNull()
  })
})

describe('client text is escaped', () => {
  // Every value here is something a client typed. An unclosed tag in an answer would swallow
  // the rest of the message, which loses the thing the email was sent to say.
  it('escapes markup in an answer', () => {
    const nasty: ClientAnswerChange[] = [
      { fieldLabel: 'A question', previous: '<b>old', next: 'new & "quoted"' },
    ]
    const html = clientRevisionNotifyTemplate({
      orgName: ORG, orgId: ORG_ID, changes: nasty, flaggedDocumentTypes: [],
    })
    expect(html).toContain('&lt;b&gt;old')
    expect(html).not.toContain('<b>old')
    expect(html).toContain('&amp;')
  })

  it('escapes markup in the organisation name too', () => {
    const html = clientRevisionNotifyTemplate({
      orgName: '<script>x</script>', orgId: ORG_ID, changes: ONE, flaggedDocumentTypes: [],
    })
    expect(html).not.toContain('<script>')
  })
})

describe('the link goes where the operator needs to go', () => {
  it('points at that client intake view, not at a generic dashboard', () => {
    const { html, text } = render(ONE, [])
    expect(html).toContain(`/dashboard/operator/clients/${ORG_ID}/intake`)
    expect(text).toContain(`/dashboard/operator/clients/${ORG_ID}/intake`)
  })
})
