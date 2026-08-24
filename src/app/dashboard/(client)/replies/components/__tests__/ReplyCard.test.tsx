// @vitest-environment jsdom
//
// Tests for the client reply card.
//
// Two things this card must get right, and one it must never get wrong.
//
// Must: show the prospect's reply verbatim, and show what went out from the client's
// domain in their founder's name. That second one had no surface anywhere in the product.
// A reply was being sent as them, and they had no way to read it.
//
// Must never: show the classifier's verdict. The card used to render one of five labels,
// "Ready to book" / "Interested" / "Asking about details" / "Asking about pricing" /
// "Interested but hesitant", which is the five-intent vocabulary in a friendly coat.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ReplyCard } from '../ReplyCard'
import type { ClientVisibleReply } from '@/lib/reply-handling/get-client-visible-replies'

function reply(overrides: Partial<ClientVisibleReply> = {}): ClientVisibleReply {
  return {
    id: 'reply-1',
    received_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    prospect: {
      first_name: 'Alice',
      last_name: 'Prospect',
      job_title: 'Managing Director',
      company_name: 'Prospect Co',
      email: 'alice@prospect.example',
    },
    badge: 'interested',
    reply_subject: 'Re: quick question',
    reply_body: 'Sounds interesting.\n\nWhat does it cost?',
    prompting_email: 'Alice,\n\nThe email we sent.\n\nDoug\nMargenticOS',
    sent_on_their_behalf: null,
    meeting: null,
    ...overrides,
  }
}

afterEach(cleanup)

describe('who replied', () => {
  it('names them, their title and their company', () => {
    render(<ReplyCard reply={reply()} />)

    expect(screen.getByText('Alice Prospect')).toBeInTheDocument()
    expect(screen.getByText('Managing Director, Prospect Co')).toBeInTheDocument()
  })

  it('shows the company alone when there is no title', () => {
    render(<ReplyCard reply={reply({
      prospect: { first_name: 'Alice', last_name: 'Prospect', job_title: null, company_name: 'Prospect Co', email: null },
    })} />)

    // No stray separator left behind by the missing half.
    expect(screen.getByText('Prospect Co')).toBeInTheDocument()
    expect(screen.queryByText(/^, /)).not.toBeInTheDocument()
  })

  it('falls back to the company as the name when there is no name', () => {
    render(<ReplyCard reply={reply({
      prospect: { first_name: null, last_name: null, job_title: null, company_name: 'Prospect Co', email: null },
    })} />)
    expect(screen.getByText('Prospect Co')).toBeInTheDocument()
  })

  it('says when they replied', () => {
    render(<ReplyCard reply={reply()} />)
    expect(screen.getByText('Replied 2h ago')).toBeInTheDocument()
  })
})

describe('the badge is two-valued and never the classifier verdict', () => {
  it('reads Interested', () => {
    render(<ReplyCard reply={reply({ badge: 'interested' })} />)
    expect(screen.getByText('Interested')).toBeInTheDocument()
  })

  it('reads Meeting booked', () => {
    render(<ReplyCard reply={reply({
      badge: 'meeting_booked',
      meeting: { scheduled_for: '2026-09-02T14:00:00.000Z' },
    })} />)
    expect(screen.getByText('Meeting booked')).toBeInTheDocument()
  })

  it('never renders any of the five old intent labels', () => {
    for (const badge of ['interested', 'meeting_booked'] as const) {
      cleanup()
      const { container } = render(<ReplyCard reply={reply({
        badge,
        meeting: badge === 'meeting_booked' ? { scheduled_for: null } : null,
      })} />)

      for (const label of [
        'Ready to book', 'Asking about details', 'Asking about pricing', 'Interested but hesitant',
      ]) {
        expect(container.textContent).not.toContain(label)
      }
      // And no raw intent string either.
      for (const intent of ['positive_direct_booking', 'positive_passive', 'objection_mild']) {
        expect(container.textContent).not.toContain(intent)
      }
    }
  })
})

describe('their reply', () => {
  it('is shown in full, with its paragraphs intact', () => {
    const body = 'Sounds interesting.\n\nWhat does it cost?'
    const { container } = render(<ReplyCard reply={reply({ reply_body: body })} />)

    const quote = container.querySelector('blockquote')
    expect(quote?.textContent).toBe(body)
    // whitespace-pre-line is what keeps the paragraph break visible rather than collapsed.
    expect(quote?.querySelector('p')?.className).toContain('whitespace-pre-line')
  })

  it('says so plainly when a reply arrived with no body', () => {
    render(<ReplyCard reply={reply({ reply_body: '' })} />)
    expect(screen.getByText('This reply arrived with no message body.')).toBeInTheDocument()
  })

  it('shows the subject when there is one', () => {
    render(<ReplyCard reply={reply()} />)
    expect(screen.getByText(/Re: quick question/)).toBeInTheDocument()
  })
})

describe('the email that prompted it', () => {
  it('is collapsed by default', () => {
    render(<ReplyCard reply={reply()} />)

    expect(screen.getByText('Show the email they replied to')).toBeInTheDocument()
    expect(screen.queryByText(/The email we sent/)).not.toBeInTheDocument()
  })

  it('opens on click and closes again', () => {
    render(<ReplyCard reply={reply()} />)

    fireEvent.click(screen.getByText('Show the email they replied to'))
    expect(screen.getByText(/The email we sent/)).toBeInTheDocument()

    fireEvent.click(screen.getByText('Hide the email they replied to'))
    expect(screen.queryByText(/The email we sent/)).not.toBeInTheDocument()
  })

  it('offers no toggle when there is no prompting email on file', () => {
    render(<ReplyCard reply={reply({ prompting_email: null })} />)
    expect(screen.queryByText(/email they replied to/)).not.toBeInTheDocument()
  })
})

describe('what was sent on their behalf', () => {
  it('shows the body and the time it went out', () => {
    render(<ReplyCard reply={reply({
      sent_on_their_behalf: {
        body: 'Thanks for coming back to us. Grab a slot here.',
        sent_at: '2026-08-20T10:05:00.000Z',
      },
    })} />)

    expect(screen.getByText('Sent on your behalf')).toBeInTheDocument()
    expect(screen.getByText('Thanks for coming back to us. Grab a slot here.')).toBeInTheDocument()
    expect(screen.getByText(/20 Aug/)).toBeInTheDocument()
  })

  it('shows nothing at all when nothing has been sent', () => {
    render(<ReplyCard reply={reply({ sent_on_their_behalf: null })} />)
    expect(screen.queryByText('Sent on your behalf')).not.toBeInTheDocument()
  })

  it('is read-only: no reply box, no edit, no send', () => {
    const { container } = render(<ReplyCard reply={reply({
      sent_on_their_behalf: { body: 'Sent text.', sent_at: '2026-08-20T10:05:00.000Z' },
    })} />)

    expect(container.querySelector('textarea')).toBeNull()
    expect(container.querySelector('input')).toBeNull()
    // The only button on the card is the prompting-email toggle.
    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons).toHaveLength(1)
    expect(buttons[0].textContent).toContain('email they replied to')
  })
})

describe('the meeting', () => {
  it('gives the date and says attendance is confirmed after', () => {
    render(<ReplyCard reply={reply({
      badge: 'meeting_booked',
      meeting: { scheduled_for: '2026-09-02T14:00:00.000Z' },
    })} />)

    expect(screen.getByText(/Meeting booked for/)).toBeInTheDocument()
    expect(screen.getByText(/Wednesday/)).toBeInTheDocument()
    expect(screen.getByText('Attendance is confirmed after the meeting date.')).toBeInTheDocument()
  })

  it('says the date is still being confirmed when there is not one', () => {
    render(<ReplyCard reply={reply({ badge: 'meeting_booked', meeting: { scheduled_for: null } })} />)
    expect(screen.getByText('Meeting booked. The date is still being confirmed.')).toBeInTheDocument()
  })

  it('says nothing about meetings when there is no meeting', () => {
    render(<ReplyCard reply={reply()} />)
    expect(screen.queryByText(/Attendance is confirmed/)).not.toBeInTheDocument()
  })
})
