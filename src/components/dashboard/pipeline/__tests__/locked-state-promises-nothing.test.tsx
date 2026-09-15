// @vitest-environment jsdom
//
// The locked pipeline screen must not promise an automatic unlock.
//
// The previous copy told the client, in writing, that the view "unlocks after your first 5
// meetings or two months of sending, whichever comes first", and drew a progress bar
// toward five. organisations.pipeline_unlocked was read in 30 places and WRITTEN IN NONE,
// so the bar could fill to 5 of 5 and the screen stay locked for ever.
//
// An operator now opens it from the settings screen. These assertions are what stops the
// promise, or the bar, coming back.

import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import { PipelineLockedState } from '../PipelineLockedState'

afterEach(cleanup)

describe('the locked pipeline screen', () => {
  it('says the view is not open, and promises no rule for opening it', () => {
    render(<PipelineLockedState meetingCount={0} />)

    // Positive control: the screen rendered at all.
    expect(screen.getByText('Your pipeline view is not open yet')).toBeInTheDocument()

    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/unlocks after/i)
    expect(text).not.toMatch(/whichever comes first/i)
    expect(text).not.toMatch(/two-month/i)
    // The denominator was the promise: "5" as a target must not appear.
    expect(text).not.toMatch(/of 5\b/)
  })

  it('shows a real meeting count without a target beside it', () => {
    render(<PipelineLockedState meetingCount={3} />)
    expect(screen.getByText('3 meetings booked so far')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/of \d/)
  })

  it('reads correctly at one meeting', () => {
    render(<PipelineLockedState meetingCount={1} />)
    expect(screen.getByText('1 meeting booked so far')).toBeInTheDocument()
  })

  it('reads correctly at zero', () => {
    render(<PipelineLockedState meetingCount={0} />)
    expect(screen.getByText('No meetings booked yet')).toBeInTheDocument()
  })

  it('STAYS LOCKED past the old threshold, which is the whole point', () => {
    // 99 meetings. Under the copy this replaces, the client had been told in writing that
    // five was enough. The screen is unchanged in kind: still locked, still no promise.
    render(<PipelineLockedState meetingCount={99} />)

    expect(screen.getByText('Your pipeline view is not open yet')).toBeInTheDocument()
    expect(screen.getByText('99 meetings booked so far')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/unlock/i)
  })

  it('renders no progress bar', () => {
    const { container } = render(<PipelineLockedState meetingCount={4} />)
    // The bar was the only element with a percentage width.
    expect(container.innerHTML).not.toMatch(/width:\s*\d+%/)
  })
})
