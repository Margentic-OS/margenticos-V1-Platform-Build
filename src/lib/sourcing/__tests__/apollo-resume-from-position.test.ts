// The handler end of drawing from a position: what it ASKS THE PROVIDER FOR.
//
// sourcing-cursor.test.ts proves the arithmetic and the storage. This file proves the
// handler actually uses them, by inspecting the request bodies that reach the provider.
// A cursor that is stored perfectly and never reaches the query would pass every test in
// that file and change nothing about which people are sourced.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apolloHandler } from '@/lib/sourcing/handlers/adapter-apollo'
import { RECORD_CEILING } from '@/lib/sourcing/record-position'
import { logger } from '@/lib/logger'

function apolloPerson(id: string) {
  return {
    id,
    first_name: `First${id}`,
    last_name_obfuscated: 'X',
    title: 'Founder',
    has_email: true,
    organization: { name: `Company ${id}` },
  }
}

const MINIMUM_BUILDABLE_SPEC: Record<string, unknown> = {
  job_titles: ['role-a'],
  person_countries: ['GB'],
  company_countries: ['GB'],
  company_headcount_min: 1,
  company_headcount_max: 50,
  industries: ['Management Consulting'],
}

/**
 * Serves exactly per_page rows, every SECOND one failing the has_email pre-filter.
 *
 * Every other fixture in this file serves rows that all survive, so recordsRead and
 * candidates.length are equal in all of them and NOTHING distinguishes the two. That is
 * the one number the cursor advances by, and advancing it by survivors would silently
 * re-read every dropped record on every later run, forever. Measured 2026-09-16: with all
 * fixtures undropped, replacing recordsRead with candidates.length passed all 61 tests.
 */
function captureRequestsWithDrops(totalEntries = 1_000_000) {
  const sent: Array<Record<string, unknown>> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
    sent.push(body)
    const page = Number(body.page)
    const perPage = Number(body.per_page)
    const people = Array.from({ length: perPage }, (_, i) => ({
      ...apolloPerson(`p${page}-${i}`),
      has_email: i % 2 === 0,
    }))
    return {
      ok: true,
      status: 200,
      json: async () => ({ people, total_entries: totalEntries }),
    } as unknown as Response
  })
  return sent
}

/** Captures every request body the handler sends, so the page asked for can be asserted. */
function captureRequests(peoplePerPage: number, totalEntries = 1_000_000) {
  const sent: Array<Record<string, unknown>> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
    sent.push(body)
    const page = Number(body.page)
    const people = Array.from({ length: peoplePerPage }, (_, i) =>
      apolloPerson(`p${page}-${i}`),
    )
    return {
      ok: true,
      status: 200,
      json: async () => ({ people, total_entries: totalEntries }),
    } as unknown as Response
  })
  return sent
}

describe('Apollo handler resumes from a record position', () => {
  const originalKey = process.env.APOLLO_API_KEY

  beforeEach(() => {
    process.env.APOLLO_API_KEY = 'test-key-not-real'
    vi.restoreAllMocks()
    vi.spyOn(logger, 'info').mockImplementation(() => {})
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    if (originalKey === undefined) delete process.env.APOLLO_API_KEY
    else process.env.APOLLO_API_KEY = originalKey
    vi.restoreAllMocks()
  })

  // THE BASELINE. Without an offset the handler behaves exactly as it always did, which is
  // what every existing direct caller relies on.
  it('starts at page 1 when there is no stored position', async () => {
    const sent = captureRequests(40)

    const result = await apolloHandler.execute({ ...MINIMUM_BUILDABLE_SPEC }, 40)

    expect(sent[0].page).toBe(1)
    expect(result.startOffset).toBe(0)
    expect(result.recordsRead).toBe(40)
  })

  // 2. THE POSITION IS READ AND USED. This is the assertion that the whole feature exists
  // for: a second run must not ask for page 1 again.
  it('asks for a later page when resuming, not page 1 again', async () => {
    const sent = captureRequests(40)

    const result = await apolloHandler.execute({ ...MINIMUM_BUILDABLE_SPEC }, 40, 120)

    // page = floor(120 / 40) + 1 = 4
    expect(sent[0].page).toBe(4)
    expect(sent[0].per_page).toBe(40)
    expect(result.startOffset).toBe(120)
    expect(result.recordsRead).toBe(40)
  })

  // THE IN-PAGE SKIP, which is what makes a cursor survive a changed batch size. The three
  // real runs on 2026-09-15 used caps of 30, 36 and 44, so offsets rarely land on a page
  // boundary. Offset 30 with per_page 44 is INSIDE page 1.
  it('discards the already-consumed prefix when the offset is mid-page', async () => {
    const sent = captureRequests(44)

    const result = await apolloHandler.execute({ ...MINIMUM_BUILDABLE_SPEC }, 44, 30)

    expect(sent[0].page).toBe(1)
    // The candidates kept start at the TAIL of page 1, not its head: the first 30 rows
    // belong to the previous run.
    expect(result.candidates[0].source_person_key).toBe('apollo:p1-30')
  })

  // THE BATCH MUST STILL BE FILLED, and the first version of this file asserted the
  // opposite because the code and the test were wrong together.
  //
  // Page 1 at per_page 44 yields 14 rows after a 30-row skip. The exhaustion check read
  // that post-skip length, decided the provider had run out, and ended the run with 14 of
  // the 44 records asked for. A short RAW page means the provider is exhausted; a short
  // post-skip page means only that we resumed mid-page.
  it('crosses into the next page to fill the batch after a mid-page skip', async () => {
    const sent = captureRequests(44)

    const result = await apolloHandler.execute({ ...MINIMUM_BUILDABLE_SPEC }, 44, 30)

    // It did not stop after the partial first page.
    expect(sent.length).toBeGreaterThan(1)
    expect(sent[1].page).toBe(2)
    expect(result.candidates).toHaveLength(44)
    // And the window is exact: 44 records consumed from offset 30.
    expect(result.recordsRead).toBe(44)
    expect(result.startOffset + result.recordsRead).toBe(74)
  })

  // A page-at-a-time count would claim the whole final page was consumed when the loop
  // broke mid-page at the cap. The next run would then start past records this one never
  // examined, and nobody would ever source those people.
  it('counts only the records it actually examined when it stops mid-page', async () => {
    captureRequests(100)

    const result = await apolloHandler.execute({ ...MINIMUM_BUILDABLE_SPEC }, 40, 0)

    // per_page is min(cap,100) = 40 here, so one page covers it exactly.
    expect(result.recordsRead).toBe(40)
    expect(result.candidates).toHaveLength(40)
  })

  // THE DROPPED RECORDS COUNT AS READ, because they were.
  //
  // This is the distinction the whole return-shape change exists for: candidates.length is
  // net of the post-filters and recordsRead is not, so they are only equal when nothing was
  // dropped. Advancing the cursor by survivors re-reads every dropped row on every later
  // run. No other fixture here drops anything, so nothing else can catch it.
  it('counts dropped records as read, so the cursor does not rewind over them', async () => {
    captureRequestsWithDrops()

    // per_page = min(cap,100) = 10, and every second row fails has_email, so 5 of each
    // page survive.
    //
    // 19, NOT 20, and the difference is the point. Page 1 is examined whole: 10 read, 5
    // kept. On page 2 the tenth survivor is row index 8, and the loop breaks the moment the
    // cap is met, so row index 9 is NEVER EXAMINED. 10 + 9 = 19. Counting the whole second
    // page would claim a row this run never looked at, and the next run would start past a
    // person nobody ever sourced. Predicted 20 when this was written; the handler returned
    // 19 and the handler is right.
    const result = await apolloHandler.execute({ ...MINIMUM_BUILDABLE_SPEC }, 10, 0)

    expect(result.candidates).toHaveLength(10)
    expect(result.recordsRead).toBe(19)
    // The invariant that survives any fixture: drops happened, so the two numbers differ.
    expect(result.recordsRead).toBeGreaterThan(result.candidates.length)
    // What the cursor stores. Must clear every row consumed, not just the survivors.
    expect(result.startOffset + result.recordsRead).toBe(19)
  })

  // The end offset is what the cursor stores, so the windows of consecutive runs must abut
  // exactly. This is the property that takes the duplicate rate to zero.
  it('produces windows that abut, so consecutive runs do not overlap', async () => {
    captureRequests(30)
    const first = await apolloHandler.execute({ ...MINIMUM_BUILDABLE_SPEC }, 30, 0)
    const firstEnd = first.startOffset + first.recordsRead

    vi.restoreAllMocks()
    vi.spyOn(logger, 'info').mockImplementation(() => {})
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const sent2 = captureRequests(30)
    const second = await apolloHandler.execute({ ...MINIMUM_BUILDABLE_SPEC }, 30, firstEnd)

    expect(firstEnd).toBe(30)
    expect(second.startOffset).toBe(30)
    expect(sent2[0].page).toBe(2)
    expect(second.startOffset + second.recordsRead).toBe(60)
  })

  // 3. THE CEILING, AND THIS IS THE ONE THAT MATTERS.
  //
  // At the wall the provider returns nothing, which is indistinguishable from a healthy run
  // that found nobody new. Both are zero candidates and a completed run. The handler must
  // make the difference visible, and must not spend a provider call to discover it.
  describe('at the 50,000 record ceiling', () => {
    it('says so explicitly instead of returning an ordinary empty result', async () => {
      const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
      const sent = captureRequests(40)

      const result = await apolloHandler.execute(
        { ...MINIMUM_BUILDABLE_SPEC },
        40,
        RECORD_CEILING,
      )

      // The distinguishing flag. Without it this is just "no candidates".
      expect(result.ceilingReached).toBe(true)
      expect(result.candidates).toHaveLength(0)

      // AND IT COSTS NOTHING TO FIND OUT. No provider call is made at the wall.
      expect(sent).toHaveLength(0)

      // AND IT IS LOUD. A quiet return would be read as a normal run by anything watching.
      expect(error).toHaveBeenCalled()
      const said = error.mock.calls.map(c => String(c[0])).join(' ')
      expect(said).toMatch(/ceiling/i)
    })

    it('reports the ceiling when a run walks into it mid-way', async () => {
      const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
      // 40 records left below the wall, and a batch of 40 asked for.
      captureRequests(40)

      const result = await apolloHandler.execute(
        { ...MINIMUM_BUILDABLE_SPEC },
        40,
        RECORD_CEILING - 40,
      )

      // THE FLAG ITSELF, not just the log line. This assertion was missing, and without it
      // hardcoding `ceilingReached: false` on the final return passed the whole file:
      // the early-return path sets its own literal, so only the mid-run path was exposed.
      expect(result.ceilingReached).toBe(true)
      expect(result.recordsRead).toBe(40)
      expect(result.startOffset + result.recordsRead).toBe(RECORD_CEILING)
      expect(error).toHaveBeenCalled()
    })

    // The ALLOW case, and it matters as much as the block. A run near but not at the wall
    // is ordinary work and must not be reported as an outage.
    it('does not cry ceiling on a run that merely finished its batch', async () => {
      const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
      captureRequests(40)

      const result = await apolloHandler.execute({ ...MINIMUM_BUILDABLE_SPEC }, 40, 1_000)

      expect(result.ceilingReached).toBe(false)
      expect(result.recordsRead).toBe(40)
      expect(error).not.toHaveBeenCalled()
    })
  })
})
