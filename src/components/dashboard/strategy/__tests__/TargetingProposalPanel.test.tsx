// @vitest-environment jsdom
//
// The before-and-after panel, checked on the RENDERED OUTPUT. ADR-061 step 6.
//
// The plan's check for this step: it renders the real 2026-09-30 difference correctly from
// a fixture with invented names. That is the first block. The view it renders is built by
// the same functions the page uses, from the same two fixture settings, so this is what
// the operator would have seen that day.
//
// The rest proves the panel sends back exactly what it was given: the fingerprint, and one
// key for every exclusion ticked. The approve route re-checks all of it, so these tests
// are about the operator being told the truth and not about security.
//
// RULE ZERO: every title, keyword and reason in this file is a placeholder, and the
// panel's own fixed copy is scanned for role and sector words.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

import { TargetingProposalPanel, TargetingProposalUnavailable } from '../TargetingProposalPanel'
import type { ProposalPanelView, RetierView } from '@/lib/dashboard/targeting-proposal-view'
import { planApproval, REFUSAL_MESSAGES } from '@/lib/sourcing/approve-icp-filter-spec'
import { describeRemovedExclusions, describeSettingsDiff } from '@/lib/sourcing/describe-settings-diff'
import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import { BANNED_TITLE_WORDS, findBannedContent } from '@/agents/buyer-criterion-agent'
import {
  ADDED_TITLE,
  after,
  afterWithCriterionHeld,
  before,
  EXCLUDED_AFTER,
  EXCLUDED_BEFORE,
  registeredHandler,
} from '@/lib/sourcing/__tests__/helpers/settings-change-fixture'

const DOC = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

/** The view the page would build, from the same pure functions it uses. */
function viewFor(
  live: ICPFilterSpec | null,
  proposed: ICPFilterSpec,
  retier: RetierView = { kind: 'none' },
): ProposalPanelView {
  const plan = planApproval(live, proposed, registeredHandler())
  return {
    document_id: DOC,
    fingerprint: plan.fingerprint,
    first_settings: live === null,
    changes: describeSettingsDiff(plan.diff),
    exclusions: describeRemovedExclusions(plan.diff.removed_exclusions),
    blockers: plan.criterion_gates ? [] : [REFUSAL_MESSAGES.criterion_does_not_gate],
    criterion_held: proposed.criterion_held
      ? { status: proposed.criterion_held.rederived_status, reason: proposed.criterion_held.reason }
      : null,
    cursor: plan.cursor,
    retier,
  }
}

/** A change that needs one tick and can be approved: one excluded title stops applying. */
function oneExclusionRemoved(): ICPFilterSpec {
  const spec = before()
  spec.job_titles_excluded = [EXCLUDED_BEFORE[1]]
  spec.buyer_criterion = { ...spec.buyer_criterion!, reject: [EXCLUDED_BEFORE[1]] }
  return spec
}

const REPLAYED: RetierView = {
  kind: 'replayed',
  requeued: 62,
  requeued_not_enriched: 14,
  requeued_outcome: [
    { to: 'tier_1', count: 3 },
    { to: 'tier_2', count: 9 },
    { to: 'tier_3', count: 0 },
    { to: 'removed', count: 36 },
  ],
  survivors_moved: [
    { from: 'tier_1', to: 'removed', count: 3 },
    { from: 'tier_2', to: 'tier_1', count: 1 },
  ],
  judged: 589,
}

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const approveButton = () => screen.getByRole('button', { name: 'Approve change' })

beforeEach(() => { refresh.mockClear() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// ═════════════════════════════════════════════════════════════════════════════

describe('the 2026-09-30 difference, with invented names', () => {
  it('shows each changed setting in plain words', () => {
    render(<TargetingProposalPanel view={viewFor(before(), after(), REPLAYED)} />)
    const panel = screen.getByRole('region', { name: 'Proposed change to the search settings' })
    const text = panel.textContent ?? ''

    expect(text).toContain(`Job titles searched: adds ${ADDED_TITLE}`)
    expect(text).toContain(
      `Job titles excluded: adds ${EXCLUDED_AFTER.join(', ')}; removes ${EXCLUDED_BEFORE.join(', ')}`)
    expect(text).toContain('Seniority levels searched: adds ')
    expect(text).toContain(`Who we email: now also accepts ${ADDED_TITLE}`)
    expect(text).toContain('would stop being applied to anyone')
    expect(text).toContain('Research fit conditions: changed')
    // Five changed settings, five lines. Nothing that did not change is listed.
    const whatChanges = screen.getByText('What changes').parentElement!
    expect(within(whatChanges).getAllByRole('listitem')).toHaveLength(5)
  })

  it('says the search changes, so the client starts again from the first result', () => {
    render(<TargetingProposalPanel view={viewFor(before(), after(), REPLAYED)} />)
    expect(screen.getByText(/The search changes, so this client starts again from the first result/)).toBeInTheDocument()
  })

  it('asks for one tick per excluded title that stops applying', () => {
    render(<TargetingProposalPanel view={viewFor(before(), after(), REPLAYED)} />)
    for (const title of EXCLUDED_BEFORE) {
      expect(screen.getByLabelText(`Stop excluding the job title “${title}”`)).not.toBeChecked()
    }
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
  })

  it('says it cannot be approved, why, and keeps Approve off even with every tick ticked', () => {
    render(<TargetingProposalPanel view={viewFor(before(), after(), REPLAYED)} />)
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box)

    expect(screen.getByText('This cannot be approved as it stands')).toBeInTheDocument()
    expect(screen.getByText(REFUSAL_MESSAGES.criterion_does_not_gate)).toBeInTheDocument()
    expect(approveButton()).toBeDisabled()
  })

  it('is marked as not shown to the client', () => {
    render(<TargetingProposalPanel view={viewFor(before(), after())} />)
    expect(screen.getByText('Not shown to the client')).toBeInTheDocument()
  })

  it('as step 4 files it: says the live criterion was kept and why, and can be approved', () => {
    render(<TargetingProposalPanel view={viewFor(before(), afterWithCriterionHeld())} />)
    const text = screen.getByRole('region').textContent ?? ''

    expect(text).toContain('came back out of band')
    expect(text).toContain('The current criterion is kept in this proposal.')
    expect(text).toContain('Reason given: A placeholder note: accepts almost every title sampled.')
    expect(text).toContain('The search itself does not change, so this client keeps their place in it.')
    expect(text).toContain('This change touches nothing tiering reads. Nobody is re-tiered.')
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(approveButton()).toBeEnabled()
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('who would be re-tiered, counted by movement', () => {
  it('says who goes back to tiering, where they would land, and which survivors would be judged differently', () => {
    render(<TargetingProposalPanel view={viewFor(before(), oneExclusionRemoved(), REPLAYED)} />)
    const text = screen.getByRole('region').textContent ?? ''

    expect(text).toContain('62 prospects removed earlier go back into tiering.')
    expect(text).toContain('3 would now be tier 1')
    expect(text).toContain('9 would now be tier 2')
    expect(text).toContain('36 would be removed again')
    // A state nobody lands in is not listed.
    expect(text).not.toContain('would now be tier 3')
    expect(text).toContain('14 of them were removed before enrichment and go back to the buyer check.')
    expect(text).toContain('which uses credits')
    // What an approval does NOT do is said as plainly as what it does.
    expect(text).toContain('People already in a tier keep it.')
    expect(text).toContain('3 in tier 1 would be removed')
    expect(text).toContain('1 in tier 2 would be tier 1')
    expect(text).toContain('Replayed over 589 prospects with enrichment on file.')
  })

  it('uses the singular for one prospect', () => {
    const one: RetierView = {
      kind: 'replayed', requeued: 1, requeued_not_enriched: 1,
      requeued_outcome: [
        { to: 'tier_1', count: 0 }, { to: 'tier_2', count: 0 }, { to: 'tier_3', count: 0 }, { to: 'removed', count: 0 },
      ],
      survivors_moved: [], judged: 1,
    }
    render(<TargetingProposalPanel view={viewFor(before(), oneExclusionRemoved(), one)} />)
    const text = screen.getByRole('region').textContent ?? ''

    expect(text).toContain('1 prospect removed earlier goes back into tiering.')
    expect(text).toContain('1 of them was removed before enrichment and goes back to the buyer check.')
    expect(text).toContain('Nobody already in a tier would be judged differently.')
    expect(text).toContain('Replayed over 1 prospect with enrichment on file.')
  })

  it('says so when the replay could not be run, and does not print a zero in its place', () => {
    render(<TargetingProposalPanel view={viewFor(before(), oneExclusionRemoved(), { kind: 'unavailable', reason: 'x' })} />)
    const text = screen.getByRole('region').textContent ?? ''

    expect(text).toContain('The replay could not be run')
    expect(text).not.toContain('go back into tiering.')
    expect(text).not.toContain('No removed prospects')
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('approving', () => {
  it('keeps Approve off until the removed exclusion is ticked, then sends the fingerprint and both keys', async () => {
    const view = viewFor(before(), oneExclusionRemoved())
    const fetchMock = mockFetch(200, { approved: true })
    render(<TargetingProposalPanel view={view} />)

    expect(approveButton()).toBeDisabled()
    fireEvent.click(screen.getByLabelText(`Stop excluding the job title “${EXCLUDED_BEFORE[0]}”`))
    expect(approveButton()).toBeEnabled()

    fireEvent.click(approveButton())
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; body: string }]
    expect(url).toBe('/api/operator/icp-filter-spec/approve')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      document_id: DOC,
      fingerprint: view.fingerprint,
      // One tick on screen, and both places that title was excluded.
      confirmed_removals: [
        `job_titles_excluded:${EXCLUDED_BEFORE[0]}`,
        `buyer_criterion.reject:${EXCLUDED_BEFORE[0]}`,
      ],
    })
  })

  it('unticking turns Approve off again', () => {
    render(<TargetingProposalPanel view={viewFor(before(), oneExclusionRemoved())} />)
    const box = screen.getByRole('checkbox')
    fireEvent.click(box)
    fireEvent.click(box)
    expect(approveButton()).toBeDisabled()
  })

  it('shows the route\'s own words when it refuses, and does not refresh', async () => {
    mockFetch(409, { error: REFUSAL_MESSAGES.changed_since_shown, refused: 'changed_since_shown' })
    render(<TargetingProposalPanel view={viewFor(before(), afterWithCriterionHeld())} />)

    fireEvent.click(approveButton())
    expect(await screen.findByText(REFUSAL_MESSAGES.changed_since_shown)).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
    // And it can be tried again.
    expect(approveButton()).toBeEnabled()
  })

  it('says nothing was changed when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    render(<TargetingProposalPanel view={viewFor(before(), afterWithCriterionHeld())} />)

    fireEvent.click(approveButton())
    expect(await screen.findByText('Could not reach the server. Nothing was changed.')).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('first settings are approved from the same panel, and say what they are', () => {
    render(<TargetingProposalPanel view={viewFor(null, before())} />)
    const text = screen.getByRole('region').textContent ?? ''

    expect(text).toContain('First search settings, waiting for approval')
    expect(text).toContain('Nothing is sourced until these are approved.')
    expect(approveButton()).toBeEnabled()
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('rejecting', () => {
  it('asks once, says what rejecting does not do, then sends the fingerprint and no ticks', async () => {
    const view = viewFor(before(), after())
    const fetchMock = mockFetch(200, { rejected: true })
    render(<TargetingProposalPanel view={view} />)

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByText(/Rejecting leaves the search exactly as it is/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm reject' }))
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
    expect(url).toBe('/api/operator/icp-filter-spec/reject')
    expect(JSON.parse(init.body)).toEqual({ document_id: DOC, fingerprint: view.fingerprint })
  })

  it('can be rejected even when it cannot be approved', () => {
    render(<TargetingProposalPanel view={viewFor(before(), after())} />)
    expect(approveButton()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled()
  })

  it('Cancel backs out without sending anything', () => {
    const fetchMock = mockFetch(200, {})
    render(<TargetingProposalPanel view={viewFor(before(), after())} />)

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument()
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('when the proposal could not be loaded', () => {
  it('says a change may be waiting, and that the search keeps running', () => {
    render(<TargetingProposalUnavailable />)
    const text = screen.getByRole('alert').textContent ?? ''
    expect(text).toContain('could not be checked for a proposed change')
    expect(text).toContain('A change may be waiting for approval.')
    expect(text).toContain('The search keeps running on the current settings either way.')
  })
})

describe('Rule Zero: the panel\'s fixed copy names no role and no sector', () => {
  it('holds with every client value taken out', () => {
    // A view with no client values in it at all: no changes listed, no exclusions, a
    // replay made of numbers. Whatever text remains is the component's own.
    const empty: ProposalPanelView = {
      document_id: DOC, fingerprint: 'f', first_settings: false, changes: [], exclusions: [],
      blockers: [], criterion_held: null, cursor: { reset: true, why: 'request_changed' }, retier: REPLAYED,
    }
    const texts: string[] = []
    for (const view of [
      empty,
      { ...empty, first_settings: true, cursor: { reset: true, why: 'first_settings' } as const },
      { ...empty, cursor: { reset: false, why: 'request_unchanged' } as const, retier: { kind: 'none' } as const },
      { ...empty, cursor: { reset: true, why: 'request_not_built', detail: 'x' } as const, retier: { kind: 'unavailable', reason: 'x' } as const },
    ]) {
      const { container, unmount } = render(<TargetingProposalPanel view={view} />)
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
      texts.push(container.textContent ?? '')
      unmount()
    }
    const { container } = render(<TargetingProposalUnavailable />)
    texts.push(container.textContent ?? '')

    for (const text of texts) {
      expect(text.length).toBeGreaterThan(100)
      expect(findBannedContent(text), text).toEqual([])
    }
    // CONTROL: the scanner finds a banned word when there is one, taken by position.
    expect(findBannedContent(`a ${BANNED_TITLE_WORDS[0]}`)).toEqual([BANNED_TITLE_WORDS[0]])
  })
})
