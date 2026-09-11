// @vitest-environment jsdom
//
// What the operator sees about a version's search specification, checked on the RENDERED
// output. A refusal used to reach Sentry and nowhere else; this is the place it reaches now.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { SpecRefusalNotice } from '../SpecRefusalNotice'
import { operatorSpecStatus } from '@/lib/sourcing/spec-refusal'

afterEach(cleanup)

const REFUSAL = {
  reason: 'no_headcount_bound',
  detail: 'ICP filter spec: neither tier establishes a lower headcount bound.',
  recorded_at: '2026-09-08T13:57:02.000Z',
}

describe('SpecRefusalNotice', () => {
  it('a refused version says sourcing cannot use it, why, and quotes the refusal', () => {
    render(<SpecRefusalNotice status={operatorSpecStatus(null, REFUSAL)} />)

    expect(screen.getByRole('alert')).toHaveTextContent('Sourcing cannot use this version')
    expect(screen.getByText('The staff-size range on this document has no usable numbers.')).toBeInTheDocument()
    expect(screen.getByText(REFUSAL.detail)).toBeInTheDocument()
  })

  it('a version with no spec and no refusal is shown as not built, never as fine', () => {
    render(<SpecRefusalNotice status={operatorSpecStatus(null, null)} />)
    expect(screen.getByRole('status')).toHaveTextContent('Search specification not built yet')
  })

  it('a version with a spec and no refusal shows nothing', () => {
    const { container } = render(
      <SpecRefusalNotice status={operatorSpecStatus({ industries: [] }, null)} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('a refusal wins over a spec that is present', () => {
    render(<SpecRefusalNotice status={operatorSpecStatus({ industries: [] }, REFUSAL)} />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('a malformed stored refusal is still shown as a refusal, not a pass', () => {
    render(<SpecRefusalNotice status={operatorSpecStatus({ industries: [] }, { reason: 'something-new' })} />)
    expect(screen.getByRole('alert')).toHaveTextContent('because of an unexpected error')
  })
})
