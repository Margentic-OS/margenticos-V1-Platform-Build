// @vitest-environment jsdom
//
// The Settings page rendered a hardcoded PLACEHOLDER_SETTINGS literal until 2026-09-10.
// It claimed an organisation name matching no record, a booking link belonging to nobody,
// four integrations "Connected" with "last verified" dates against a table that HAS NO
// last_verified COLUMN, and two toggles wired to useState and nothing else.
//
// These tests pin the property that replaced it: THE COMPONENT RENDERS ONLY WHAT IT IS
// GIVEN. Most of them are absence assertions, which are the weakest kind, so each one
// below is paired with a positive control in the same test — a string that MUST be present
// — so a render that produced nothing at all cannot pass as a render that produced no
// invented values.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { SettingsView } from '../SettingsView'
import type { OrganisationSettings, IntegrationRow } from '../SettingsView'

// The server action is a module boundary this component imports. Stubbed so the component
// can render without a Supabase session; none of these tests invoke it.
vi.mock('@/app/dashboard/operator/settings/actions', () => ({
  updateBookingUrl: vi.fn(async () => ({ value: null })),
}))

afterEach(cleanup)

const ORG: OrganisationSettings = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Example Org',
  calendly_url: null,
  auto_approve_window_hours: 72,
  auto_held_window_hours: 48,
  monthly_meetings_target: 10,
  currency: 'EUR',
  client_review_enabled: true,
  linkedin_channel_enabled: false,
  sourcing_revenue_filter_enabled: false,
  founder_first_name: null,
  archived_at: null,
}

// Mirrors the live shape that broke the old page: active, and NOT connected.
const REGISTRY: IntegrationRow[] = [
  { capability: 'can_send_email', tool_name: 'a-sending-tool', is_active: true, connection_status: 'disconnected' },
  { capability: 'can_enrich_contact', tool_name: 'an-enrichment-tool', is_active: false, connection_status: 'disconnected' },
]

describe('the placeholder is gone', () => {
  it('renders no organisation name that was not passed in', () => {
    render(<SettingsView organisation={ORG} integrations={REGISTRY} clientRequested />)

    // Positive control first: prove this render produced the section at all, so the
    // absence assertions below are about content and not about an empty tree.
    expect(screen.getByText("This client's settings")).toBeInTheDocument()

    expect(screen.queryByText(/Apex Consulting/i)).toBeNull()
  })

  it('renders no booking link that was not passed in', () => {
    render(<SettingsView organisation={ORG} integrations={REGISTRY} clientRequested />)

    const input = screen.getByLabelText(/client booking link/i) as HTMLInputElement
    // Positive control: the field exists and is the one under test.
    expect(input).toBeInTheDocument()
    // ORG.calendly_url is null, so the field must be empty rather than showing a sample.
    expect(input.value).toBe('')
    expect(document.body.textContent).not.toMatch(/calendly\.com/i)
  })

  it('never claims a verification date, because no column holds one', () => {
    render(<SettingsView organisation={ORG} integrations={REGISTRY} clientRequested />)

    expect(screen.getByText('Platform integrations')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/last verified/i)
    expect(document.body.textContent).not.toMatch(/2026-04-1[78]/)
  })

  it('does not render either toggle, because nothing implements either', () => {
    render(<SettingsView organisation={ORG} integrations={REGISTRY} clientRequested />)

    // Positive control: a section that SHOULD be here is here.
    expect(screen.getByText('Booking link')).toBeInTheDocument()

    // The LinkedIn one was the worse of the two: it displayed "on" from a hardcoded
    // literal while organisations.linkedin_channel_enabled was false on every row.
    expect(screen.queryByText(/LinkedIn post auto-approve/i)).toBeNull()
    expect(screen.queryByText(/Holding message/i)).toBeNull()
    // And no switch survives under any label except the one that IS implemented: the
    // revenue filter has a column, a write path, validation and a test (2026-09-10). Exactly
    // one, and it must be that one, so a new unimplemented switch still fails here.
    const switches = screen.queryAllByRole('switch')
    expect(switches).toHaveLength(1)
    expect(switches[0]).toHaveAccessibleName(/revenue filter/i)
  })

  it('does not describe the auto-approve window as fixed for all clients', () => {
    render(<SettingsView organisation={ORG} integrations={REGISTRY} clientRequested />)

    // It is organisations.auto_approve_window_hours, a per-client column. The value shown
    // must be the one passed, and 72 must not be restated as a platform constant.
    expect(screen.getByText('72 hours')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/fixed for all clients/i)
  })
})

describe('an active but disconnected integration', () => {
  it('reports the recorded status verbatim rather than calling it Connected', () => {
    render(<SettingsView organisation={ORG} integrations={REGISTRY} clientRequested />)

    // is_active drives the pill, because is_active is what every registry read in the
    // codebase actually filters on.
    expect(screen.getByText('In use')).toBeInTheDocument()
    expect(screen.getByText('Not in use')).toBeInTheDocument()

    // connection_status is reported, not translated. The old page turned four rows in
    // exactly this state into "Connected".
    expect(document.body.textContent).toMatch(/connection recorded as disconnected/i)
    expect(screen.queryByText(/^Connected$/)).toBeNull()
  })

  it('says so plainly when no integration is registered, rather than rendering nothing', () => {
    render(<SettingsView organisation={ORG} integrations={[]} clientRequested />)

    // An empty registry is a fault, not a quiet start. A section that renders blank here
    // reads as healthy, which is the failure shape this codebase keeps hitting.
    expect(screen.getByText(/No integrations are registered/i)).toBeInTheDocument()
  })
})

describe('empty values', () => {
  it('renders "Not set up" for a missing booking link and a missing sign-off name', () => {
    render(<SettingsView organisation={ORG} integrations={REGISTRY} clientRequested />)

    // Two: the booking-link note and the sign-off row.
    expect(screen.getAllByText('Not set up').length).toBeGreaterThanOrEqual(2)
  })

  // The no-link note used to say "A positive reply is sent without one until it is set
  // here." Neither reply path did that: the automatic one failed and sent nothing, and a
  // draft carrying the link placeholder fails at send. Since 2026-09-10 a booking reply
  // with no link is held as a draft for the operator, and the note says so.
  it('says a positive reply is held as a draft when there is no booking link', () => {
    render(<SettingsView organisation={ORG} integrations={REGISTRY} clientRequested />)

    // Positive control: the no-link note is rendering at all.
    expect(screen.getAllByText('Not set up').length).toBeGreaterThanOrEqual(1)
    expect(document.body.textContent).toMatch(
      /held as a draft for the operator instead of being sent automatically/i,
    )
    // The old sentence promised a send that no path makes.
    expect(document.body.textContent).not.toMatch(/sent without one/i)
  })

  it('does not show the held-as-draft note once a link is set', () => {
    render(
      <SettingsView
        organisation={{ ...ORG, calendly_url: 'https://example.test/book/30min' }}
        integrations={REGISTRY}
        clientRequested
      />,
    )

    // Positive control: the link is what the field shows.
    const input = screen.getByLabelText(/client booking link/i) as HTMLInputElement
    expect(input.value).toBe('https://example.test/book/30min')
    expect(document.body.textContent).not.toMatch(/held as a draft/i)
  })

  it('renders the real values when they are present', () => {
    const filled: OrganisationSettings = {
      ...ORG,
      calendly_url: 'https://example.test/book/30min',
      founder_first_name: 'Alex',
    }
    render(<SettingsView organisation={filled} integrations={REGISTRY} clientRequested />)

    const input = screen.getByLabelText(/client booking link/i) as HTMLInputElement
    expect(input.value).toBe('https://example.test/book/30min')
    expect(screen.getByText('Alex / Example Org')).toBeInTheDocument()
    expect(screen.getByText('EUR')).toBeInTheDocument()
    expect(screen.getByText('10')).toBeInTheDocument()
  })
})

describe('no client selected', () => {
  it('says no client is selected and shows no per-client section at all', () => {
    render(<SettingsView organisation={null} integrations={REGISTRY} clientRequested={false} />)

    expect(screen.getByText(/No client selected/i)).toBeInTheDocument()

    // The per-client section must be absent rather than empty. An empty section with
    // headings and no values reads as "this client has nothing set", which is a claim
    // about a client nobody picked.
    expect(screen.queryByText("This client's settings")).toBeNull()
    expect(screen.queryByLabelText(/client booking link/i)).toBeNull()

    // Positive control: the platform-wide section IS still shown, because it is true
    // regardless of which client is selected.
    expect(screen.getByText('Platform integrations')).toBeInTheDocument()
  })

  it('distinguishes a client that was not found from no client at all', () => {
    render(<SettingsView organisation={null} integrations={REGISTRY} clientRequested />)

    // A stale bookmark is a different problem from an empty selection, and telling an
    // operator "no client selected" when they did select one sends them to the wrong fix.
    expect(screen.getByText(/could not be found/i)).toBeInTheDocument()
    expect(screen.queryByText(/No client selected/i)).toBeNull()
  })
})

describe('an archived organisation', () => {
  it('says its settings affect nothing that runs', () => {
    const archived: OrganisationSettings = { ...ORG, archived_at: '2026-08-05T00:00:00Z' }
    render(<SettingsView organisation={archived} integrations={REGISTRY} clientRequested />)

    expect(screen.getByText(/archived/i)).toBeInTheDocument()
    // Still rendered, so the values can be read. The warning is the point, not a block.
    expect(screen.getByText("This client's settings")).toBeInTheDocument()
  })
})

describe('the revenue filter shows the stored value, and is off unless opted in', () => {
  it('renders Off for a client who has not been opted in', () => {
    render(<SettingsView organisation={ORG} integrations={REGISTRY} clientRequested />)
    const control = screen.getByRole('switch', { name: /revenue filter/i })
    expect(control).toHaveAttribute('aria-checked', 'false')
    expect(control).toHaveTextContent('Off')
  })

  it('renders On for a client who has', () => {
    render(
      <SettingsView
        organisation={{ ...ORG, sourcing_revenue_filter_enabled: true }}
        integrations={REGISTRY}
        clientRequested
      />,
    )
    const control = screen.getByRole('switch', { name: /revenue filter/i })
    expect(control).toHaveAttribute('aria-checked', 'true')
    expect(control).toHaveTextContent('On')
  })

  it('says when a change takes effect, beside the control', () => {
    render(<SettingsView organisation={ORG} integrations={REGISTRY} clientRequested />)
    expect(screen.getByText(/takes effect at the next ICP approval/i)).toBeInTheDocument()
  })
})
