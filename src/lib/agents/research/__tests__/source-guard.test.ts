// POSITIVE CONTROLS for the source guard.
//
// Every test here asserts a FAILURE HAPPENS. That direction is the point: the defect this
// guard closes was a run that reported success, so a test that only proves the happy path
// still passes would be the same instrument that missed the incident.
//
// Each block states what it would look like if the guard were removed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FatalApiError } from '@/lib/agents/fatal-api-error'
import {
  SourceHttpError, raiseForStatus, throwIfFatalSource, isFatalSourceStatus,
  FATAL_SOURCE_STATUSES, readErrorBody, ERROR_BODY_CHARS,
} from '../sources/source-http'
import { assessSourceIntegrity, ResearchIncompleteError, isDeliberateSkip, isFoundNothing, HOLDING_SOURCES } from '../source-integrity'
import { SOURCE_SKIPPED_REUSE } from '../source-skip'
import type { RawSourceData } from '../types'

// ─── helpers ─────────────────────────────────────────────────────────────────

function response(status: number, body: string) {
  return { ok: status >= 200 && status < 300, status, text: async () => body }
}

const OK_LINKEDIN = { available: true, profile_data: null, recent_posts: [], formatted: 'x' }
const OK_APOLLO   = { available: true, formatted: 'x', raw: {} }
const OK_WEBSITE  = { available: true, url: 'u', content: 'c', fetch_method: 'direct' }
const OK_SEARCH   = { available: true, person_search: null, company_search: null, combined: 'c', providers: [], search_count: 0, result_count: 0 }

function raw(over: Partial<Record<keyof RawSourceData, unknown>> = {}): RawSourceData {
  return {
    linkedin:   OK_LINKEDIN,
    apollo:     OK_APOLLO,
    website:    OK_WEBSITE,
    web_search: OK_SEARCH,
    ...over,
  } as unknown as RawSourceData
}

// ─── 1. The body is captured, which it was not on 2026-09-21 ─────────────────

describe('the provider body is recorded', () => {
  it('keeps what the provider actually said, not just the status', async () => {
    const apifyBody = '{"error":{"type":"insufficient-credits","message":"Monthly usage hard limit exceeded"}}'
    await expect(raiseForStatus('Apify actor x', response(402, apifyBody)))
      .rejects.toThrow(SourceHttpError)

    try {
      await raiseForStatus('Apify actor x', response(402, apifyBody))
    } catch (err) {
      // WITHOUT THIS the investigation of 2026-09-21 had nothing to read: the old code
      // threw `Apify actor X returned 402` and Apify keeps no run record for a call it
      // refused to start, so the reason was gone for good.
      expect((err as SourceHttpError).body).toBe(apifyBody)
      expect((err as SourceHttpError).status).toBe(402)
      expect((err as SourceHttpError).message).toContain('insufficient-credits')
    }
  })

  it('caps the body and never throws while reading it', async () => {
    const huge = 'x'.repeat(ERROR_BODY_CHARS * 3)
    expect((await readErrorBody(response(500, huge))).length).toBe(ERROR_BODY_CHARS)
    // A failed body read must not replace the status we already know with a stack trace.
    const broken = { text: async () => { throw new Error('socket closed') } }
    expect(await readErrorBody(broken)).toContain('could not be read')
  })

  it('does nothing on a successful response', async () => {
    await expect(raiseForStatus('Apify actor x', response(200, 'fine'))).resolves.toBeUndefined()
  })
})

// ─── 2. FORCE A 402: the run must stop ───────────────────────────────────────

describe('a billing or auth failure stops the whole run', () => {
  it.each(FATAL_SOURCE_STATUSES)('status %i becomes a FatalApiError', status => {
    const err = new SourceHttpError('Apify actor x', status, 'Monthly usage hard limit exceeded')
    expect(isFatalSourceStatus(status)).toBe(true)
    expect(() => throwIfFatalSource(err, 'research/linkedin')).toThrow(FatalApiError)
    try {
      throwIfFatalSource(err, 'research/linkedin')
    } catch (e) {
      // The reason has to carry the provider's own words, or the next investigation is
      // back to guessing.
      expect((e as FatalApiError).reason).toContain(String(status))
      expect((e as FatalApiError).reason).toContain('Monthly usage hard limit exceeded')
    }
  })

  it('does NOT stop the run for statuses that clear by themselves', () => {
    // 429 backs off. 500 and 503 are one provider having a bad minute. Making these fatal
    // would turn a transient blip into an aborted 900-prospect run.
    for (const status of [429, 500, 502, 503, 504]) {
      expect(isFatalSourceStatus(status)).toBe(false)
      expect(() => throwIfFatalSource(new SourceHttpError('s', status, 'b'), 'ctx')).not.toThrow()
    }
  })

  it('passes a FatalApiError straight through rather than flattening it', () => {
    const fatal = new FatalApiError('already fatal', new Error('x'))
    expect(() => throwIfFatalSource(fatal, 'ctx')).toThrow(FatalApiError)
  })

  it('ignores errors that are not HTTP source failures', () => {
    expect(() => throwIfFatalSource(new Error('DNS lookup failed'), 'ctx')).not.toThrow()
  })
})

describe('the LinkedIn source rethrows a 402 instead of swallowing it', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => { process.env.APIFY_API_KEY = 'test-token' })
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

  it('FORCED 402: fetchLinkedInSource throws FatalApiError and returns nothing', async () => {
    globalThis.fetch = vi.fn(async () => response(402, 'Monthly usage hard limit exceeded')) as never
    const { fetchLinkedInSource } = await import('../sources/linkedin')

    // THE WHOLE INCIDENT IN ONE ASSERTION. Before the guard this resolved to
    // `{ available: false, error: 'Error: Apify actor ... returned 402' }`, the run
    // carried on, and 50 prospects were researched without LinkedIn.
    await expect(
      fetchLinkedInSource({ id: 'p1', linkedin_url: 'https://linkedin.com/in/x' } as never),
    ).rejects.toThrow(FatalApiError)
  })

  it('a 500 still degrades to available:false, so one bad minute is not an outage', async () => {
    globalThis.fetch = vi.fn(async () => response(500, 'upstream error')) as never
    const { fetchLinkedInSource } = await import('../sources/linkedin')
    const result = await fetchLinkedInSource({ id: 'p1', linkedin_url: 'https://linkedin.com/in/x' } as never)
    expect(result.available).toBe(false)
    expect(String(result.error)).toContain('500')
  })
})

// ─── 3. FORCE A SINGLE-PROSPECT FAILURE: held, not written ───────────────────

describe('a prospect whose sources did not come back is held', () => {
  it('all four sources up: complete', () => {
    const integrity = assessSourceIntegrity(raw())
    expect(integrity.complete).toBe(true)
    expect(integrity.failed).toEqual([])
    expect(integrity.successful).toHaveLength(4)
  })

  // RETARGETED 2026-09-23, NOT DELETED. This test used `website` when any failure held.
  // Website no longer holds, so the same assertion against the same source would now be
  // asserting the opposite policy. It keeps its job (one failed HOLDING source is enough,
  // and the reason travels with it) against a source the policy still holds on, and the
  // website case it used to cover is the test immediately below.
  it('FORCED single-source failure: incomplete, and it names the source', () => {
    const integrity = assessSourceIntegrity(raw({
      linkedin: { available: false, error: 'Apify actor returned HTTP 403: forbidden' },
    }))
    expect(integrity.complete).toBe(false)
    expect(integrity.holding.map(f => f.source)).toEqual(['linkedin'])
    // The reason travels with it. A held prospect that cannot say why is the old
    // "Both direct and Jina fetch failed" with a new name.
    expect(integrity.holding[0].error).toContain('403')
  })

  it.each(HOLDING_SOURCES)('a %s failure holds the prospect', source => {
    const integrity = assessSourceIntegrity(raw({ [source]: { available: false, error: 'HTTP 500' } }))
    expect(integrity.complete).toBe(false)
    expect(integrity.holding.map(f => f.source)).toEqual([source])
    expect(integrity.recorded).toEqual([])
  })

  it.each(['website', 'web_search'])('a %s failure is RECORDED and the prospect continues', source => {
    // THE 68-OF-84 CASE. Under the first version of this policy the website fetcher's
    // 81% failure rate would have held 68 of 84 prospects over a defect that had nothing
    // to do with any of them.
    const integrity = assessSourceIntegrity(raw({ [source]: { available: false, error: 'HTTP 429' } }))
    expect(integrity.complete).toBe(true)
    expect(integrity.holding).toEqual([])
    expect(integrity.recorded.map(f => f.source)).toEqual([source])
    // AND IT IS STILL REPORTED. Not holding must not mean not counted: `failed` carries
    // every failure so the batch tally and MON-034 both still see it.
    expect(integrity.failed.map(f => f.source)).toEqual([source])
  })

  it('both non-holding sources down at once still does not hold', () => {
    const integrity = assessSourceIntegrity(raw({
      website:    { available: false, error: 'HTTP 429' },
      web_search: { available: false, error: 'provider timeout' },
    }))
    expect(integrity.complete).toBe(true)
    expect(integrity.recorded).toHaveLength(2)
  })

  it('a holding failure alongside a recorded one holds, and names only the holding source', () => {
    const integrity = assessSourceIntegrity(raw({
      linkedin: { available: false, error: 'HTTP 402' },
      website:  { available: false, error: 'HTTP 429' },
    }))
    expect(integrity.complete).toBe(false)
    expect(integrity.holding.map(f => f.source)).toEqual(['linkedin'])
    expect(integrity.recorded.map(f => f.source)).toEqual(['website'])
    // The prospect is not held "because of website", and the message must not say so.
    expect(new ResearchIncompleteError('p1', integrity.holding).message).not.toContain('website')
  })

  it('A PROSPECT WITH NO LINKEDIN URL IS NOT HELD, though linkedin is a holding source', () => {
    // The distinction lives in the source, which is the only place that knows. If this
    // ever goes red, every prospect without a LinkedIn profile is held forever.
    const integrity = assessSourceIntegrity(raw({
      linkedin: { available: false, error: 'No LinkedIn URL for this prospect' },
    }))
    expect(integrity.complete).toBe(true)
    expect(integrity.skipped).toEqual(['linkedin'])
    expect(integrity.failed).toEqual([])
  })

  it('the held error names the prospect, the sources, and says nothing was written', () => {
    const err = new ResearchIncompleteError('p1', [{ source: 'linkedin', error: 'HTTP 402' }])
    expect(err.message).toContain('p1')
    expect(err.message).toContain('linkedin')
    expect(err.message).toContain('no research row written')
    expect(err.failed).toHaveLength(1)
  })

  it('a DELIBERATE skip is not a failure, so nothing is held for it', () => {
    // Three ways a source is legitimately not called. None of them means "we could not
    // look", so none of them may hold a prospect.
    expect(isDeliberateSkip('APIFY_API_KEY not set')).toBe(true)
    expect(isDeliberateSkip('No LinkedIn URL for this prospect')).toBe(true)
    expect(isDeliberateSkip(SOURCE_SKIPPED_REUSE)).toBe(true)
    expect(isDeliberateSkip('Apify actor returned no posts')).toBe(false)

    const integrity = assessSourceIntegrity(raw({
      linkedin: { available: false, error: 'No LinkedIn URL for this prospect' },
    }))
    expect(integrity.complete).toBe(true)
    expect(integrity.skipped).toEqual(['linkedin'])
  })

  it('A REUSE RUN IS NEVER HELD. All four stubs are skips, so it stays complete.', () => {
    // Reuse makes no calls at all. If this ever went red, every stored-findings run in the
    // system would be held forever on sources it never tried to fetch.
    const integrity = assessSourceIntegrity(raw({
      linkedin:   { available: false, error: SOURCE_SKIPPED_REUSE },
      apollo:     { available: false, error: SOURCE_SKIPPED_REUSE },
      website:    { available: false, error: SOURCE_SKIPPED_REUSE },
      web_search: { available: false, error: SOURCE_SKIPPED_REUSE },
    }))
    expect(integrity.complete).toBe(true)
    expect(integrity.skipped).toHaveLength(4)
    expect(integrity.failed).toEqual([])
    expect(integrity.holding).toEqual([])
    expect(integrity.recorded).toEqual([])
  })

  it('reproduces the 2026-09-21 shape: LinkedIn 402, three sources fine, prospect held', () => {
    const integrity = assessSourceIntegrity(raw({
      linkedin: { available: false, error: 'SourceHttpError: Apify actor harvestapi~linkedin-profile-posts returned HTTP 402' },
    }))
    // On the day, this exact shape produced a stored research row, a shipped opening built
    // on employment history, and a batch summary reading `completed 84, failed 0`.
    expect(integrity.complete).toBe(false)
    expect(integrity.holding[0].source).toBe('linkedin')
  })
})

// ─── 4. THE GUARD MUST BE REACHABLE, not merely present ──────────────────────
//
// The first version of the Apollo change added the fatal check BELOW that file's existing
// 401 and 403 branches, which each logged and returned early. So the check was in the file,
// compiled, and could only ever be reached by a 402. It read as installed and was a third
// installed.
//
// These tests go through fetchApolloSource rather than calling the helper, because calling
// the helper is exactly what could not have caught it.

describe('the Apollo guard is reachable for every fatal status, not just 402', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => { process.env.APOLLO_API_KEY = 'test-key' })
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

  it.each([401, 402, 403])('status %i aborts the run', async status => {
    globalThis.fetch = vi.fn(async () => ({
      ...response(status, 'plan does not include enrichment'),
      headers: new Map(),
    })) as never
    const { fetchApolloSource } = await import('../sources/apollo')
    await expect(
      fetchApolloSource({ id: 'p1', first_name: 'A', last_name: 'B', company_name: 'C' } as never),
    ).rejects.toThrow(FatalApiError)
  })

  it('a 429 still degrades, because a rate limit clears on its own', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ...response(429, 'slow down'),
      headers: new Map([['Retry-After', '30']]),
    })) as never
    const { fetchApolloSource } = await import('../sources/apollo')
    const result = await fetchApolloSource({ id: 'p1', first_name: 'A', last_name: 'B', company_name: 'C' } as never)
    expect(result.available).toBe(false)
    expect(String(result.error)).toContain('429')
  })
})

describe('a source that RAN AND FOUND NOTHING does not hold the prospect', () => {
  // FOUND IN PRODUCTION, 2026-09-23, mid-run. The classifier held 4 of the first 8
  // prospects on "Apify posts actor returned no posts". Apify ran and was paid; the
  // person had not posted inside the window. Holding them means anyone who does not post
  // on LinkedIn can never be researched.
  //
  // AND THE SAME DAY'S OTHER CHANGE MADE IT COMMON. Until postedLimitDate was added that
  // morning the actor returned up to 50 posts of any age, so an empty result was rare.
  // With a 90-day filter every prospect who has not posted recently returns zero. Two
  // changes, each correct alone, wrong together.
  it('recognises the marker and the legacy wordings', () => {
    expect(isFoundNothing('Apify posts actor ran and found nothing: no posts in the last 90 days')).toBe(true)
    // Rows written before the marker existed carry the old text and must classify the same.
    expect(isFoundNothing('Apify posts actor returned no posts')).toBe(true)
    expect(isFoundNothing('Apify returned empty data')).toBe(true)
  })

  it('does NOT swallow a real failure', () => {
    expect(isFoundNothing('Apify actor returned HTTP 402: payment required')).toBe(false)
    expect(isFoundNothing('SourceHttpError: Apify actor returned HTTP 500')).toBe(false)
    expect(isFoundNothing(null)).toBe(false)
    expect(isFoundNothing('')).toBe(false)
  })

  it('an empty LinkedIn leaves the prospect researchable', () => {
    const integrity = assessSourceIntegrity(raw({
      linkedin: { available: false, error: 'Apify posts actor ran and found nothing: no posts in the last 90 days' },
    }))
    expect(integrity.complete).toBe(true)
    expect(integrity.empty).toEqual(['linkedin'])
    expect(integrity.holding).toEqual([])
    expect(integrity.failed).toEqual([])
  })

  it('kept apart from skipped, because a skip made no call and an empty result was paid for', () => {
    const integrity = assessSourceIntegrity(raw({
      linkedin: { available: false, error: 'Apify posts actor ran and found nothing: no posts in the last 90 days' },
      apollo:   { available: false, error: 'APOLLO_API_KEY not set' },
    }))
    expect(integrity.empty).toEqual(['linkedin'])
    expect(integrity.skipped).toEqual(['apollo'])
    expect(integrity.complete).toBe(true)
  })

  it('a LinkedIn that genuinely FAILED still holds, so this did not disable the guard', () => {
    // The control. If this ever goes green alongside the tests above, the fix has gone
    // too far and the 2026-09-21 incident can happen again.
    const integrity = assessSourceIntegrity(raw({
      linkedin: { available: false, error: 'Apify actor returned HTTP 402: Monthly usage hard limit exceeded' },
    }))
    expect(integrity.complete).toBe(false)
    expect(integrity.holding.map(f => f.source)).toEqual(['linkedin'])
    expect(integrity.empty).toEqual([])
  })
})

describe('POSITIVE CONTROL: zero posts is researched on the other sources, not held', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => { process.env.APIFY_API_KEY = 'test-token' })
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

  // THE CONTROL THE 2026-09-23 RUN NEEDED AND DID NOT HAVE. Four of the first eight
  // prospects were held on "Apify posts actor returned no posts" — Apify succeeding.
  // This drives the REAL handler with a real empty actor response and carries its output
  // into the real classifier, so it covers the seam between them rather than each end.

  it('the handler turns an empty actor response into a found-nothing error, not a failure', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200, text: async () => '[]', json: async () => [],
    })) as never
    const { fetchLinkedInSource } = await import('../sources/linkedin')

    const li = await fetchLinkedInSource({ id: 'p1', linkedin_url: 'https://linkedin.com/in/x' } as never)

    expect(li.available).toBe(false)          // there genuinely is no LinkedIn data
    expect(isFoundNothing(li.error)).toBe(true)
    // It must NOT read as an infrastructure failure.
    expect(li.error).not.toMatch(/HTTP \d{3}/)
  })

  it('END TO END: empty LinkedIn + three live sources leaves the prospect RESEARCHABLE', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200, text: async () => '[]', json: async () => [],
    })) as never
    const { fetchLinkedInSource } = await import('../sources/linkedin')
    const li = await fetchLinkedInSource({ id: 'p1', linkedin_url: 'https://linkedin.com/in/x' } as never)

    // The other three answered, which is the ordinary case for someone who simply does
    // not post: Apollo has their employment history, the site is up, search finds them.
    const integrity = assessSourceIntegrity(raw({ linkedin: li }))

    expect(integrity.complete).toBe(true)        // NOT held
    expect(integrity.empty).toEqual(['linkedin'])
    expect(integrity.holding).toEqual([])
    expect(integrity.failed).toEqual([])
    // And the three that answered are still available to synthesis, so there is real
    // material to write from. "Not held" would be hollow if nothing survived.
    expect(integrity.successful.sort()).toEqual(['apollo', 'web_search', 'website'])
  })

  it('THE CONTROL ON THE CONTROL: a real 402 from the same handler still holds', async () => {
    // If this ever goes green alongside the two above, the fix has gone too far and the
    // 2026-09-21 incident — 50 prospects researched without LinkedIn, run reports
    // success — can happen again.
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 402, text: async () => 'Monthly usage hard limit exceeded',
    })) as never
    const { fetchLinkedInSource } = await import('../sources/linkedin')

    // A 402 is fatal at the source: it does not even return, it throws to abort the run.
    await expect(
      fetchLinkedInSource({ id: 'p1', linkedin_url: 'https://linkedin.com/in/x' } as never),
    ).rejects.toThrow(FatalApiError)

    // And were it ever downgraded to a returned error, the classifier must still hold.
    const integrity = assessSourceIntegrity(raw({
      linkedin: { available: false, error: 'Apify actor returned HTTP 402: Monthly usage hard limit exceeded' },
    }))
    expect(integrity.complete).toBe(false)
    expect(integrity.holding.map(f => f.source)).toEqual(['linkedin'])
    expect(integrity.empty).toEqual([])
  })

  it('a 500 is neither empty nor fatal: it holds, because we could not look', async () => {
    // The third case, so the two above cannot be read as "everything non-402 is fine".
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 500, text: async () => 'upstream error',
    })) as never
    const { fetchLinkedInSource } = await import('../sources/linkedin')
    const li = await fetchLinkedInSource({ id: 'p1', linkedin_url: 'https://linkedin.com/in/x' } as never)

    expect(isFoundNothing(li.error)).toBe(false)
    expect(assessSourceIntegrity(raw({ linkedin: li })).complete).toBe(false)
  })
})
