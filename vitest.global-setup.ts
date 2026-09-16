import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

// ═══════════════════════════════════════════════════════════════════════════
// ONE SUITE RUN AT A TIME, PER MACHINE
//
// On 2026-09-14 two sessions ran the full suite against the SAME test database
// at once, from different worktrees. Neither knew. The result was a set of
// failures that belonged to nobody: rows appearing and vanishing mid-assertion,
// organisations deleted under a run that was still using them, and a test count
// that could not be trusted because it was measuring two suites.
//
// The session-start ritual cannot catch this. It reads `git status`, and a
// worktree with a suite running in it is perfectly clean. It is also the wrong
// MOMENT: the second session started 19 minutes before the first one's suite
// did, so there was nothing to see at session start. The contention happens when
// a suite RUNS, so the check belongs there.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THE SHARED .git DIRECTORY
//
// Every worktree resolves to one common git directory:
//
//     $ cat <worktree>/.git
//     gitdir: /Users/.../Platform/.git/worktrees/<name>
//
// `git rev-parse --git-common-dir` returns that shared root from any of them. So
// a file there is visible to every worktree on the machine, needs no schema, no
// migration, no network, and no configuration. Measured 2026-09-14: 26 worktrees,
// one common directory.
//
// It is per-machine, which is exactly the scope of the problem. The contended
// resource is the shared test database, and it would be more precise to hold the
// lock there. That is a table, a migration and a network round trip in the path
// of every test run, to defend against a case (two machines, one test database)
// that has never happened here.
//
// ═══════════════════════════════════════════════════════════════════════════
// A LOCK THAT CANNOT JAM
//
// A lock whose failure mode is "blocks forever after a crash" is worse than no
// lock: it turns one bad afternoon into a daily obstacle, and the first thing
// anyone does is delete the check. So a held lock is disbelieved for TWO
// independent reasons, and either one alone releases it:
//
//   1. The recorded pid is not alive. A crashed or killed run clears on the very
//      next run, with no waiting.
//   2. The entry is older than STALE_AFTER_MS. This is the backstop for the one
//      case the pid check gets wrong: the operating system reusing a dead run's
//      pid for an unrelated process, which would otherwise look alive forever.
//
// Only a lock that is BOTH alive AND recent refuses. Everything else is taken
// over, and the takeover says so rather than being silent.
//
// ═══════════════════════════════════════════════════════════════════════════
// AND IT CHECKS THE WORLD, NOT JUST THE LOCK FILE
//
// A lock file only sees runs that write one, which means it is blind to exactly
// the worktrees that are the problem. Measured 2026-09-14: 24 of 30 worktrees on
// this machine were cut before this file existed, so their suites take no lock at
// all; one of them was found mid-run against the shared test database while this
// very lock reported nothing held.
//
// Requiring every worktree to be updated is not a workable control when the
// population regenerates faster than it can be updated: 40 worktrees, purged to
// 26, back to 30 within one day. So the check also scans the process table. An
// up-to-date worktree refuses to start while ANY vitest is live on this machine,
// lock or no lock, which turns "everyone must have the fix" into "one participant
// with the fix is enough".
//
// THE HARD PART IS NOT DETECTING OTHERS, IT IS NOT DETECTING YOURSELF. This code
// runs inside a vitest process, launched by a chain of npm/npx/dotenv processes
// whose command lines all contain the word "vitest". Matching naively would make
// every run refuse to start, forever. So the whole of this process's own lineage
// is excluded: itself, every ancestor up to pid 1, and every descendant.

const LOCK_FILE_NAME = 'vitest-suite-run.lock'

// Generous against a full run, which is about 160 seconds. This bound only ever
// matters for a pid that is alive but is not really the suite, so a long value
// costs nothing in the common case and a short one would risk two real runs.
const STALE_AFTER_MS = 30 * 60 * 1000

interface LockEntry {
  pid: number
  worktree: string
  commit: string
  started_at: string
}

/** Runs a git command, returning null rather than throwing: git must never fail the suite. */
function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/**
 * The git directory SHARED by every worktree, which is what makes one file here
 * visible to all of them. Returns null outside a repository, in which case there
 * is nothing to coordinate through and the lock is skipped.
 */
function sharedGitDir(): string | null {
  const common = git(['rev-parse', '--git-common-dir'])
  if (!common) return null
  return isAbsolute(common) ? common : resolve(process.cwd(), common)
}

/**
 * Whether a process is still running.
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. EPERM means the process exists but belongs to another user, which
 * counts as ALIVE: the safe reading of "cannot tell" is that it is still running.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface ProcessRow {
  pid: number
  ppid: number
  command: string
}

/** Every process on the machine. Returns null if ps cannot be read. */
function readProcessTable(): ProcessRow[] | null {
  let raw: string
  try {
    raw = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }

  const rows: ProcessRow[] = []
  for (const line of raw.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] })
  }
  return rows
}

/**
 * This process, everything that launched it, and everything it has launched.
 *
 * The ancestors matter most: vitest is started through a chain like
 * zsh -> npm exec dotenv -> node dotenv -> npm exec vitest -> node vitest, and
 * every one of those command lines contains "vitest". Without this the suite
 * would detect itself and refuse to run, every time.
 */
export function ownLineage(rows: readonly ProcessRow[], selfPid: number = process.pid): Set<number> {
  const parentOf = new Map<number, number>()
  const childrenOf = new Map<number, number[]>()
  for (const row of rows) {
    parentOf.set(row.pid, row.ppid)
    const siblings = childrenOf.get(row.ppid)
    if (siblings) siblings.push(row.pid)
    else childrenOf.set(row.ppid, [row.pid])
  }

  const lineage = new Set<number>([selfPid])

  // Upwards to pid 1. The visited guard is for safety against a cycle ps should
  // never report; without it a bad table would hang the suite before it started.
  let current = parentOf.get(selfPid) ?? 0
  while (current > 1 && !lineage.has(current)) {
    lineage.add(current)
    current = parentOf.get(current) ?? 0
  }

  // Downwards, so workers this run spawns are never mistaken for a rival.
  const pending = [selfPid]
  while (pending.length > 0) {
    const pid = pending.pop()!
    for (const child of childrenOf.get(pid) ?? []) {
      if (lineage.has(child)) continue
      lineage.add(child)
      pending.push(child)
    }
  }

  return lineage
}

/**
 * Whether a command line is a vitest RUNNER, rather than something that merely
 * mentions vitest.
 *
 * This distinction is the whole difficulty. Matching /\bvitest\b/ also matches the
 * shell that launched the run, and this agent harness wraps every command in a
 * long `zsh -c "...";` string, so a naive match reports several processes that are
 * nobody's test run. Measured 2026-09-14: on an otherwise quiet machine a loose
 * match produced five hits, four of them wrapper shells.
 *
 * So the name must appear as an executable: a path segment `/vitest` or
 * `/vitest.mjs` at the end of a word, or npm's own `npm exec vitest`. A shell
 * whose arguments contain "npx vitest run" is deliberately NOT matched; it will be
 * caught a moment later when it spawns the real runner.
 */
export function isVitestRunner(command: string): boolean {
  return /(?:^|\/)vitest(?:\.mjs)?(?=\s|$)/.test(command) || /\bnpm exec vitest(?=\s|$)/.test(command)
}

/**
 * Vitest runs on this machine that are not this one.
 *
 * Returns an empty list when ps cannot be read: a guard that refuses because it
 * could not look is an outage, not a control.
 */
export function selectForeignRuns(rows: readonly ProcessRow[], selfPid: number = process.pid): ProcessRow[] {
  const lineage = ownLineage(rows, selfPid)
  return rows.filter((row) => !lineage.has(row.pid) && isVitestRunner(row.command))
}

function foreignVitestRuns(): ProcessRow[] {
  const rows = readProcessTable()
  if (rows === null) {
    console.warn('[suite-lock] could not read the process table, skipping the machine-wide check')
    return []
  }

  return selectForeignRuns(rows)
}

function readLock(lockPath: string): LockEntry | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockEntry>
    if (typeof parsed.pid !== 'number' || typeof parsed.started_at !== 'string') return null
    return {
      pid: parsed.pid,
      worktree: parsed.worktree ?? '(unknown worktree)',
      commit: parsed.commit ?? '(unknown commit)',
      started_at: parsed.started_at,
    }
  } catch {
    // Unreadable or truncated, e.g. a run killed mid-write. A lock nobody can
    // read holds nothing; treat it as absent so it gets overwritten.
    return null
  }
}

function ageMs(entry: LockEntry): number {
  const started = Date.parse(entry.started_at)
  return Number.isNaN(started) ? Number.POSITIVE_INFINITY : Date.now() - started
}

function describeAge(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown age'
  const seconds = Math.round(ms / 1000)
  return seconds < 120 ? `${seconds}s ago` : `${Math.round(seconds / 60)} minutes ago`
}

function refuse(entry: LockEntry, lockPath: string): never {
  throw new Error(
    `\n[suite-lock] Another test run is already using the shared test database.\n\n` +
      `  pid:       ${entry.pid} (alive)\n` +
      `  worktree:  ${entry.worktree}\n` +
      `  commit:    ${entry.commit}\n` +
      `  started:   ${entry.started_at} (${describeAge(ageMs(entry))})\n\n` +
      `  Two suites against one database produce failures that belong to neither,\n` +
      `  and a test count that measures both. Wait for that run to finish.\n\n` +
      `  If you are certain that process is not a test run, delete the lock:\n` +
      `      rm ${lockPath}\n`,
  )
}

/**
 * What the lock file says about the runs we just detected.
 *
 * ── WHY THIS EXISTS ──
 *
 * Until 2026-09-15 the refusal below asserted, as fixed text, "It holds no lock file, so
 * it is almost certainly a worktree cut before the suite lock existed." NOTHING MEASURED
 * THAT. The foreign-run scan happens before the lock file is read at all, so the sentence
 * was printed whether or not a lock existed and whether or not the rival held it. A run
 * from a fully up-to-date worktree got described as one cut before the check existed.
 *
 * It also skipped the likelier explanation. The lock is written a moment AFTER this scan
 * passes, so every run is a live vitest process with no lock file for a short window while
 * it starts. A loop of runs reopens that window on every iteration.
 *
 * The message now reports what the lock file actually says, and where it genuinely cannot
 * tell the two apart, it says so rather than picking one.
 */
function describeLockFor(foreign: readonly ProcessRow[], lockPath: string): string {
  const entry = readLock(lockPath)

  if (entry === null) {
    return (
      `  There is no lock file. This check cannot tell which of two things that means:\n` +
      `  a worktree cut before this check existed and so taking no lock at all, or a run\n` +
      `  that started moments ago and has not written its lock yet (it is written just\n` +
      `  after this scan passes). Both look identical from here.\n`
    )
  }

  const held = foreign.some((row) => row.pid === entry.pid)
  if (held) {
    return (
      `  That run HOLDS the lock, so it is participating in this check:\n` +
      `    worktree: ${entry.worktree}\n` +
      `    commit:   ${entry.commit}\n` +
      `    started:  ${entry.started_at} (${describeAge(ageMs(entry))})\n`
    )
  }

  return (
    `  A lock file exists but names pid ${entry.pid}, which is NOT one of the runs above\n` +
    `  (${isProcessAlive(entry.pid) ? 'that pid is alive' : 'that pid is gone'}, left by ${entry.worktree}).\n` +
    `  So the run above is not the lock holder, and this check cannot say whether it took\n` +
    `  a lock of its own.\n`
  )
}

function refuseForeignRun(foreign: readonly ProcessRow[], lockPath: string): never {
  const listed = foreign
    .slice(0, 5)
    .map((row) => `  pid ${row.pid}: ${row.command.slice(0, 160)}`)
    .join('\n')

  throw new Error(
    `\n[suite-lock] A vitest run is already live on this machine.\n\n` +
      `${listed}\n` +
      (foreign.length > 5 ? `  ...and ${foreign.length - 5} more\n` : '') +
      `\n` +
      describeLockFor(foreign, lockPath) +
      `\n  Whatever the cause, two suites against one test database produce failures that\n` +
      `  belong to neither, and a test count that measures both.\n\n` +
      `  Wait for it to finish. If the process above is NOT a test run, this check is\n` +
      `  wrong and you can bypass it for one run with:\n` +
      `      MARGENTICOS_ALLOW_CONCURRENT_SUITE=1 <your command>\n`,
  )
}

/** The lock this process wrote, so teardown only ever removes its own. */
let heldLockPath: string | null = null

export async function setup(): Promise<void> {
  const gitDir = sharedGitDir()
  if (!gitDir) {
    console.warn('[suite-lock] not inside a git repository, skipping the run lock')
    return
  }

  const lockPath = join(gitDir, LOCK_FILE_NAME)

  // Before anything is written: is another suite live on this machine at all?
  // The lock file below only sees runs that write one; this sees the rest.
  if (process.env.MARGENTICOS_ALLOW_CONCURRENT_SUITE !== '1') {
    const foreign = foreignVitestRuns()
    if (foreign.length > 0) refuseForeignRun(foreign, lockPath)
  }

  const entry: LockEntry = {
    pid: process.pid,
    worktree: git(['rev-parse', '--show-toplevel']) ?? process.cwd(),
    commit: git(['rev-parse', 'HEAD']) ?? '(unknown commit)',
    started_at: new Date().toISOString(),
  }
  const payload = JSON.stringify(entry, null, 2)

  // Two attempts: create exclusively, and if something is already there, decide
  // whether it still holds and either refuse or clear it and create again. The
  // second attempt cannot loop, so a pathological race fails loudly rather than
  // spinning.
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number
    try {
      // 'wx' fails if the path exists, so this is the compare-and-set: two runs
      // starting together cannot both believe they acquired it.
      fd = openSync(lockPath, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

      const existing = readLock(lockPath)

      if (existing === null) {
        if (existsSync(lockPath)) unlinkSync(lockPath)
        continue
      }

      const alive = isProcessAlive(existing.pid)
      const age = ageMs(existing)

      if (alive && age < STALE_AFTER_MS) refuse(existing, lockPath)

      console.warn(
        `[suite-lock] taking over a lock that no longer holds ` +
          `(pid ${existing.pid} ${alive ? 'alive but ' + describeAge(age) : 'is gone'}), ` +
          `left by ${existing.worktree}`,
      )
      unlinkSync(lockPath)
      continue
    }

    try {
      writeSync(fd, payload)
    } finally {
      closeSync(fd)
    }
    heldLockPath = lockPath
    return
  }

  throw new Error(`[suite-lock] could not acquire ${lockPath} after two attempts`)
}

export async function teardown(): Promise<void> {
  if (!heldLockPath) return

  // Only ever remove our own. A run that took over a stale lock must not delete
  // the lock of whoever legitimately holds it next.
  const existing = readLock(heldLockPath)
  if (existing && existing.pid !== process.pid) return

  try {
    unlinkSync(heldLockPath)
  } catch {
    // Already gone. Nothing to do, and nothing worth failing a green run over.
  }
  heldLockPath = null
}
