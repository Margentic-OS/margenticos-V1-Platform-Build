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

/** The lock this process wrote, so teardown only ever removes its own. */
let heldLockPath: string | null = null

export async function setup(): Promise<void> {
  const gitDir = sharedGitDir()
  if (!gitDir) {
    console.warn('[suite-lock] not inside a git repository, skipping the run lock')
    return
  }

  const lockPath = join(gitDir, LOCK_FILE_NAME)
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
