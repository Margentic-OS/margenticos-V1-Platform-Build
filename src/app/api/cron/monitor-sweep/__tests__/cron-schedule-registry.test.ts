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
 *   registry != files  -> this test red, before merge
 *
 * ── 2026-09-10: THIS TEST WAS BLIND TO THE STATEMENT IT EXISTS FOR ──
 *
 * The stagger migration moved eleven jobs with `cron.alter_job(..., schedule => '...')`. The
 * parser here matched only `schedule := '...'`. Postgres accepts both named-argument
 * notations, and `=>` is the standard one. So the scan saw 0 of the 11, the files still
 * appeared to declare the old schedules, the untouched seed agreed with them, and this test
 * passed 8 of 8 while MON-025 went red in production over exactly that drift. Its one guard
 * on alter_job was `toBeGreaterThanOrEqual(0)`, which cannot fail.
 *
 * Two changes answer it. Both notations are read. And an alter_job that changes a schedule
 * or on/off state which this scan cannot attribute to a job now THROWS: a statement the scan
 * cannot read is a statement it cannot vouch for, and skipping it is how it went blind.
 *
 * ── THE LIMIT OF THIS TEST, STATED SO IT IS NOT OVER-TRUSTED ──
 *
 * CLAUDE.md is explicit that a migration scan proves HISTORY, not present state. This one
 * is no different: it proves the seed matches what the files declare, and says nothing
 * about what the database is doing. That is MON-025's job, and it reads cron.job live. If
 * MON-025 is ever removed from the monitor registry, this test quietly becomes the only
 * check and stops being sufficient. monitor-sweep-pairs.test.ts asserts MON-025 is
 * registered for exactly that reason.
 *
 * It also only helps if it runs BEFORE a migration is applied. Migrations here are applied
 * through the Supabase MCP straight from a branch, and nothing requires this suite to be
 * green first.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

type Source = { file: string; sql: string }
type Declared = { schedule: string; active: boolean }

function migrationSources(): Source[] {
  // Sorted, because filenames are timestamps and LAST DECLARATION WINS. A job scheduled in
  // one migration and re-scheduled in a later one is declared by the later one.
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(file => ({ file, sql: readFileSync(join(MIGRATIONS_DIR, file), 'utf8') }))
}

// Postgres named-argument notation, either spelling: `schedule := 'x'` or `schedule => 'x'`.
const NAMED_ARG = String.raw`\s*(?::=|=>)\s*`

/**
 * What the migrations declare, as jobname -> { schedule, active }, or absent when the last
 * thing that happened to a job was an unschedule.
 *
 * Three statements matter, and all three have to be honoured or the derived answer is wrong
 * in the reassuring direction:
 *   cron.schedule('name', 'sched', ...)                     declares, switched on
 *   cron.alter_job(..., schedule => 'sched', active => b)   re-declares either or both
 *   cron.unschedule('name')                                 retires
 *
 * alter_job takes a jobid rather than a name, so the name is recovered from the surrounding
 * statement, which in this repository is always a lookup on cron.job by jobname. If that
 * shape ever changes, this throws rather than the declaration being silently missed.
 */
function declaredSchedules(sources: Source[] = migrationSources()): {
  declared: Map<string, Declared>
  sawSchedule: number
  alterJobs: number
} {
  const declared = new Map<string, Declared>()
  let sawSchedule = 0
  let alterJobs = 0

  for (const { file, sql } of sources) {
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
    type Statement = {
      at: number
      kind: 'schedule' | 'alter' | 'unschedule'
      job: string
      schedule?: string
      active?: boolean
    }
    const statements: Statement[] = []

    for (const m of live.matchAll(/cron\.schedule\s*\(\s*'([^']+)'\s*,\s*'([^']+)'/gi)) {
      statements.push({ at: m.index ?? 0, kind: 'schedule', job: m[1], schedule: m[2] })
      sawSchedule++
    }

    for (const m of live.matchAll(/cron\.alter_job\s*\(([\s\S]*?)\)\s*;/gi)) {
      const body = m[1]
      const setsSchedule = new RegExp(String.raw`\bschedule` + NAMED_ARG, 'i').test(body)
      const setsActive = new RegExp(String.raw`\bactive` + NAMED_ARG, 'i').test(body)

      // An alter_job that changes neither, such as the custom-domain migration rewriting only
      // the command, declares nothing this registry holds.
      if (!setsSchedule && !setsActive) continue

      const schedule = new RegExp(String.raw`\bschedule` + NAMED_ARG + `'([^']+)'`, 'i').exec(body)
      const active = new RegExp(String.raw`\bactive` + NAMED_ARG + String.raw`(true|false)\b`, 'i').exec(body)
      const jobname = /jobname\s*=\s*'([^']+)'/i.exec(body)

      if (!jobname || (setsSchedule && !schedule) || (setsActive && !active)) {
        throw new Error(
          `${file}: a cron.alter_job changes a schedule or on/off state, and this scan cannot ` +
          `read which job or what value, so it cannot vouch for it: ${body.trim().slice(0, 200)}`,
        )
      }

      statements.push({
        at: m.index ?? 0,
        kind: 'alter',
        job: jobname[1],
        schedule: schedule?.[1],
        active: active ? active[1].toLowerCase() === 'true' : undefined,
      })
      alterJobs++
    }

    for (const m of live.matchAll(/cron\.unschedule\s*\(\s*'([^']+)'\s*\)/gi)) {
      statements.push({ at: m.index ?? 0, kind: 'unschedule', job: m[1] })
    }

    for (const st of statements.sort((a, b) => a.at - b.at)) {
      if (st.kind === 'unschedule') {
        declared.delete(st.job)
      } else if (st.kind === 'schedule') {
        // Switched on. pg_cron creates a new job active; whether it keeps a paused job paused
        // when an existing name is re-scheduled is not relied on, because every cron migration
        // here unschedules first. Assuming ON is the loud direction: a live job that stayed
        // paused then reads "Switched off, but declared on" on MON-025 rather than passing.
        declared.set(st.job, { schedule: st.schedule as string, active: true })
      } else {
        const prior = declared.get(st.job)
        if (!prior) {
          throw new Error(
            `${file}: cron.alter_job on ${st.job}, which no earlier migration schedules. Either ` +
            `the schedule statement is in a shape this scan does not read, or the job was ` +
            `created by hand and nothing in the repository declares it.`,
          )
        }
        declared.set(st.job, {
          schedule: st.schedule ?? prior.schedule,
          active: st.active ?? prior.active,
        })
      }
    }
  }

  return { declared, sawSchedule, alterJobs }
}

/**
 * The seed rows in the registry, as jobname -> { schedule, active }.
 *
 * SCANS EVERY MIGRATION, in filename order, and lets a later row win.
 *
 * This read one hardcoded filename until 2026-09-04, which was correct while exactly one
 * migration seeded the table. It stopped being correct the moment a second migration
 * scheduled a new job and seeded it alongside, in the same file, the way the rest of this
 * repository does: the derived side gained the job, the seed side could not see it, and this
 * test failed on a change that was right. Reading all of them keeps the assertion pointed at
 * what the database will actually hold after every migration has run.
 *
 * `active` is read by POSITION, third, and is only honoured when the ON CONFLICT clause
 * updates it too; otherwise a re-run would leave the table holding something other than the
 * file says. A seed that does not mention `active` leaves an existing row's value alone,
 * which is what its ON CONFLICT does to the real row, and a new row takes the default, true.
 */
function registrySeed(sources: Source[] = migrationSources()): Map<string, Declared> {
  const seed = new Map<string, Declared>()
  let inserts = 0

  for (const { file, sql } of sources) {
    for (const insert of sql.matchAll(
      /INSERT INTO public\.cron_schedule_registry\s*\(([^)]*)\)\s*VALUES([\s\S]*?)ON CONFLICT([^;]*);/gi,
    )) {
      inserts++
      const columns = insert[1].split(',').map(c => c.trim().toLowerCase())
      const hasActive = columns.includes('active')
      if (hasActive && columns.indexOf('active') !== 2) {
        throw new Error(`${file}: put active third in the registry column list, after schedule, so this scan can read it`)
      }
      if (hasActive && !/\bactive\s*=\s*EXCLUDED\.active\b/i.test(insert[3])) {
        throw new Error(`${file}: seeds active but its ON CONFLICT does not update it, so a re-run leaves the old value`)
      }
      for (const m of insert[2].matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(true|false)?/gi)) {
        const prior = seed.get(m[1])
        seed.set(m[1], {
          schedule: m[2],
          active: m[3] ? m[3].toLowerCase() === 'true' : (prior?.active ?? true),
        })
      }
    }
  }

  // Guard the guard. Every assertion below compares two sets, and two empty sets agree
  // perfectly. A regex that silently stops matching must fail here rather than pass.
  if (inserts === 0) throw new Error('no cron_schedule_registry INSERT found in any migration')

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
    // Was toBeGreaterThanOrEqual(0), which cannot fail, and the scan read zero of the stagger's
    // eleven alter_job calls behind it. The stagger and the auto-approve pause are both
    // alter_job, so zero now means the scan has gone blind to it again.
    expect(alterJobs, 'read no cron.alter_job at all, which is the 2026-09-10 blindness')
      .toBeGreaterThan(0)
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
    for (const [jobname, { schedule }] of declared) {
      const seeded = seed.get(jobname)
      if (seeded !== undefined && seeded.schedule !== schedule) {
        disagreements.push(`${jobname}: registry says ${seeded.schedule}, migrations declare ${schedule}`)
      }
    }

    expect(disagreements.sort(), disagreements.join(' | ')).toEqual([])
  })

  it('seeds the SAME on/off state the migrations declare for every job', () => {
    // MON-001 reads a job as "switched off, as declared" only when the registry says off. A
    // registry flipped to off by hand, with no migration pausing the job, would silence a
    // stalled job's monitor. This is what refuses that.
    const { declared } = declaredSchedules()
    const seed = registrySeed()

    const disagreements: string[] = []
    for (const [jobname, { active }] of declared) {
      const seeded = seed.get(jobname)
      if (seeded !== undefined && seeded.active !== active) {
        disagreements.push(
          `${jobname}: registry says ${seeded.active ? 'on' : 'off'}, migrations declare ${active ? 'on' : 'off'}`,
        )
      }
    }

    expect(disagreements.sort(), disagreements.join(' | ')).toEqual([])
  })

  it('reads cron.alter_job in both named-argument notations, := and =>', () => {
    const { declared } = declaredSchedules([
      {
        file: 'a.sql',
        sql:
          "SELECT cron.schedule('job-a', '*/5 * * * *', $$select 1$$);\n" +
          "SELECT cron.schedule('job-b', '*/5 * * * *', $$select 1$$);",
      },
      {
        file: 'b.sql',
        sql:
          "SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'job-a'), schedule := '1-59/5 * * * *');\n" +
          "SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'job-b'), schedule => '2-59/5 * * * *');",
      },
    ])
    expect(declared.get('job-a')?.schedule).toBe('1-59/5 * * * *')
    expect(declared.get('job-b')?.schedule).toBe('2-59/5 * * * *')

    // And on the real files: the statement the 2026-09-10 stagger wrote, which this scan
    // used to skip without a word.
    expect(declaredSchedules().declared.get('process-replies')?.schedule).toBe('1-59/5 * * * *')
  })

  it('reads active from alter_job and keeps the schedule it does not change', () => {
    const { declared } = declaredSchedules([
      { file: 'a.sql', sql: "SELECT cron.schedule('job-a', '0 * * * *', $$select 1$$);" },
      {
        file: 'b.sql',
        sql: "PERFORM cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'job-a'), active => false);",
      },
    ])
    expect(declared.get('job-a')).toEqual({ schedule: '0 * * * *', active: false })
  })

  it('throws on an alter_job it cannot attribute, rather than skipping it', () => {
    const scheduled = { file: 'a.sql', sql: "SELECT cron.schedule('job-a', '0 * * * *', $$select 1$$);" }
    // A bare jobid: no jobname to recover.
    expect(() => declaredSchedules([scheduled, { file: 'b.sql', sql: "SELECT cron.alter_job(5, schedule => '*/5 * * * *');" }]))
      .toThrow(/cannot read which job/)
    // A schedule passed as an expression rather than a literal.
    expect(() => declaredSchedules([
      scheduled,
      { file: 'b.sql', sql: "SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'job-a'), schedule => new_schedule);" },
    ])).toThrow(/cannot read which job or what value/)
    // A job no migration ever scheduled.
    expect(() => declaredSchedules([
      { file: 'b.sql', sql: "SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'ghost'), schedule => '*/5 * * * *');" },
    ])).toThrow(/no earlier migration schedules/)
  })

  it('takes the LAST declaration for a job, not the first', () => {
    // verify-catch-all is declared three times: */30 in 20260826002500, */10 in 20260903161000,
    // and 7-59/10 in the 20260910140000 stagger. Migrations are append-only, so a scan that
    // stopped at an earlier match would hold the repository to a schedule it has already
    // changed, which is the exact drift MON-025 exists to report.
    const { declared } = declaredSchedules()
    expect(declared.get('verify-catch-all')?.schedule).toBe('7-59/10 * * * *')
  })

  it('declares auto-approve off, per ADR-052', () => {
    // Paused in production on 2026-09-10. If no file on this branch declared it off, a rebuild
    // from these files would switch on a job ADR-052 says must not run.
    expect(declaredSchedules().declared.get('auto-approve')?.active).toBe(false)
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
    // reap-agent-runs and monitor-sweep use the same shape and were later moved by the
    // stagger, so they carry its offsets.
    const { declared } = declaredSchedules()
    expect(declared.get('queue-worker')?.schedule).toBe('* * * * *')
    expect(declared.get('reap-agent-runs')?.schedule).toBe('2-59/10 * * * *')
    expect(declared.get('monitor-sweep')?.schedule).toBe('5-59/15 * * * *')
  })
})
