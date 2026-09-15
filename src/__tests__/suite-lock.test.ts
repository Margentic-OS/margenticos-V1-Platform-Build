// The suite lock had no tests at all until 2026-09-15.
//
// ── WHY THE LINEAGE EXCLUSION IS THE PIECE THAT MATTERS ──
//
// The lock refuses to start while any OTHER vitest is live on the machine. It runs inside
// a vitest process that was itself launched through a chain of npm / npx / dotenv
// processes whose command lines ALL contain the word "vitest". So the hard part is not
// detecting rivals, it is not detecting yourself.
//
// If that exclusion ever over-matches, EVERY run refuses to start, for ever, in every
// worktree that has the check. The failure is total and immediate, and the first thing
// anyone does under that pressure is delete the check, which removes the protection
// permanently to fix a five-minute problem. That is why this file leads with the
// self-detection cases rather than the rival-detection ones.
//
// These are pure functions over a SYNTHETIC process table. Nothing here reads the real
// process table, writes a lock, or touches the database.

import { describe, it, expect } from 'vitest'
import { isVitestRunner, ownLineage, selectForeignRuns } from '../../vitest.global-setup'

interface Row { pid: number; ppid: number; command: string }

/** The real launch chain, from the module's own comment. Every line mentions vitest. */
function realisticOwnChain(): Row[] {
  return [
    { pid: 100, ppid: 1, command: 'zsh -c npx dotenv -e .env.test.local -- npx vitest run' },
    { pid: 200, ppid: 100, command: 'npm exec dotenv -e .env.test.local -- npx vitest run' },
    { pid: 300, ppid: 200, command: 'node /repo/node_modules/.bin/dotenv -e .env.test.local -- npx vitest run' },
    { pid: 400, ppid: 300, command: 'npm exec vitest run' },
    { pid: 500, ppid: 400, command: 'node /repo/node_modules/vitest/vitest.mjs run' },
    { pid: 600, ppid: 500, command: 'node /repo/node_modules/vitest/dist/worker.js' },
  ]
}

describe('isVitestRunner: a runner, not anything that mentions vitest', () => {
  it('matches a real runner executable', () => {
    expect(isVitestRunner('/repo/node_modules/.bin/vitest run')).toBe(true)
    expect(isVitestRunner('node /repo/node_modules/vitest/vitest.mjs run')).toBe(true)
    expect(isVitestRunner('npm exec vitest run')).toBe(true)
  })

  it('does NOT match the wrapper shell that will launch one', () => {
    // This agent harness wraps every command in a long `zsh -c "..."` string. Matching it
    // reported five hits on an otherwise quiet machine, four of them wrapper shells.
    expect(isVitestRunner('zsh -c npx dotenv -e .env.test.local -- npx vitest run')).toBe(false)
    expect(isVitestRunner('/bin/sh -c "npx vitest run src/foo"')).toBe(false)
  })

  it('does NOT match a program whose name merely contains vitest', () => {
    expect(isVitestRunner('/opt/bin/my-vitest-helper')).toBe(false)
    expect(isVitestRunner('/opt/vitestify/bin/run')).toBe(false)
    expect(isVitestRunner('node /repo/scripts/vitest-report.js')).toBe(false)
  })

  it('does not match an empty or unrelated command', () => {
    expect(isVitestRunner('')).toBe(false)
    expect(isVitestRunner('/usr/sbin/cupsd')).toBe(false)
  })
})

describe('ownLineage: self, every ancestor, every descendant', () => {
  const rows = realisticOwnChain()

  it('includes the process itself', () => {
    expect(ownLineage(rows, 500).has(500)).toBe(true)
  })

  it('includes every ancestor up to pid 1', () => {
    const lineage = ownLineage(rows, 500)
    for (const pid of [400, 300, 200, 100]) expect(lineage.has(pid)).toBe(true)
  })

  it('includes descendants, so a worker this run spawned is never a rival', () => {
    expect(ownLineage(rows, 500).has(600)).toBe(true)
  })

  it('excludes an unrelated process', () => {
    const withStranger = [...rows, { pid: 999, ppid: 1, command: '/repo/node_modules/.bin/vitest run' }]
    expect(ownLineage(withStranger, 500).has(999)).toBe(false)
  })

  it('terminates on a parent cycle rather than hanging', () => {
    // ps should never report this. If it ever does, the guard must not spin: a hang here
    // happens before any test runs, so it would look like the suite simply never starting.
    const cyclic: Row[] = [
      { pid: 10, ppid: 20, command: 'a' },
      { pid: 20, ppid: 10, command: 'b' },
    ]
    const lineage = ownLineage(cyclic, 10)
    expect(lineage.has(10)).toBe(true)
    expect(lineage.has(20)).toBe(true)
  })
})

describe('selectForeignRuns: a run must never detect itself', () => {
  it('finds NOTHING when the only vitest processes are its own chain', () => {
    // THE test. If this ever fails, every run refuses to start in every up-to-date
    // worktree, and the check gets deleted rather than fixed.
    expect(selectForeignRuns(realisticOwnChain(), 500)).toEqual([])
  })

  it('still finds a genuine rival', () => {
    // The positive control for the test above: proving the selector CAN return something
    // is what makes the empty result there meaningful rather than vacuous.
    const rows = [
      ...realisticOwnChain(),
      { pid: 900, ppid: 1, command: 'node /other-worktree/node_modules/vitest/vitest.mjs run' },
    ]
    const foreign = selectForeignRuns(rows, 500)
    expect(foreign.map((r) => r.pid)).toEqual([900])
  })

  it('does not report a rival wrapper shell as a run', () => {
    // It will be caught a moment later when it spawns the real runner. Reporting it now
    // would refuse against a process that is not yet using the database.
    const rows = [
      ...realisticOwnChain(),
      { pid: 901, ppid: 1, command: 'zsh -c npx vitest run' },
    ]
    expect(selectForeignRuns(rows, 500)).toEqual([])
  })

  it('reports several rivals when several are live', () => {
    const rows = [
      ...realisticOwnChain(),
      { pid: 900, ppid: 1, command: '/a/node_modules/.bin/vitest run' },
      { pid: 910, ppid: 1, command: 'npm exec vitest run' },
    ]
    expect(selectForeignRuns(rows, 500).map((r) => r.pid).sort()).toEqual([900, 910])
  })

  it('is empty on a machine with no vitest at all', () => {
    const quiet: Row[] = [
      { pid: 1, ppid: 0, command: '/sbin/launchd' },
      { pid: 50, ppid: 1, command: '/usr/sbin/cupsd' },
    ]
    expect(selectForeignRuns(quiet, 50)).toEqual([])
  })
})
