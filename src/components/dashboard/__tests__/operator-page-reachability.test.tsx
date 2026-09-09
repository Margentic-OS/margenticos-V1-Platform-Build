// Every page under the operator dashboard is reachable without typing a URL.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A DIRECTORY SCAN AND NOT ANOTHER PER-PAGE TEST
//
// This defect has now happened THREE TIMES in one week: the triage queue, the client
// prospect list, and /dashboard/operator/faqs. Each was fixed by adding one nav entry and,
// twice, by adding one test about that one page. `OperatorSidebar.reply-queue.test.tsx` is
// the precedent, and it is a good test that could only ever have caught the page it names.
//
// A test per page cannot find the page nobody has noticed yet. That is the whole failure
// mode: the pages that go missing are the ones no one is thinking about. So this test asks
// the question the other two could not — **is there ANY page here with no way in** — by
// reading the filesystem rather than a list someone maintains.
//
// It found two more the moment it was written: /dashboard/operator/activity and
// /dashboard/operator/signals, neither referenced anywhere in the codebase, neither known
// to be missing. They are declared below rather than silently ignored.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHAT "REACHABLE" MEANS HERE
//
// A route is reachable if something outside its own directory links to it: a sidebar entry,
// or an href/router.push on another page. That is deliberately broad. `clients/[id]` is
// reached from the All-clients list and `sourcing-review/approve` from the review screen,
// and neither wants a sidebar entry. The test is about "can an operator get there", not
// "is it in the nav".
//
// THE SCAN IS THE WEAK PART AND IT IS BOUNDED ON PURPOSE. It matches route paths as text.
// A route assembled from fragments at runtime would read as unreachable and would need a
// declared exception. That is the safe direction: it produces a false alarm someone must
// answer, never a silent pass. The `it('finds the pages it claims to scan')` case below is
// what stops the whole file passing vacuously if the glob ever stops matching.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const OPERATOR_DIR = join(ROOT, 'src/app/dashboard/operator')

/** Every route under the operator dashboard, derived from page.tsx files on disk. */
function operatorRoutes(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (entry === 'page.tsx') {
        out.push('/' + relative(join(ROOT, 'src/app'), dir).split('\\').join('/'))
      }
    }
  }
  walk(OPERATOR_DIR)
  return out.sort()
}

/** Every .ts/.tsx file under src/, excluding tests. */
function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
    }
  }
  walk(join(ROOT, 'src'))
  return out
}

/**
 * True when something OUTSIDE the route's own directory names it.
 *
 * A dynamic segment is matched on its literal prefix, because callers build those with a
 * template literal: `/dashboard/operator/clients/${id}` cannot be matched whole.
 */
function isLinkedFromElsewhere(route: string, files: string[]): boolean {
  const ownDir = join(ROOT, 'src/app' + route)
  const dynamicAt = route.indexOf('/[')
  const needle = dynamicAt === -1 ? route : route.slice(0, dynamicAt)
  const tail = dynamicAt === -1 ? null : route.slice(route.indexOf(']') + 1)

  for (const file of files) {
    if (file.startsWith(ownDir)) continue
    const text = readFileSync(file, 'utf-8')
    if (!text.includes(needle)) continue
    // For a dynamic route, also require the segment after the id, so
    // `/clients/${id}/replies` is not credited to a link at `/clients/${id}`.
    if (tail && tail.length > 0 && !text.includes(tail)) continue
    return true
  }
  return false
}

// ─── Declared exceptions ──────────────────────────────────────────────────────
//
// A route here is one we have LOOKED AT and decided not to link, with the reason. It is not
// a suppression list: adding an entry is a decision someone has to write down, which is the
// only difference between this and the silence that produced three defects.
//
// BOTH ENTRIES ARE OPEN QUESTIONS, NOT SETTLED DESIGN. They were found by this test on the
// day it was written and neither has an owner. The honest state is "unreachable, and nobody
// has decided whether that is right", so they are recorded as that rather than as intent.
const DECLARED_UNREACHABLE: Record<string, string> = {
  '/dashboard/operator/activity':
    'Found unreachable 2026-09-09 by this test. Zero references anywhere in src/. Renders ' +
    'OperatorTopbar + WarningsRail like the other operator screens, so it is a real page, ' +
    'not a stub. UNDECIDED whether it should be linked or deleted — see the Backlog row. ' +
    'Do not add a nav entry without deciding what it is for.',
  '/dashboard/operator/signals':
    'Found unreachable 2026-09-09 by this test. Zero references anywhere in src/. Same ' +
    'shape as activity. UNDECIDED. Note the signals TABLE has 7 rows, so this page would ' +
    'render something; being unreachable is not the same as being empty.',
}

describe('every operator page is reachable', () => {
  it('finds the pages it claims to scan, so nothing below passes vacuously', () => {
    const routes = operatorRoutes()
    expect(routes.length, 'no operator page.tsx files found — the scan is broken').toBeGreaterThan(10)
    expect(routes).toContain('/dashboard/operator')
    expect(routes).toContain('/dashboard/operator/faqs')
  })

  it('reads real source files, so the link scan is not searching an empty set', () => {
    const files = sourceFiles()
    expect(files.length, 'no source files found — the link scan is broken').toBeGreaterThan(200)
  })

  it('POSITIVE CONTROL: a route that IS linked reads as linked', () => {
    // If this fails, isLinkedFromElsewhere is broken and every "unreachable" verdict below
    // is meaningless. /dashboard/operator/triage is linked from the sidebar.
    expect(isLinkedFromElsewhere('/dashboard/operator/triage', sourceFiles())).toBe(true)
  })

  it('POSITIVE CONTROL: a route that does NOT exist reads as unlinked', () => {
    expect(isLinkedFromElsewhere('/dashboard/operator/no-such-page-xyz', sourceFiles())).toBe(false)
  })

  it('has no page that cannot be reached without typing the URL', () => {
    const files = sourceFiles()
    const orphans = operatorRoutes()
      .filter((r) => !(r in DECLARED_UNREACHABLE))
      .filter((r) => !isLinkedFromElsewhere(r, files))

    expect(
      orphans,
      `These operator pages have no inbound link anywhere in src/. An operator can only ` +
      `reach them by typing the URL, which means they may as well not exist.\n` +
      `Either add a nav entry / link, or add the route to DECLARED_UNREACHABLE with a ` +
      `reason.\n\n${orphans.join('\n')}`,
    ).toEqual([])
  })

  it('the exception list does not name a route that no longer exists', () => {
    // A stale exception silently re-opens the hole it was written for: the route could be
    // renamed and its replacement would then be unlisted AND unchecked.
    const routes = new Set(operatorRoutes())
    const stale = Object.keys(DECLARED_UNREACHABLE).filter((r) => !routes.has(r))
    expect(stale, `DECLARED_UNREACHABLE names routes that do not exist: ${stale.join(', ')}`).toEqual([])
  })

  it('every exception carries a reason, so the list cannot become a silent suppression', () => {
    for (const [route, reason] of Object.entries(DECLARED_UNREACHABLE)) {
      expect(reason.length, `${route} has no reason recorded`).toBeGreaterThan(40)
    }
  })
})
