// @vitest-environment jsdom
//
// Proves the asymmetry this guard exists to close, and proves it the only way that
// works: by RENDERING, not by reading.
//
// A malformed tier field (an object where the renderer expects a string) throws
// "Objects are not valid as a React child" during React's RENDER phase. That is after
// the component function has returned, so a try/catch inside a render helper does not
// see it. ApprovalCard has such a try/catch and it is ineffective for this class.
// Only an error boundary catches it.

import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { IcpDocumentView } from '../IcpDocumentView'

afterEach(cleanup)

// Silence React's expected error logging for the deliberate-crash cases.
function quiet(fn: () => void) {
  const err = console.error
  console.error = () => {}
  try { fn() } finally { console.error = err }
}

class Boundary extends React.Component<
  { children: React.ReactNode },
  { crashed: boolean }
> {
  state = { crashed: false }
  static getDerivedStateFromError() { return { crashed: true } }
  render() {
    if (this.state.crashed) return <div data-testid="crashed" />
    return this.props.children
  }
}

// A tier whose disqualifiers are objects rather than strings. This is the exact shape
// the Ship 2 disqualifier change would introduce if it landed without a renderer update.
const malformed = {
  jtbd_statement: 'x',
  summary: 'y',
  tier_1: {
    label: 'Ideal Client',
    company_profile: { industries: ['Management Consulting'], geography: 'UK' },
    disqualifiers: [{ criterion: 'has in-house team', stage: 'sourcing' }],
  },
}

describe('IcpDocumentView crash guard', () => {
  it('does not take the page down when a tier field is the wrong shape', () => {
    quiet(() => {
      render(
        <Boundary>
          <IcpDocumentView content={malformed as never} plainText={null} />
        </Boundary>,
      )
    })
    // The guard is INSIDE IcpDocumentView, so the outer boundary must never fire.
    expect(screen.queryByTestId('crashed')).not.toBeInTheDocument()
  })

  // The case that actually regressed. `tier.triggers.map(...)` was the one unguarded
  // dereference in the file. Nothing enforces that key: the ICP agent has no schema
  // validator, and its own write-path test proves a tier of just { label } is accepted.
  it('survives a tier with no triggers key at all', () => {
    render(
      <Boundary>
        <IcpDocumentView
          content={{
            jtbd_statement: 'x',
            tier_1: { label: 'Ideal Client', company_profile: { geography: 'UK only' } },
          } as never}
          plainText={null}
        />
      </Boundary>,
    )
    expect(screen.queryByTestId('crashed')).not.toBeInTheDocument()
    expect(screen.getByText('UK only')).toBeInTheDocument()
  })

  it('renders the { trigger } object shape as its text', () => {
    render(
      <Boundary>
        <IcpDocumentView
          content={{
            jtbd_statement: 'x',
            tier_1: {
              label: 'Ideal Client',
              company_profile: { geography: 'UK only' },
              triggers: [{ trigger: 'hired a first salesperson', evidence_to_find: [] }],
            },
          } as never}
          plainText={null}
        />
      </Boundary>,
    )
    expect(screen.getByText('hired a first salesperson')).toBeInTheDocument()
    expect(screen.queryByTestId('crashed')).not.toBeInTheDocument()
  })

  it('still renders a well-formed document normally', () => {
    render(
      <Boundary>
        <IcpDocumentView
          content={{
            jtbd_statement: 'x',
            summary: 'y',
            tier_1: {
              label: 'Ideal Client',
              company_profile: { industries: ['Management Consulting'], geography: 'UK only' },
              disqualifiers: ['has an in-house team'],
            },
          } as never}
          plainText={null}
        />
      </Boundary>,
    )
    expect(screen.getByText('UK only')).toBeInTheDocument()
    expect(screen.getByText('has an in-house team')).toBeInTheDocument()
    expect(screen.queryByTestId('crashed')).not.toBeInTheDocument()
  })
})
