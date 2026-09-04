import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildCheckStates,
  categoriesInOrder,
  categoryTitle,
  type Check,
  type MonitorEvent,
} from '@/lib/monitor/check-state'

function check(code: string, category = 'liveness'): Check {
  return { code, title: `${code} title`, description: 'd', category, is_scheduled: true }
}

function event(partial: Partial<MonitorEvent> & { check_code: string }): MonitorEvent {
  return {
    id: 1,
    state: 'PROBLEM',
    detail: null,
    created_at: '2026-08-28T19:45:00Z',
    resolved_at: null,
    acknowledged_at: null,
    acknowledged_note: null,
    ...partial,
  }
}

describe('buildCheckStates', () => {
  it('takes state and detail from the LIVE view, not from the stored event', () => {
    // The defect in one assertion. The stored event said OK with a three-week-old
    // detail; the live view is the only thing that describes now.
    const states = buildCheckStates(
      [check('MON-001')],
      [event({ check_code: 'MON-001', state: 'OK', detail: 'Last run: 2026-08-09 01:00:00 UTC' })],
      { 'MON-001': { state: 'PROBLEM', detail: 'Last run FAILED: boom', last_run: '2026-09-04T22:00:00Z' } },
    )

    expect(states[0].current_state).toBe('PROBLEM')
    expect(states[0].detail).toBe('Last run FAILED: boom')
    expect(states[0].last_run).toBe('2026-09-04T22:00:00Z')
    expect(states[0].from_live).toBe(true)
  })

  it('falls back to the stored event when the view read failed, and SAYS SO', () => {
    // A silent fallback would be the original bug wearing the fix's clothes.
    const states = buildCheckStates(
      [check('MON-001')],
      [event({ check_code: 'MON-001', state: 'OK', detail: 'stale detail' })],
      {},
      { 'MON-001': 'permission denied' },
    )

    expect(states[0].current_state).toBe('OK')
    expect(states[0].detail).toBe('stale detail')
    expect(states[0].from_live).toBe(false)
    expect(states[0].live_error).toBe('permission denied')
    expect(states[0].last_run, 'a fallback has no live run timestamp to show').toBeNull()
  })

  it('reports UNKNOWN when there is neither a live reading nor an event', () => {
    const states = buildCheckStates([check('MON-008-UNSCHEDULED', 'unscheduled')], [], {})
    expect(states[0].current_state).toBe('UNKNOWN')
    expect(states[0].from_live).toBe(false)
  })

  it('uses the NEWEST event per check, given events ordered created_at DESC', () => {
    const states = buildCheckStates(
      [check('MON-011')],
      [
        event({ check_code: 'MON-011', id: 60, detail: 'newest', created_at: '2026-08-28T19:45:00Z' }),
        event({ check_code: 'MON-011', id: 58, detail: 'older', created_at: '2026-08-27T18:15:00Z' }),
      ],
      {},
    )
    expect(states[0].lastEvent?.id).toBe(60)
  })
})

describe('acknowledgement', () => {
  const acknowledged = event({
    check_code: 'MON-011',
    id: 60,
    state: 'PROBLEM',
    detail: '2 failed agent run(s) in last 7 days. Newest: 2026-08-28 19:43:37 UTC',
    acknowledged_at: '2026-08-28T20:06:16Z',
    acknowledged_note: 'Fixing',
  })

  it('keeps suppressing an acknowledged problem', () => {
    const states = buildCheckStates(
      [check('MON-011', 'tier1')],
      [acknowledged],
      { 'MON-011': { state: 'PROBLEM', detail: acknowledged.detail, last_run: null } },
    )
    expect(states[0].is_acknowledged).toBe(true)
    expect(states[0].detail_changed_since_ack).toBe(false)
  })

  it('MARKS an acknowledged problem whose live detail has moved on', () => {
    // The exact production case. Acknowledged 2026-08-28 against "2 failed",
    // three more failures landed, no new row was written because the state never
    // left PROBLEM, and the board showed 2 for seven days.
    const states = buildCheckStates(
      [check('MON-011', 'tier1')],
      [acknowledged],
      {
        'MON-011': {
          state: 'PROBLEM',
          detail: '5 failed agent run(s) in last 7 days. Newest: 2026-09-03 19:16:59 UTC',
          last_run: null,
        },
      },
    )

    expect(states[0].is_acknowledged, 'suppression is kept, by design').toBe(true)
    expect(states[0].detail_changed_since_ack).toBe(true)
    expect(states[0].detail).toContain('5 failed')
    expect(states[0].lastEvent?.detail, 'the acknowledged reading is still available to compare').toContain('2 failed')
  })

  it('never marks a change it cannot see, when there is no live reading', () => {
    // Comparing a stored detail against itself always says "unchanged". That is
    // how this went unnoticed, and a false "unchanged" is worse than no marker.
    const states = buildCheckStates([check('MON-011', 'tier1')], [acknowledged], {}, { 'MON-011': 'boom' })
    expect(states[0].detail_changed_since_ack).toBe(false)
    expect(states[0].from_live).toBe(false)
  })

  it('does not treat a RESOLVED problem as acknowledged or open', () => {
    const states = buildCheckStates(
      [check('MON-011', 'tier1')],
      [event({ check_code: 'MON-011', resolved_at: '2026-08-27T18:15:00Z', acknowledged_at: '2026-08-19T23:38:00Z' })],
      { 'MON-011': { state: 'OK', detail: 'No unresolved failed agent runs', last_run: null } },
    )
    expect(states[0].is_open_problem).toBe(false)
    expect(states[0].is_acknowledged).toBe(false)
  })

  it('a live PROBLEM with no transition row yet is open but not acknowledgeable', () => {
    const states = buildCheckStates(
      [check('MON-024', 'data_integrity')],
      [],
      { 'MON-024': { state: 'PROBLEM', detail: 'anon can read something', last_run: null } },
    )
    expect(states[0].current_state).toBe('PROBLEM')
    expect(states[0].is_open_problem, 'no row exists, so there is nothing to acknowledge').toBe(false)
    expect(states[0].lastEvent).toBeUndefined()
  })
})

describe('category sections', () => {
  it('returns EVERY category present, so a monitor can never render nowhere', () => {
    // The page hardcoded liveness, tier1 and unscheduled. monitor_checks held
    // five categories, so seven monitors appeared in no section at all,
    // including the privilege audit (MON-024) and the suppression audit (MON-026).
    const states = buildCheckStates(
      [
        check('MON-001', 'liveness'),
        check('MON-011', 'tier1'),
        check('MON-017', 'blind-spot'),
        check('MON-024', 'data_integrity'),
        check('MON-008', 'unscheduled'),
      ],
      [],
      {},
    )

    expect(categoriesInOrder(states)).toEqual([
      'liveness',
      'tier1',
      'blind-spot',
      'data_integrity',
      'unscheduled',
    ])
  })

  it('includes a category nobody has heard of yet, sorted after the known ones', () => {
    // The property that matters: this is what stops the next migration's category
    // from being invisible the way blind-spot and data_integrity were.
    const states = buildCheckStates(
      [check('MON-001', 'liveness'), check('MON-099', 'brand_new_category')],
      [],
      {},
    )
    expect(categoriesInOrder(states)).toEqual(['liveness', 'brand_new_category'])
    expect(categoryTitle('brand_new_category')).toBe('brand_new_category Checks')
  })

  it('gives every category seeded by a migration a section', () => {
    // Holds the code against the WORLD rather than against itself. If a migration
    // seeds monitor_checks with a category the board has no title for, it still
    // renders (categoriesInOrder is derived), but this fails so the title gets
    // written deliberately rather than defaulting.
    const migrationsDir = join(process.cwd(), 'supabase', 'migrations')
    const categories = new Set<string>()

    for (const file of readdirSync(migrationsDir)) {
      if (!file.endsWith('.sql')) continue
      const sql = readFileSync(join(migrationsDir, file), 'utf8')
      for (const m of sql.matchAll(/'(liveness|tier1|blind-spot|data_integrity|unscheduled)'/g)) {
        categories.add(m[1])
      }
    }

    expect(categories.size, 'found no monitor categories in migrations, so this test proves nothing')
      .toBeGreaterThan(0)

    const untitled = [...categories].filter(c => categoryTitle(c) === `${c} Checks`).sort()
    expect(untitled, `these categories have no written section title: ${untitled.join(', ')}`).toEqual([])
  })
})
