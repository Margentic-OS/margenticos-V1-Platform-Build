// Tests for the client prospect roster grouping.
//
// The roster replaced a flat list that was unreachable after approval. Two things here
// are worth pinning rather than trusting to reading:
//
//   1. NOTHING DISAPPEARS. An earlier draft filtered on current sendability in both
//      states, which measured out at 15 already-approved prospects vanishing from the
//      live organisation's list. A client seeing someone they approved disappear reads it
//      as us removing them.
//   2. THE TWO STATES USE DIFFERENT RULES ON PURPOSE. Before approval the list excludes
//      anyone not currently sendable; after approval it keys on upload date instead, so
//      someone contacted before a rule changed stays visible.

import { describe, it, expect } from 'vitest'
import {
  buildRosterGroups,
  defaultGroupKey,
  countPending,
  countRoster,
  NOT_YET_IN_CAMPAIGN_KEY,
} from '../prospect-roster'
import type { RosterProspect } from '../prospect-roster'

function prospect(overrides: Partial<RosterProspect> & { id: string }): RosterProspect {
  return {
    first_name: 'A',
    last_name: 'B',
    company_name: 'Co',
    job_title: 'Role',
    linkedin_url: null,
    website_url: null,
    client_review_status: 'approved',
    outbound_upload_attempted_at: null,
    email_send_eligible: true,
    ...overrides,
  }
}

describe('buildRosterGroups: what is excluded', () => {
  it('excludes a prospect the client rejected', () => {
    const groups = buildRosterGroups([
      prospect({ id: 'keep' }),
      prospect({ id: 'gone', client_review_status: 'rejected' }),
    ])

    expect(countRoster(groups)).toBe(1)
    expect(groups.flatMap(g => g.prospects).map(p => p.id)).toEqual(['keep'])
  })

  it('excludes a pending prospect that cannot currently be emailed', () => {
    const groups = buildRosterGroups([
      prospect({ id: 'pending-unsendable', client_review_status: 'pending_review', email_send_eligible: false }),
      prospect({ id: 'pending-null-eligibility', client_review_status: 'pending_review', email_send_eligible: null }),
      prospect({ id: 'pending-sendable', client_review_status: 'pending_review' }),
    ])

    expect(groups.flatMap(g => g.prospects).map(p => p.id)).toEqual(['pending-sendable'])
  })

  // The regression that prompted the reversal. These are the 15 on the live organisation.
  it('KEEPS an approved prospect that cannot currently be emailed', () => {
    const groups = buildRosterGroups([
      prospect({ id: 'approved-catch-all', email_send_eligible: false }),
      prospect({ id: 'approved-unknown', email_send_eligible: null }),
    ])

    expect(countRoster(groups)).toBe(2)
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe(NOT_YET_IN_CAMPAIGN_KEY)
  })

  // Two live prospects are country_excluded_de but were uploaded and mailed before that
  // exclusion existed. A record of who was contacted has to include them.
  it('KEEPS an uploaded prospect that has since become unsendable', () => {
    const groups = buildRosterGroups([
      prospect({
        id: 'mailed-then-excluded',
        email_send_eligible: false,
        outbound_upload_attempted_at: '2026-08-21T09:00:00Z',
      }),
    ])

    expect(countRoster(groups)).toBe(1)
    expect(groups[0].key).toBe('batch:2026-08-21')
  })
})

describe('buildRosterGroups: grouping', () => {
  it('groups by upload day, newest batch first, un-uploaded last', () => {
    const groups = buildRosterGroups([
      prospect({ id: 'a', outbound_upload_attempted_at: '2026-08-21T09:00:00Z' }),
      prospect({ id: 'b', outbound_upload_attempted_at: '2026-09-07T11:00:00Z' }),
      prospect({ id: 'c' }),
      prospect({ id: 'd', outbound_upload_attempted_at: '2026-08-29T23:59:00Z' }),
    ])

    expect(groups.map(g => g.key)).toEqual([
      'batch:2026-09-07',
      'batch:2026-08-29',
      'batch:2026-08-21',
      NOT_YET_IN_CAMPAIGN_KEY,
    ])
  })

  it('puts two uploads on the same UTC day in one group', () => {
    const groups = buildRosterGroups([
      prospect({ id: 'a', outbound_upload_attempted_at: '2026-09-07T00:30:00Z' }),
      prospect({ id: 'b', outbound_upload_attempted_at: '2026-09-07T22:45:00Z' }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].prospects).toHaveLength(2)
  })

  it('labels a batch in plain language, with no industry or client wording', () => {
    const groups = buildRosterGroups([
      prospect({ id: 'a', outbound_upload_attempted_at: '2026-09-07T11:00:00Z' }),
      prospect({ id: 'b' }),
    ])

    expect(groups[0].label).toBe('7 Sep 2026')
    expect(groups[1].label).toBe('Not yet in the campaign')
  })

  it('omits the un-uploaded group entirely when everyone is in a batch', () => {
    const groups = buildRosterGroups([
      prospect({ id: 'a', outbound_upload_attempted_at: '2026-09-07T11:00:00Z' }),
    ])

    expect(groups.map(g => g.key)).toEqual(['batch:2026-09-07'])
  })
})

describe('buildRosterGroups: task versus record', () => {
  it('marks a group as a task only while it holds a pending prospect', () => {
    const groups = buildRosterGroups([
      prospect({ id: 'uploaded', outbound_upload_attempted_at: '2026-09-07T11:00:00Z' }),
      prospect({ id: 'waiting', client_review_status: 'pending_review' }),
    ])

    const uploaded = groups.find(g => g.key === 'batch:2026-09-07')!
    const notYet = groups.find(g => g.key === NOT_YET_IN_CAMPAIGN_KEY)!

    expect(uploaded.isTask).toBe(false)
    expect(notYet.isTask).toBe(true)
  })

  it('marks every group as a record once nothing is pending', () => {
    const groups = buildRosterGroups([
      prospect({ id: 'a', outbound_upload_attempted_at: '2026-09-07T11:00:00Z' }),
      prospect({ id: 'b' }),
    ])

    expect(groups.every(g => g.isTask)).toBe(false)
    expect(groups.some(g => g.isTask)).toBe(false)
  })

  it('opens on the group with work in it, not the newest batch', () => {
    const groups = buildRosterGroups([
      prospect({ id: 'uploaded', outbound_upload_attempted_at: '2026-09-07T11:00:00Z' }),
      prospect({ id: 'waiting', client_review_status: 'pending_review' }),
    ])

    expect(defaultGroupKey(groups)).toBe(NOT_YET_IN_CAMPAIGN_KEY)
  })

  it('opens on the newest batch when there is no work', () => {
    const groups = buildRosterGroups([
      prospect({ id: 'a', outbound_upload_attempted_at: '2026-08-21T09:00:00Z' }),
      prospect({ id: 'b', outbound_upload_attempted_at: '2026-09-07T11:00:00Z' }),
    ])

    expect(defaultGroupKey(groups)).toBe('batch:2026-09-07')
  })

  it('has no group to open when the roster is empty', () => {
    expect(defaultGroupKey(buildRosterGroups([]))).toBeNull()
  })
})

// The shape measured on the live organisation on 2026-09-07, so a future change that
// silently drops a group or a population fails here rather than in front of a client.
describe('buildRosterGroups: the live 2026-09-07 shape', () => {
  const live: RosterProspect[] = [
    ...Array.from({ length: 12 }, (_, i) =>
      prospect({ id: `aug21-${i}`, outbound_upload_attempted_at: '2026-08-21T09:00:00Z' })),
    ...Array.from({ length: 8 }, (_, i) =>
      prospect({ id: `aug29-${i}`, outbound_upload_attempted_at: '2026-08-29T09:00:00Z' })),
    ...Array.from({ length: 68 }, (_, i) =>
      prospect({ id: `sep07-${i}`, outbound_upload_attempted_at: '2026-09-07T09:00:00Z' })),
    // Approved, never uploaded, not currently sendable. These must survive.
    ...Array.from({ length: 15 }, (_, i) =>
      prospect({ id: `notyet-${i}`, email_send_eligible: false })),
    // The single row the client rejected. This is the only one that should leave.
    prospect({ id: 'rejected', client_review_status: 'rejected' }),
  ]

  it('produces 12 / 8 / 68 / 15 and a roster of 103 from the 104 on the page', () => {
    const groups = buildRosterGroups(live)

    expect(groups.map(g => [g.label, g.prospects.length])).toEqual([
      ['7 Sep 2026', 68],
      ['29 Aug 2026', 8],
      ['21 Aug 2026', 12],
      ['Not yet in the campaign', 15],
    ])
    expect(countRoster(groups)).toBe(103)
    expect(live).toHaveLength(104)
  })

  it('loses no already-approved prospect from view', () => {
    const groups = buildRosterGroups(live)
    const approvedOnPage = live.filter(p => p.client_review_status === 'approved')
    const onRoster = new Set(groups.flatMap(g => g.prospects).map(p => p.id))

    expect(approvedOnPage).toHaveLength(103)
    expect(approvedOnPage.every(p => onRoster.has(p.id))).toBe(true)
  })

  it('reports nothing pending, so the whole roster is a record', () => {
    const groups = buildRosterGroups(live)

    expect(countPending(groups)).toBe(0)
    expect(groups.some(g => g.isTask)).toBe(false)
  })
})
