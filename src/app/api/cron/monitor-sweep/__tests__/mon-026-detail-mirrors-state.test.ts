import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * WHY THIS TEST EXISTS.
 *
 * mon_026 holds TWO CASE expressions over the same conditions, one producing `state` and
 * one producing `detail`. They drifted. The state CASE tested `incomplete` before
 * `uploaded_count = 0`; the detail CASE did not test `incomplete` at all.
 *
 * So when the reconcile sweep could not read prospects (PostgREST Gateway Timeout, twice on
 * 2026-09-09/10), the snapshot stored incomplete = true and uploaded_count = 0, and the
 * monitor said PROBLEM with the reason "no prospect has been uploaded". 97 were uploaded.
 * The state was right and the sentence was false, in the reassuring direction: it reads as a
 * campaign that has not started rather than a database that timed out.
 *
 * THE INVARIANT. Every condition the STATE case evaluates BEFORE `uploaded_count = 0` must
 * also be evaluated by the DETAIL case before `uploaded_count = 0`.
 *
 * The reason is precise, and it is why this is not just tidiness: the `uploaded_count = 0`
 * branch of DETAIL asserts a FACT ABOUT THE WORLD. It must never be reached when an earlier
 * condition has already established that the counts are not a measurement.
 *
 * WHAT THIS TEST CANNOT DO, stated so the next reader does not over-trust it. It reads the
 * migrations on disk, so it proves what the newest migration DEFINES, not what the database
 * currently HOLDS. A hand-edited view in production would pass this. The live equivalent is
 * a monitor-sweep read of mon_026 itself; this is the cheap early warning that runs on every
 * commit.
 */

/**
 * Strip -- line comments, tracking single-quote state so a -- inside a string literal is
 * left alone. Without this, the word CASE or WHEN inside a comment is parsed as structure.
 * That is not hypothetical: the first version of this test cut the detail CASE in half on a
 * comment that read "MIRROR the state CASE", and reported the view as broken when it was not.
 */
function stripSqlComments(sql: string): string {
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

/** The snapshot column a WHEN condition keys on, which is what we match branches by. */
function conditionKeys(caseBody: string): string[] {
  const keys: string[] = []
  // Split on WHEN, then take the text up to the matching THEN. Conditions span lines.
  for (const chunk of caseBody.split(/\bWHEN\b/i).slice(1)) {
    const condition = chunk.split(/\bTHEN\b/i)[0]
    const column = condition.match(/snap\.(\w+)/i)
    if (column) keys.push(column[1].toLowerCase())
    else if (/EXISTS/i.test(condition)) keys.push('exists')
  }
  return keys
}

function latestMon026Definition(): string {
  const dir = join(process.cwd(), 'supabase', 'migrations')
  const defining = readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort() // timestamp-prefixed, so the last one is the effective definition
    .filter(f => /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:public\.)?mon_026\b/i
      .test(readFileSync(join(dir, f), 'utf8')))

  // Guard the guard. If the regex stops matching, fail loudly rather than pass over nothing.
  expect(defining.length, 'no migration defines mon_026, so this test proves nothing')
    .toBeGreaterThan(0)

  return stripSqlComments(readFileSync(join(dir, defining[defining.length - 1]), 'utf8'))
}

describe('mon_026 detail case mirrors its state case', () => {
  const sql = latestMon026Definition()

  const stateCase = sql.split(/END\s+AS\s+state/i)[0].split(/\bCASE\b/i).pop() ?? ''
  const detailCase = (sql.split(/END\s+AS\s+state/i)[1] ?? '')
    .split(/END\s+AS\s+detail/i)[0]
    .split(/\bCASE\b/i)
    .pop() ?? ''

  it('finds both case expressions, so the assertions below are not vacuous', () => {
    expect(stateCase.length, 'could not isolate the state CASE').toBeGreaterThan(0)
    expect(detailCase.length, 'could not isolate the detail CASE').toBeGreaterThan(0)
    expect(conditionKeys(stateCase).length, 'state CASE has no conditions').toBeGreaterThan(3)
    expect(conditionKeys(detailCase).length, 'detail CASE has no conditions').toBeGreaterThan(3)
  })

  it('tests everything before uploaded_count in BOTH cases, so a failed read is never narrated as a measured zero', () => {
    const stateKeys = conditionKeys(stateCase)
    const detailKeys = conditionKeys(detailCase)

    const stateCut = stateKeys.indexOf('uploaded_count')
    const detailCut = detailKeys.indexOf('uploaded_count')

    expect(stateCut, 'state CASE never tests uploaded_count').toBeGreaterThan(-1)
    expect(detailCut, 'detail CASE never tests uploaded_count').toBeGreaterThan(-1)

    const mustPrecede = stateKeys.slice(0, stateCut)
    const doPrecede = new Set(detailKeys.slice(0, detailCut))
    const missing = mustPrecede.filter(k => !doPrecede.has(k))

    expect(
      missing,
      `the state CASE checks ${missing.join(', ')} before uploaded_count and the detail CASE ` +
      `does not, so when one of those holds the detail falls through to the ` +
      `"no prospect has been uploaded" branch and states a falsehood. This is the exact ` +
      `2026-09-10 defect. Add the branch to the detail CASE.`,
    ).toEqual([])
  })

  it('still tests incomplete first in the detail case, the specific branch that was missing', () => {
    // Named explicitly as well as covered generally above: a rename or reorder that keeps
    // the general invariant but drops THIS branch should still be loud, because it is the
    // one that shipped a false sentence.
    const detailKeys = conditionKeys(detailCase)
    expect(detailKeys, 'detail CASE no longer tests snap.incomplete').toContain('incomplete')
    expect(
      detailKeys.indexOf('incomplete'),
      'detail CASE tests incomplete AFTER uploaded_count, which is the original bug',
    ).toBeLessThan(detailKeys.indexOf('uploaded_count'))
  })
})
