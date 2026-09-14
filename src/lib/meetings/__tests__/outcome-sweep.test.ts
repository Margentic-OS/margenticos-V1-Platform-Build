// The daily meeting-outcome sweep, driven for real against the STRICT fake database.
//
// THIS IS THE FILE THAT GUARDS EVERY PATH TO BILLABLE. The 72-hour job it replaces could make
// a meeting billable with no human involved, and the tests that were supposed to cover that
// asserted their own copied rule ("const is_billable = decision === 'held'") rather than
// calling the code. Every test here calls the real sweep and reads the rows back.
//
// The four rules, each with its own test below:
//   1. nothing is billed that nobody was asked about
//   2. nothing is billed before its calendar deadline
//   3. a human answer at any point before the deadline wins
//   4. nothing unmatched is billed, ever (backstop-excludes-unmatched.test.ts)
//
// MUTATION-PROVED on commit, each turning a named test red:
//   dropping .not('confirmation_sent_at', 'is', null) from the backstop update
//   comparing against a fixed 72 hours instead of bill_unconfirmed_after
//   dropping .eq('held_decision_locked', false) from the backstop update

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStrictFakeDb, type StrictFakeDb } from './helpers/strict-fake-db'
import { sweepMeetingOutcomes } from '../outcome-sweep'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }))

const sendOutcomeConfirmation = vi.hoisted(() => vi.fn(async () => ({ sent: true as const })))
vi.mock('@/lib/notifications/send-outcome-confirmation', () => ({ sendOutcomeConfirmation }))

// A meeting on 20 September has until the end of October. These two "now"s sit either side.
const BEFORE_DEADLINE = new Date('2026-10-26T09:34:00.000Z') // 6 days left
const AFTER_DEADLINE = new Date('2026-11-05T09:34:00.000Z')
const OCTOBER_DEADLINE = '2026-10-31T23:59:59.999Z'

type Overrides = Record<string, unknown>

function meeting(id: string, overrides: Overrides = {}) {
  return {
    id,
    organisation_id: 'org-a',
    prospect_id: 'prospect-1',
    meeting_status: 'booked',
    held_decision_locked: false,
    is_billable: false,
    billable_basis: null,
    held_confirmed_by: null,
    scheduled_start_at: '2026-09-20T14:00:00.000Z',
    scheduled_end_at: '2026-09-20T14:30:00.000Z',
    bill_unconfirmed_after: OCTOBER_DEADLINE,
    outcome_requested_at: null,
    confirmation_sent_at: null,
    last_reminded_at: null,
    reminder_count: 0,
    ...overrides,
  }
}

const ASKED = {
  outcome_requested_at: '2026-09-20T15:00:00.000Z',
  confirmation_sent_at: '2026-09-20T15:00:00.000Z',
}

let db: StrictFakeDb
function seed(meetings: Overrides[], opts: { noClient?: boolean } = {}) {
  db = createStrictFakeDb({
    organisations: [{ id: 'org-a', name: 'Apex Consulting', founder_first_name: 'Alex', archived_at: null }],
    users: opts.noClient
      ? []
      : [{ id: 'u-1', organisation_id: 'org-a', role: 'client', email: 'alex@apexconsulting.test' }],
    prospects: [{ id: 'prospect-1', first_name: 'Jordan', company_name: 'Northwind' }],
    meetings,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  seed([meeting('m-1', ASKED)])
})

describe('rule 1: nothing is billed that nobody was asked about', () => {
  it('leaves a past-deadline meeting alone when the confirmation never went out, and says so', async () => {
    seed([meeting('never-asked')]) // confirmation_sent_at null
    const run = await sweepMeetingOutcomes(db.client, AFTER_DEADLINE)

    expect(run.billed_unconfirmed).toBe(0)
    expect(run.past_deadline_never_asked).toBe(1)
    expect(db.tables.meetings[0]).toMatchObject({ is_billable: false, billable_basis: null, held_decision_locked: false })

    // And it reaches the operator rather than sitting silently unresolved for ever.
    expect(run.due_to_bill_unconfirmed).toEqual([
      expect.objectContaining({ meetingId: 'never-asked', neverAsked: true }),
    ])
  })

  it('bills the one that WAS asked, in the same run, so the exclusion is not just inaction', async () => {
    seed([meeting('asked', ASKED), meeting('never-asked')])
    const run = await sweepMeetingOutcomes(db.client, AFTER_DEADLINE)

    expect(run.billed_unconfirmed).toBe(1)
    expect(db.tables.meetings.find(m => m.id === 'asked')).toMatchObject({
      is_billable: true, billable_basis: 'unconfirmed_backstop', held_decision_locked: true,
    })
    expect(db.tables.meetings.find(m => m.id === 'never-asked')).toMatchObject({ is_billable: false })
  })
})

describe('rule 2: nothing is billed before its calendar deadline', () => {
  it('does not bill a meeting six days before its deadline', async () => {
    const run = await sweepMeetingOutcomes(db.client, BEFORE_DEADLINE)
    expect(run.billed_unconfirmed).toBe(0)
    expect(db.tables.meetings[0]).toMatchObject({ is_billable: false, held_decision_locked: false })
  })

  it('does not bill a meeting that is only three days old, which is when the deleted job did', async () => {
    // A meeting on 30 October, three days before this run. The 72-hour job would have marked
    // it held and billable. Its real deadline is the end of November.
    seed([meeting('recent', {
      ...ASKED,
      scheduled_start_at: '2026-10-30T14:00:00.000Z',
      scheduled_end_at: '2026-10-30T14:30:00.000Z',
      bill_unconfirmed_after: '2026-11-30T23:59:59.999Z',
    })])

    const run = await sweepMeetingOutcomes(db.client, new Date('2026-11-02T09:34:00.000Z'))

    expect(run.billed_unconfirmed).toBe(0)
    expect(db.tables.meetings[0]).toMatchObject({ is_billable: false, billable_basis: null })
  })
})

describe('rule 3: a human answer before the deadline wins', () => {
  it('cannot touch a meeting whose decision is locked', async () => {
    seed([meeting('decided', {
      ...ASKED,
      meeting_status: 'no_show',
      held_decision_locked: true,
      held_confirmed_by: 'client',
    })])

    const run = await sweepMeetingOutcomes(db.client, AFTER_DEADLINE)

    expect(run.billed_unconfirmed).toBe(0)
    expect(db.tables.meetings[0]).toMatchObject({
      meeting_status: 'no_show', is_billable: false, billable_basis: null, held_confirmed_by: 'client',
    })
  })

  it('does not bill a meeting the backstop already billed, which would be a second charge', async () => {
    // ═══════════════════════════════════════════════════════════════════════════
    // THE FIXTURE ABOVE COULD NOT CATCH THIS, AND THE MUTATION SAID SO.
    //
    // Removing held_decision_locked from BOTH the read and the update left every test in
    // this file green, because the "decided" meeting above also carries meeting_status
    // 'no_show', so the STATUS filter was excluding it and the lock filter was never the
    // thing doing the work. A guard that no test can distinguish from its neighbour is an
    // uncovered guard whatever the count says.
    //
    // This is the state where the lock is the ONLY guard, and it is not a contrived one: it
    // is exactly what the backstop itself writes. It sets is_billable and the basis and
    // deliberately LEAVES meeting_status as 'booked', because billing an unconfirmed meeting
    // is not a finding that anybody attended. So an already-billed meeting is
    // {booked, locked, billable}, it matches the status filter, and only the lock keeps the
    // next daily run from billing it again.
    // ═══════════════════════════════════════════════════════════════════════════
    seed([meeting('already-billed', {
      ...ASKED,
      meeting_status: 'booked',
      held_decision_locked: true,
      is_billable: true,
      billable_basis: 'unconfirmed_backstop',
    })])

    const run = await sweepMeetingOutcomes(db.client, AFTER_DEADLINE)

    expect(run.billed_unconfirmed).toBe(0)
    expect(db.tables.meetings[0]).toMatchObject({
      is_billable: true,
      billable_basis: 'unconfirmed_backstop',
    })
  })

  it('a meeting the client confirmed as held keeps the client as its basis', async () => {
    seed([meeting('confirmed', {
      ...ASKED,
      meeting_status: 'held',
      held_decision_locked: true,
      held_confirmed_by: 'client',
      is_billable: true,
      billable_basis: 'client_confirmed',
    })])

    await sweepMeetingOutcomes(db.client, AFTER_DEADLINE)

    // The backstop must never overwrite how a meeting became billable. That distinction is
    // what the client sees on the invoice.
    expect(db.tables.meetings[0]).toMatchObject({ billable_basis: 'client_confirmed' })
  })
})

describe('asking, once, after the meeting has finished', () => {
  it('asks once the slot has passed and records that it asked', async () => {
    seed([meeting('m-1')])
    const run = await sweepMeetingOutcomes(db.client, BEFORE_DEADLINE)

    expect(run.confirmations_sent).toBe(1)
    expect(sendOutcomeConfirmation).toHaveBeenCalledTimes(1)
    expect(db.tables.meetings[0].confirmation_sent_at).not.toBeNull()
    expect(db.tables.meetings[0].outcome_requested_at).not.toBeNull()
  })

  it('does not ask while the meeting is still running', async () => {
    seed([meeting('future', {
      scheduled_start_at: '2026-10-26T09:00:00.000Z',
      scheduled_end_at: '2026-10-26T10:00:00.000Z',
      bill_unconfirmed_after: '2026-11-30T23:59:59.999Z',
    })])

    // 09:34, half way through a meeting that ends at 10:00.
    const run = await sweepMeetingOutcomes(db.client, BEFORE_DEADLINE)

    expect(run.confirmations_sent).toBe(0)
    expect(sendOutcomeConfirmation).not.toHaveBeenCalled()
  })

  it('does not ask twice, so a job that runs again the next day does not nag', async () => {
    seed([meeting('m-1')])
    await sweepMeetingOutcomes(db.client, BEFORE_DEADLINE)
    sendOutcomeConfirmation.mockClear()

    const second = await sweepMeetingOutcomes(db.client, new Date('2026-10-27T09:34:00.000Z'))

    expect(second.confirmations_sent).toBe(0)
    // The reminder path may fire here, which is correct. What must not happen is a second
    // FIRST ask, so this asserts on the reminder flag rather than on call count alone.
    for (const call of sendOutcomeConfirmation.mock.calls as unknown as Array<[{ reminderIndex: number | null }]>) {
      expect(call[0].reminderIndex).not.toBeNull()
    }
  })

  it('does not stamp "asked" when the send failed, so the backstop cannot bill it later', async () => {
    // THE CASE THAT MATTERS MOST. A bounced or refused email must leave the meeting unasked,
    // because "asked" is the only thing standing between silence and an automatic charge.
    sendOutcomeConfirmation.mockResolvedValueOnce({ sent: false, reason: 'no_secret' } as never)
    seed([meeting('m-1')])

    const run = await sweepMeetingOutcomes(db.client, BEFORE_DEADLINE)

    expect(run.confirmations_sent).toBe(0)
    expect(db.tables.meetings[0].confirmation_sent_at).toBeNull()
  })
})

describe('reminders work back from the real deadline', () => {
  it('sends a reminder and records how many have gone out', async () => {
    seed([meeting('m-1', ASKED)])
    const run = await sweepMeetingOutcomes(db.client, BEFORE_DEADLINE) // 6 days left

    expect(run.reminders_sent).toBe(1)
    // ONE, not two. Six days out with nothing sent yet, the client gets the FIRST unsent
    // reminder rather than the one whose threshold has just passed. A client who has had no
    // reminder at all must not have the first one skipped because the job was late.
    expect(db.tables.meetings[0]).toMatchObject({ reminder_count: 1 })
    expect(db.tables.meetings[0].last_reminded_at).not.toBeNull()
  })

  it('sends no reminder while the deadline is far off', async () => {
    seed([meeting('m-1', ASKED)])
    const run = await sweepMeetingOutcomes(db.client, new Date('2026-10-05T09:34:00.000Z'))
    expect(run.reminders_sent).toBe(0)
    expect(sendOutcomeConfirmation).not.toHaveBeenCalled()
  })
})

describe('what the operator sees', () => {
  it('lists a meeting within seven days of its deadline', async () => {
    seed([meeting('m-1', ASKED)])
    const run = await sweepMeetingOutcomes(db.client, BEFORE_DEADLINE)
    expect(run.due_to_bill_unconfirmed).toEqual([
      expect.objectContaining({ meetingId: 'm-1', daysLeft: 6, neverAsked: false, organisationName: 'Apex Consulting' }),
    ])
  })

  it('does not list a meeting three weeks out, so the list stays actionable', async () => {
    seed([meeting('m-1', ASKED)])
    const run = await sweepMeetingOutcomes(db.client, new Date('2026-10-10T09:34:00.000Z'))
    expect(run.due_to_bill_unconfirmed).toEqual([])
  })
})

describe('a failure is never reported as a quiet success', () => {
  it('throws when the organisations read is refused, rather than returning an empty run', async () => {
    // resolve-auto-held reported 31 consecutive healthy runs over a read that was returning
    // nothing at all, because it caught the error and returned []. This is that shape, banned.
    const refusing = {
      from: () => ({
        select: () => ({ is: async () => ({ data: null, error: { message: 'permission denied for table organisations' } }) }),
      }),
    }
    await expect(sweepMeetingOutcomes(refusing as never)).rejects.toThrow(/permission denied/)
  })

  it('counts an organisation whose meetings read fails, and carries on with the others', async () => {
    seed([meeting('m-1', ASKED)])
    // The fake throws by name on an unseeded table; dropping prospects makes the per-meeting
    // read fail inside one organisation without breaking the outer loop.
    delete db.tables.prospects

    const run = await sweepMeetingOutcomes(db.client, AFTER_DEADLINE)

    expect(run.organisations_failed).toBe(1)
    expect(run.billed_unconfirmed).toBe(0)
  })

  it('reports no client address rather than billing a client it could not ask', async () => {
    seed([meeting('m-1')], { noClient: true })
    const run = await sweepMeetingOutcomes(db.client, BEFORE_DEADLINE)

    expect(run.confirmations_sent).toBe(0)
    expect(db.tables.meetings[0].confirmation_sent_at).toBeNull()
  })
})
