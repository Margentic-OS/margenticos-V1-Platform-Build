/**
 * Fails the run when a test was SUPPOSED to run and did not.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY
 *
 * When a file's beforeAll throws, vitest reports that file as failed and its
 * tests as SKIPPED. The summary then reads like a small problem plus some
 * deliberate exclusions:
 *
 *     Test Files  1 failed | 305 passed | 2 skipped (313)
 *          Tests  1 failed | 4132 passed | 2 expected fail | 10 skipped (4145)
 *
 * Measured at 7e355d0. One assertion failed; EIGHT more were never evaluated,
 * and nothing in that line says so. The eight were batch-funnel.live.test.ts,
 * whose beforeAll died; run alone minutes later the same file passed 8/8.
 *
 * Counting skips is how you notice, and the count only means something because
 * this repository's deliberate skips are a known, stable set.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW THE TWO KINDS ARE TOLD APART, AND WHY 2 IS NOT HARDCODED
 *
 * Measured with a probe reporter on 2026-09-14, against a file whose beforeAll
 * throws and a describe.runIf gated on an unset variable:
 *
 *     deliberate (runIf)   state=skipped  mode=skip
 *     setup died           state=skipped  mode=run    <- meant to run, did not
 *
 * `mode` is set at COLLECTION time and says what was intended; `state` says what
 * happened. So the guard needs no count and no constant: it reports every test
 * whose intent was `run` and whose outcome was `skipped`. Adding a legitimate
 * opt-in probe adds a `mode=skip` test and can never trip this, which is the
 * property a hardcoded 2 would not have.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT REFUSES TO PASS ON AN EMPTY SCAN
 *
 * A check that scans nothing and reports success is the defect it exists to
 * catch, and this whole guard exists because a quiet summary hid eight tests.
 * So zero modules is a loud failure, not a pass. That is deliberate even though
 * it means `vitest run <pattern-that-matches-nothing>` fails: a filter that
 * matches nothing is worth knowing about too.
 *
 * KNOWN LIMIT: --bail would also leave tests at mode=run/state=skipped, and this
 * would report them. This project does not use --bail. If that changes, exclude
 * the bail case here rather than loosening the rule.
 */

import type { Reporter, TestModule } from 'vitest/node'

const BANNER = '─'.repeat(70)

export default class SkipGuardReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule> = []): void {
    const modules = Array.from(testModules ?? [])

    if (modules.length === 0) {
      process.stderr.write(
        `\n${BANNER}\n[skip-guard] SCANNED ZERO TEST MODULES.\n\n` +
          `  This guard reports tests that were meant to run and did not. Over an\n` +
          `  empty set it would pass while proving nothing, which is the exact\n` +
          `  defect it exists to catch, so it fails instead.\n\n` +
          `  Either the run matched no files, or the reporter is not receiving\n` +
          `  modules. Both are worth knowing.\n${BANNER}\n`,
      )
      process.exitCode = 1
      return
    }

    const neverRan = new Map<string, string[]>()
    let deliberate = 0
    let scanned = 0

    for (const testModule of modules) {
      const file = testModule.moduleId
      for (const test of testModule.children.allTests()) {
        scanned += 1
        if (test.result().state !== 'skipped') continue

        // mode is the INTENT, fixed at collection. 'skip' and 'todo' mean a runIf
        // or an explicit exclusion; 'run' means it was meant to run and did not.
        if (test.options.mode === 'skip' || test.options.mode === 'todo') {
          deliberate += 1
          continue
        }

        const names = neverRan.get(file)
        if (names) names.push(test.name)
        else neverRan.set(file, [test.name])
      }
    }

    if (scanned === 0) {
      process.stderr.write(
        `\n${BANNER}\n[skip-guard] ${modules.length} module(s) but ZERO TESTS scanned.\n\n` +
          `  A guard that inspects no tests cannot fail, so it must not pass.\n${BANNER}\n`,
      )
      process.exitCode = 1
      return
    }

    if (neverRan.size === 0) return

    const total = Array.from(neverRan.values()).reduce((n, names) => n + names.length, 0)
    const detail = Array.from(neverRan.entries())
      .map(([file, names]) => {
        const shown = names.slice(0, 6).map((n) => `      - ${n}`).join('\n')
        const more = names.length > 6 ? `\n      ...and ${names.length - 6} more` : ''
        return `  ${file}\n    ${names.length} test(s) never ran:\n${shown}${more}`
      })
      .join('\n\n')

    process.stderr.write(
      `\n${BANNER}\n[skip-guard] ${total} test(s) in ${neverRan.size} file(s) were SKIPPED WITHOUT BEING EXCLUDED.\n\n` +
        `${detail}\n\n` +
        `  These are not deliberate skips. Their setup died, so they asserted\n` +
        `  NOTHING, and vitest counts them as "skipped" beside the ${deliberate} that really\n` +
        `  are excluded. Read them as failures.\n\n` +
        `  Fix the hook that threw in the file(s) above. Do not silence this.\n${BANNER}\n`,
    )
    process.exitCode = 1
  }
}
