// @vitest-environment jsdom
//
// What actually reaches the screen, checked on the RENDERED OUTPUT rather than on the
// component's props. A component that receives the fragment list and declines to render
// it today is one edit away from rendering it tomorrow; the gate that matters is that the
// client-facing path never has the fragments to begin with.
//
// RULE ZERO: every fragment and statement below is an abstract token. The fixed copy in
// the component is scanned against the same banned-word list that guards the derivation
// prompt, so a job title or sector reaching a LABEL, an empty state or a heading fails
// this file.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { IcpDocumentView } from '../IcpDocumentView'
import { findBannedContent, BANNED_TITLE_WORDS } from '@/agents/buyer-criterion-agent'
import { selectClientBuyerCriterion, selectOperatorBuyerCriterion } from '@/lib/dashboard/buyer-criterion-view'

afterEach(cleanup)

const FRAGMENTS = ['alpha', 'beta', 'gamma']

const SPEC = {
  buyer_criterion: {
    status: 'derived',
    accept: [{ fragment: 'alpha', rank: 'primary' }, { fragment: 'beta', rank: 'secondary' }],
    reject: ['gamma'],
    statement: 'A sentence naming who is worth contacting.',
    evidence: ['A line the documents contained.'],
    unsettled_reason: null,
    sanity: { checked: true, sample_size: 40, accept_rate: 0.5, note: 'Accepts 20 of 40.' },
    derived_at: '2026-09-02T00:00:00.000Z',
    model: 'test',
  },
}

const LIVE_DOC = {
  status: 'active',
  icp_filter_spec: SPEC,
}

const CONTENT = { jtbd_statement: 'A job to be done.', summary: 'A summary.' } as never

describe('what the client sees', () => {
  it('renders the statement and the evidence', () => {
    render(
      <IcpDocumentView
        content={CONTENT}
        plainText={null}
        buyerCriterion={selectClientBuyerCriterion(LIVE_DOC)}
        operatorCriterion={null}
      />,
    )
    expect(screen.getByText('Who we contact')).toBeInTheDocument()
    expect(screen.getByText('A sentence naming who is worth contacting.')).toBeInTheDocument()
    expect(screen.getByText('A line the documents contained.')).toBeInTheDocument()
  })

  it('renders NO fragment anywhere in the markup', () => {
    const { container } = render(
      <IcpDocumentView
        content={CONTENT}
        plainText={null}
        buyerCriterion={selectClientBuyerCriterion(LIVE_DOC)}
        operatorCriterion={null}
      />,
    )
    for (const fragment of FRAGMENTS) {
      expect(container.innerHTML).not.toContain(fragment)
    }
  })

  it('renders nothing about the criterion when the document is an archived version', () => {
    // The client RLS policy admits archived rows so version history can be read, so an
    // old version reaching this component is now an ordinary thing rather than a bug.
    const pending = { ...LIVE_DOC, status: 'archived' }
    const { container } = render(
      <IcpDocumentView
        content={CONTENT}
        plainText={null}
        buyerCriterion={selectClientBuyerCriterion(pending)}
        operatorCriterion={null}
      />,
    )
    expect(screen.queryByText('Who we contact')).not.toBeInTheDocument()
    expect(container.innerHTML).not.toContain('A sentence naming who is worth contacting.')
  })

  it('still renders the criterion when the document body fell back to plain text', () => {
    // A document that failed to parse into the structured shape is exactly when the
    // reader most needs the sentence.
    render(
      <IcpDocumentView
        content={{} as never}
        plainText="Some plain text."
        buyerCriterion={selectClientBuyerCriterion(LIVE_DOC)}
        operatorCriterion={null}
      />,
    )
    expect(screen.getByText('Who we contact')).toBeInTheDocument()
  })
})

describe('the fragment channel is closed, proved with a sentinel', () => {
  // A plain substring check on real fragments is WORTHLESS here and was tried first: the
  // statement legitimately contains the words the fragments are made of, and so does the
  // document body around it. It reported a leak that was not one.
  //
  // A sentinel that cannot occur in prose separates "this word appears somewhere on the
  // page" from "the fragment list reached the client". The operator assertion is what
  // stops this passing vacuously: if the sentinel were absent from BOTH renders the test
  // would prove nothing.
  const SENTINEL = 'zqxsentinelfragmentxqz'
  const planted = {
    ...LIVE_DOC,
    icp_filter_spec: {
      buyer_criterion: {
        ...SPEC.buyer_criterion,
        accept: [...SPEC.buyer_criterion.accept, { fragment: SENTINEL, rank: 'secondary' }],
      },
    },
  }

  it('never reaches the client, in the payload or the markup', () => {
    expect(JSON.stringify(selectClientBuyerCriterion(planted))).not.toContain(SENTINEL)
    const { container } = render(
      <IcpDocumentView content={CONTENT} plainText={null}
        buyerCriterion={selectClientBuyerCriterion(planted)} operatorCriterion={null} />,
    )
    expect(container.innerHTML).not.toContain(SENTINEL)
  })

  it('DOES reach the operator, so the assertion above is not vacuous', () => {
    const { container } = render(
      <IcpDocumentView content={CONTENT} plainText={null}
        buyerCriterion={selectClientBuyerCriterion(planted)}
        operatorCriterion={selectOperatorBuyerCriterion(planted)} />,
    )
    expect(container.innerHTML).toContain(SENTINEL)
  })
})

describe('what only the operator sees', () => {
  it('renders the fragments', () => {
    render(
      <IcpDocumentView
        content={CONTENT}
        plainText={null}
        buyerCriterion={selectClientBuyerCriterion(LIVE_DOC)}
        operatorCriterion={selectOperatorBuyerCriterion(LIVE_DOC)}
      />,
    )
    expect(screen.getByText('Buyer criterion — operator view')).toBeInTheDocument()
    for (const fragment of FRAGMENTS) {
      expect(screen.getByText(new RegExp(fragment))).toBeInTheDocument()
    }
  })

  it('says so when the client cannot see it', () => {
    const pending = { ...LIVE_DOC, status: 'archived' }
    render(
      <IcpDocumentView
        content={CONTENT}
        plainText={null}
        buyerCriterion={selectClientBuyerCriterion(pending)}
        operatorCriterion={selectOperatorBuyerCriterion(pending)}
      />,
    )
    expect(screen.getByText(/not the live version/)).toBeInTheDocument()
  })
})

describe('Rule Zero: the fixed copy names nobody', () => {
  // Scanned on rendered TEXT, using the same list that guards the derivation prompt. The
  // client-supplied statement and evidence are abstract in this fixture, so anything the
  // scan finds came from a label, a heading or an empty state written in this repo.
  it('has no job title or industry vocabulary in any label it renders', () => {
    const { container } = render(
      <IcpDocumentView
        content={CONTENT}
        plainText={null}
        buyerCriterion={selectClientBuyerCriterion(LIVE_DOC)}
        operatorCriterion={selectOperatorBuyerCriterion(LIVE_DOC)}
      />,
    )
    expect(findBannedContent(container.textContent ?? '')).toEqual([])
  })

  it('the scan is not vacuous: it flags a planted term', () => {
    // The probe is taken FROM the banned list rather than typed out, so no job title
    // appears as a literal anywhere in this file. Same rule the derivation prompt is held
    // to, applied to the test that checks it.
    expect(BANNED_TITLE_WORDS.length).toBeGreaterThan(0)
    const probe = `prefix ${BANNED_TITLE_WORDS[0]} suffix`
    expect(findBannedContent(probe).length).toBeGreaterThan(0)
  })
})
