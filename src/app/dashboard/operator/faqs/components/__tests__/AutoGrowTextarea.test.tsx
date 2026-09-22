// @vitest-environment jsdom
//
// CAN AN OPERATOR ACTUALLY WRITE AN ANSWER IN THESE BOXES?
//
// Both answer boxes on the FAQ screen were fixed at three or four rows with resizing turned
// off. Measured on the live faqs table 2026-09-22: 12 answers, 146 to 451 characters,
// average 275, and every one of them contains a line break. A three-row box with no handle
// shows about a quarter of that and offers no way to see the rest.
//
// ── WHAT A TEST CAN AND CANNOT PROVE HERE ───────────────────────────────────
//
// jsdom performs no layout, so nothing here can assert a rendered pixel height, and a test
// that claimed to would be asserting a constant. What it CAN hold is the mechanism that
// produces the height: an invisible copy of the same text sharing one grid cell with the
// textarea, so the cell is as tall as the text. Delete that copy and the box stops growing;
// these tests go red. That is the mutation they are here to catch.
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/app/dashboard/operator/faqs/components/__tests__/AutoGrowTextarea.test.tsx

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { AutoGrowTextarea } from '../AutoGrowTextarea'
import { FaqRow } from '../FaqRow'
import { AddFaqForm } from '../FaqCurationView'
import type { FaqListItem } from '../types'


afterEach(cleanup)

/** A real answer, in the shape the live table holds: several lines, a few hundred characters. */
const LONG_ANSWER = [
  'Onboarding runs over the first two weeks.',
  '',
  'Week one is the intake call and the strategy documents. Week two is the first list and',
  'the first sequence, which you approve before anything is sent.',
].join('\n')

/** The component is controlled, so a harness holds the value the way both callers do. */
function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return <AutoGrowTextarea value={value} onChange={setValue} ariaLabel="Answer" />
}

describe('AutoGrowTextarea', () => {
  it('is a real multi-line control, not a single-line input', () => {
    render(<Harness />)
    const box = screen.getByLabelText('Answer')
    expect(box.tagName).toBe('TEXTAREA')
  })

  // ── THE MECHANISM ─────────────────────────────────────────────────────────
  //
  // The invisible copy is what makes the grid cell tall. It must carry the SAME text as the
  // value, or the box is sized for something other than what is in it.
  it('keeps an invisible copy of the text, which is what gives the box its height', () => {
    const { container } = render(<Harness initial={LONG_ANSWER} />)

    const mirror = container.querySelector('[aria-hidden="true"]')
    expect(mirror).not.toBeNull()
    expect(mirror?.textContent).toContain('Week two is the first list')
    expect(mirror?.className).toContain('whitespace-pre-wrap')
  })

  it('grows the copy as the operator types, not only on first render', () => {
    const { container } = render(<Harness initial="Short." />)
    const mirror = container.querySelector('[aria-hidden="true"]')
    const before = (mirror?.textContent ?? '').length

    fireEvent.change(screen.getByLabelText('Answer'), { target: { value: LONG_ANSWER } })

    const after = (container.querySelector('[aria-hidden="true"]')?.textContent ?? '').length
    expect(after).toBeGreaterThan(before)
    expect(after).toBeGreaterThan(LONG_ANSWER.length - 1)
  })

  // A trailing newline produces no final line box, so a box just given a new paragraph
  // would shrink back by a line until the first character of it was typed.
  it('carries a trailing space so a new paragraph does not shrink the box', () => {
    const { container } = render(<Harness initial={'One line\n'} />)
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe('One line\n ')
  })

  // The copy holds every answer a second time. Without this a screen reader reads each one
  // twice, once from the textarea and once from the copy.
  it('hides the copy from screen readers', () => {
    render(<Harness initial={LONG_ANSWER} />)
    // getByLabelText finds exactly one control; the copy is not a second one.
    expect(screen.getAllByLabelText('Answer')).toHaveLength(1)
  })

  // ── WHAT IT REPLACED ──────────────────────────────────────────────────────
  //
  // A fixed rows= with resize-none is the exact shape that made these boxes unusable. The
  // textarea still carries resize-none, because the wrapper is what sets the height now and
  // a drag handle on the inner element would fight it.
  it('does not pin itself to a fixed number of rows', () => {
    render(<Harness initial={LONG_ANSWER} />)
    const box = screen.getByLabelText('Answer') as HTMLTextAreaElement
    expect(box.rows).toBe(1)
    // It must never scroll on its own: the wrapper grows instead, up to its cap.
    expect(box.className).toContain('overflow-hidden')
  })
})

// ═════════════════════════════════════════════════════════════════════════════

function faq(overrides: Partial<FaqListItem> = {}): FaqListItem {
  return {
    id: 'faq-1',
    organisation_id: 'org-1',
    question_canonical: 'How long does onboarding take?',
    answer: LONG_ANSWER,
    question_variants: [],
    status: 'approved',
    times_used: 3,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    ...overrides,
  }
}

describe('the Edit answer box on a FAQ row', () => {
  it('opens as a growing box holding the whole answer already on file', () => {
    const { container } = render(
      <FaqRow faq={faq()} onSave={vi.fn()} onArchive={vi.fn()} onRestore={vi.fn()} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit answer' }))

    const box = screen.getByLabelText(
      'Edit answer for: How long does onboarding take?',
    ) as HTMLTextAreaElement
    expect(box.value).toBe(LONG_ANSWER)

    // THE BOX IS SIZED BY THE ANSWER, not by a four-row constant chosen before anyone had
    // measured one. The copy is the evidence that it is.
    const mirror = container.querySelector('[aria-hidden="true"]')
    expect(mirror?.textContent).toContain('the first sequence, which you approve')
    expect(box.rows).toBe(1)
  })
})

describe('the Add FAQ answer box', () => {
  it('is a growing multi-line box, not the three-row slot it replaced', () => {
    const { container } = render(<AddFaqForm orgId="org-1" onAdded={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '+ Add FAQ' }))

    const box = screen.getByLabelText('Answer for the new FAQ') as HTMLTextAreaElement
    expect(box.tagName).toBe('TEXTAREA')
    expect(box.rows).toBe(1)

    fireEvent.change(box, { target: { value: LONG_ANSWER } })

    const mirrors = [...container.querySelectorAll('[aria-hidden="true"]')]
      .map(el => el.textContent ?? '')
    expect(mirrors.some(text => text.includes('Week two is the first list'))).toBe(true)
  })

  // The question stays one line: question_canonical is one question, and the merge and
  // extraction paths both compare it as a single string. What it gained is room to read.
  it('keeps the question on one line, at a size that can be read', () => {
    render(<AddFaqForm orgId="org-1" onAdded={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '+ Add FAQ' }))

    const question = screen.getByPlaceholderText('e.g. How long does onboarding take?')
    expect(question.tagName).toBe('INPUT')
    expect(question.className).toContain('text-[13px]')
    expect(question.className).not.toContain('text-[12px]')
  })
})
