import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * WHY THIS TEST EXISTS.
 *
 * Since 2026-09-11 mon_001 can read a job as switched off on purpose. That is a new way for a
 * monitor to say OK while its job is not running, so the test guards the half that matters
 * more: a job that is on and stalled, or off with nobody having declared it off, must still
 * go red.
 *
 * Three invariants, read off the newest migration that defines mon_001:
 *
 *   1. "Off" needs BOTH sides. Any branch that returns OK while reading the live pg_cron flag
 *      must also read the registry's declaration. A branch keyed on cron.job.active alone
 *      would silence the monitor for anyone who pauses the job by hand.
 *   2. The staleness and failed-run branches still return PROBLEM.
 *   3. The state CASE and the detail CASE test the same conditions in the same order. mon_026's
 *      two CASEs drifted on 2026-09-10 and narrated a failed read as a measured zero, which is
 *      what mon-026-detail-mirrors-state.test.ts was written for.
 *
 * WHAT THIS CANNOT DO. It reads the files, so it proves what the newest migration DEFINES, not
 * what production HOLDS. The live proof is the probe set recorded in
 * 20260911120000_cron_registry_declares_stagger_and_pause.sql.
 */

function stripSqlComments(sql: string): string {
  // Tracks single-quote state so a -- inside a string literal is left alone.
  return sql
    .split('\n')
    .map(line => {
      let inString = false
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "'") inString = !inString
        else if (!inString && line[i] === '-' && line[i + 1] === '-') return line.slice(0, i)
      }
      return line
    })
    .join('\n')
}

function latestMon001View(): string {
  const dir = join(process.cwd(), 'supabase', 'migrations')
  const defines = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:public\.)?mon_001\b/i
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .filter(f => defines.test(readFileSync(join(dir, f), 'utf8')))

  expect(files.length, 'no migration defines mon_001, so this test proves nothing').toBeGreaterThan(0)

  const sql = stripSqlComments(readFileSync(join(dir, files[files.length - 1]), 'utf8'))
  // The view statement alone. A view body holds no semicolon, so the first one ends it.
  return sql.slice(sql.search(defines)).split(';')[0]
}

type Branch = { condition: string; result: string }

function branches(caseBody: string): Branch[] {
  return caseBody
    .split(/\bWHEN\b/i)
    .slice(1)
    .map(chunk => {
      const [condition, rest = ''] = chunk.split(/\bTHEN\b/i)
      return { condition: condition.replace(/\s+/g, ' ').trim(), result: rest.trim() }
    })
}

describe('mon_001 reads a job as off only when it is declared off', () => {
  const view = latestMon001View()
  const [beforeState, afterState = ''] = view.split(/END\s+AS\s+state/i)
  const stateBranches = branches(beforeState.split(/\bCASE\b/i).pop() ?? '')
  const detailBranches = branches(afterState.split(/END\s+AS\s+detail/i)[0].split(/\bCASE\b/i).pop() ?? '')
  const stateResult = (b: Branch) => /^'(\w+)'/.exec(b.result)?.[1]

  it('finds both CASE expressions, so the assertions below are not vacuous', () => {
    expect(stateBranches.length, 'could not isolate the state CASE').toBeGreaterThan(4)
    expect(detailBranches.length, 'could not isolate the detail CASE').toBeGreaterThan(4)
    expect(stateBranches.every(b => stateResult(b)), 'a state branch returns something other than a literal')
      .toBe(true)
  })

  it('never returns OK on the live pg_cron flag alone', () => {
    const offBranches = stateBranches.filter(b => /\blive_active\b/i.test(b.condition) && stateResult(b) === 'OK')
    expect(offBranches.length, 'there is no "switched off, as declared" branch at all').toBeGreaterThan(0)
    for (const b of offBranches) {
      expect(
        b.condition,
        'an OK branch reads cron.job.active without the registry declaration, so pausing the ' +
        'job by hand would silence this monitor',
      ).toMatch(/\bdeclared_active\s+IS\s+FALSE\b/i)
    }
  })

  it('still returns PROBLEM for a job that is on and stale, or on and failing', () => {
    const stale = stateBranches.find(b => /now\(\)\s*-\s*latest\.ran_at\)\)\s*\/\s*60\s*>\s*75$/i.test(b.condition))
    const failed = stateBranches.find(b => /^latest\.ok\s*=\s*false$/i.test(b.condition))
    expect(stale, 'the 75-minute staleness branch is gone').toBeDefined()
    expect(failed, 'the failed-run branch is gone').toBeDefined()
    expect(stateResult(stale as Branch)).toBe('PROBLEM')
    expect(stateResult(failed as Branch)).toBe('PROBLEM')
  })

  it('returns PROBLEM for a job switched off with nothing declaring it off', () => {
    const undeclared = stateBranches.find(b => /^sw\.live_active\s+IS\s+FALSE$/i.test(b.condition))
    expect(undeclared, 'the "switched off by hand" branch is gone').toBeDefined()
    expect(stateResult(undeclared as Branch)).toBe('PROBLEM')
  })

  it('tests the same conditions in the same order in the state and detail CASEs', () => {
    expect(
      detailBranches.map(b => b.condition),
      'the detail CASE no longer mirrors the state CASE, so a state can be explained by the ' +
      'sentence written for a different condition',
    ).toEqual(stateBranches.map(b => b.condition))
  })
})
