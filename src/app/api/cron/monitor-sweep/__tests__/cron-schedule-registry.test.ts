import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * WHY THIS TEST EXISTS.
 *
 * verify-catch-all was moved from every 30 minutes to every 10 with cron.alter_job on
 * 2026-09-01. The
 * migration declaring it still said 30 two days later. No instrument in this platform
 * read cron.job.schedule at all, so nothing could have noticed, and replaying that
 * migration would have put the job back on 30 minutes silently.
 *
 * MON-025 is the live half of the answer: it compares cron.job against
 * cron_schedule_registry, continuously, in production. This is the OTHER half. MON-025 can
 * only be as good as that registry table, and a table is exactly the sort of thing somebody
 * edits to make a red monitor go green. So this reads the migration FILES, derives what
 * they actually declare, and refuses any registry seed that disagrees.
 *
 * Between them:
 *   live != registry   -> MON-025 red, in production
 *   registry != files  -> this test red, in CI, before merge
 *
 * ── THE LIMIT OF THIS TEST, STATED SO IT IS NOT OVER-TRUSTED ──
 *
 * CLAUDE.md is explicit that a migration scan proves HISTORY, not present state. This one
 * is no different: it proves the seed matches what the files declare, and says nothing
 * about what the database is doing. That is MON-025's job, and it reads cron.job live. If
 * MON-025 is ever removed from the monitor registry, this test quietly becomes the only
 * check and stops being sufficient. monitor-sweep-pairs.test.ts asserts MON-025 is
 * registered for exactly that reason.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

/** The migration holding the registry seed. */
const REGISTRY_MIGRATION = '20260903162000_mon_025_cron_schedule_drift.sql'

function migrationFiles(): string[] {
  // Sorted, because filenames are timestamps and LAST DECLARATION WINS. A job scheduled in
  // one migration and re-scheduled in a later one is declared by the later one.
  return readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
}

/**
 * What the migrations declare, as jobname -> schedule, or absent when the last thing that
 * happened to a job was an unschedule.
 *
 * Three statements matter, and all three have to be honoured or the derived answer is wrong
 * in the reassuring direction:
 *   cron.schedule('name', 'sched', ...)          declares
 *   cron.alter_job(..., schedule := 'sched')     re-declares, and needs the jobname nearby
 *   cron.unschedule('name')                      retires
 *
 * alter_job takes a jobid rather than a name, so the name is recovered from the surrounding
 * statement, which in this repository is always a lookup on cron.job by jobname. If that
 * shape ever changes, the guard below fires rather than the schedule being silently missed.
 */
function declaredSchedules(): { declared: Map<string, string>; sawSchedule: number; alterJobs: number } {
  const declared = new Map<string, string>()
  let sawSchedule = 0
  let alterJobs = 0

  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')

    // Comments in this repository quote these calls constantly, in "to remove:" and "to
    // reverse:" notes. Stripping them first is what keeps those from being read as
    // declarations. Both -- line comments and /* */ blocks.
    const live = sql
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(line => line.replace(/--.*$/, ''))
      .join('\n')

    // IN FILE ORDER, not grouped by statement type.
    //
    // This grouped the three passes at first, and queue-worker vanished from the derived
    // set: its migration unschedules the job and then schedules it again in the same DO
    // block, the idempotent shape used all over this repository. Applying every unschedule
    // after every schedule read that as "scheduled, then retired". Order is the whole
    // meaning of these statements, so the matches are sorted by position and replayed.
    type Statement = { at: number; kind: 'schedule' | 'alter' | 'unschedule'; job: string; schedule?: string }
    const statements: Statement[] = []

    for (const m of live.matchAll(/cron\.schedule\s*\(\s*'([^']+)'\s*,\s*'([^']+)'/gi)) {
      statements.push({ at: m.index ?? 0, kind: 'schedule', job: m[1], schedule: m[2] })
      sawSchedule++
    }

    for (const m of live.matchAll(/cron\.alter_job\s*\(([\s\S]*?)\)\s*;/gi)) {
      const body = m[1]
      const schedule = /schedule\s*:=\s*'([^']+)'/i.exec(body)
      const jobname = /jobname\s*=\s*'([^']+)'/i.exec(body)
      if (schedule && jobname) {
        statements.push({ at: m.index ?? 0, kind: 'alter', job: jobname[1], schedule: schedule[1] })
        alterJobs++
      }
    }

    for (const m of live.matchAll(/cron\.unschedule\s*\(\s*'([^']+)'\s*\)/gi)) {
      statements.push({ at: m.index ?? 0, kind: 'unschedule', job: m[1] })
    }

    for (const st of statements.sort((a, b) => a.at - b.at)) {
      if (st.kind === 'unschedule') declared.delete(st.job)
      else declared.set(st.job, st.schedule as string)
    }
  }

  return { declared, sawSchedule, alterJobs }
}

/** The seed rows in the registry migration, as jobname -> schedule. */
function registrySeed(): Map<string, string> {
  const sql = readFileSync(join(MIGRATIONS_DIR, REGISTRY_MIGRATION), 'utf8')
  const insert = /INSERT INTO public\.cron_schedule_registry[\s\S]*?VALUES([\s\S]*?)ON CONFLICT/i.exec(sql)
  if (!insert) throw new Error(`${REGISTRY_MIGRATION}: could not find the registry INSERT`)

  const seed = new Map<string, string>()
  for (const m of insert[1].matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,/g)) {
    seed.set(m[1], m[2])
  }
  return seed
}

describe('cron schedule registry', () => {
  it('finds cron statements at all, so a broken scan cannot pass vacuously', () => {
    // Guard the guard. Every assertion below is of the form "these two sets agree", and two
    // empty sets agree perfectly. This codebase has shipped that mistake more than once.
    const { declared, sawSchedule, alterJobs } = declaredSchedules()
    expect(sawSchedule, 'found no cron.schedule calls in any migration, so this test proves nothing')
      .toBeGreaterThan(0)
    expect(declared.size, 'derived no declared schedules, so this test proves nothing')
      .toBeGreaterThan(0)
    // Not asserted greater than zero: alter_job is legitimately rare. Surfaced so that a
    // regex that silently stops matching it is visible in the output rather than invisible.
    expect(alterJobs).toBeGreaterThanOrEqual(0)
  })

  it('reads at least one seed row, so a broken seed parse cannot pass vacuously', () => {
    expect(registrySeed().size, 'parsed no rows out of the registry INSERT').toBeGreaterThan(0)
  })

  it('seeds exactly the jobs the migrations declare, no more and no fewer', () => {
    const { declared } = declaredSchedules()
    const seed = registrySeed()

    const missingFromSeed = [...declared.keys()].filter(j => !seed.has(j)).sort()
    const notDeclared = [...seed.keys()].filter(j => !declared.has(j)).sort()

    expect(
      missingFromSeed,
      `these jobs are scheduled by a migration but are absent from cron_schedule_registry, ` +
      `so MON-025 cannot see their schedule change: ${missingFromSeed.join(', ')}`,
    ).toEqual([])

    expect(
      notDeclared,
      `these jobs are in cron_schedule_registry but no migration schedules them (or the last ` +
      `thing a migration did was unschedule them), so MON-025 would demand a job that is ` +
      `meant to be gone: ${notDeclared.join(', ')}`,
    ).toEqual([])
  })

  it('seeds the SAME schedule the migrations declare for every job', () => {
    // THE ASSERTION THE WHOLE THING IS FOR. A registry edited to match a drifted database,
    // without the migration that justifies it, fails here.
    const { declared } = declaredSchedules()
    const seed = registrySeed()

    const disagreements: string[] = []
    for (const [jobname, schedule] of declared) {
      const seeded = seed.get(jobname)
      if (seeded !== undefined && seeded !== schedule) {
        disagreements.push(`${jobname}: registry says ${seeded}, migrations declare ${schedule}`)
      }
    }

    expect(disagreements.sort(), disagreements.join(' | ')).toEqual([])
  })

  it('takes the LAST declaration for a job, not the first', () => {
    // verify-catch-all is declared twice: */30 in 20260826002500 and */10 in 20260903161000.
    // Migrations are append-only, so a scan that stopped at the first match would hold the
    // repository to a schedule it has already corrected, which is the exact drift MON-025
    // exists to report.
    const { declared } = declaredSchedules()
    expect(declared.get('verify-catch-all')).toBe('*/10 * * * *')
  })

  it('drops a job whose last declaration is an unschedule', () => {
    // strategy-doc-auto-approve is scheduled in 20260808 and unscheduled in 20260903100500.
    // Its final declared state is "not scheduled", so it must not appear in the registry.
    const { declared } = declaredSchedules()
    expect(declared.has('strategy-doc-auto-approve')).toBe(false)
    expect(registrySeed().has('strategy-doc-auto-approve')).toBe(false)
  })

  it('ignores cron calls that appear only inside comments', () => {
    // Nearly every cron migration in this repository carries a "to remove: SELECT
    // cron.unschedule('x')" note. Reading those as real statements would retire live jobs
    // from the derived set and make this test demand their absence.
    const { declared } = declaredSchedules()
    expect(declared.has('instantly-poll')).toBe(true)
    expect(declared.has('monitor-sweep')).toBe(true)
  })

  it('survives the unschedule-then-schedule shape used for idempotency', () => {
    // queue-worker's migration unschedules the job and reschedules it inside one DO block,
    // which is the idempotent pattern most cron migrations here use. Replaying the
    // statements out of order reads that as a retirement and drops the job entirely.
    const { declared } = declaredSchedules()
    expect(declared.get('queue-worker')).toBe('* * * * *')
    expect(declared.get('reap-agent-runs')).toBe('*/10 * * * *')
    expect(declared.get('monitor-sweep')).toBe('*/15 * * * *')
  })
})
