// Tests the aggregate post-filter drop report in adapter-apollo's execute().
//
// The per-candidate drop lines are logger.debug, which is suppressed in production
// (src/lib/logger/index.ts). Before these counts existed, a run that dropped most
// of what it fetched produced no production evidence at all: the only number that
// reached the orchestrator was candidates.length, already net of the drops.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apolloHandler } from '@/lib/sourcing/handlers/adapter-apollo'
import { logger } from '@/lib/logger'

function apolloPerson(id: string, title: string, company: string, hasEmail = true) {
  return {
    id,
    first_name: `First${id}`,
    last_name_obfuscated: 'X',
    title,
    has_email: hasEmail,
    organization: { name: company },
  }
}

function mockApolloResponse(people: unknown[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ people, total_entries: people.length }),
  } as unknown as Response
}

// The query is built from the spec, so a partial spec no longer reaches the API at all.
// These tests are about the POST-FILTER drop counts, which run on returned rows, so they
// carry the smallest spec that builds a query and vary only the two fields under test.
const MINIMUM_BUILDABLE_SPEC: Record<string, unknown> = {
  job_titles: ['role-a'],
  person_countries: ['GB'],
  company_countries: ['GB'],
  company_headcount_min: 1,
  company_headcount_max: 50,
  industries: ['Management Consulting'],
}

describe('Apollo handler: aggregate drop report', () => {
  const originalKey = process.env.APOLLO_API_KEY

  beforeEach(() => {
    process.env.APOLLO_API_KEY = 'test-key-not-real'
    vi.restoreAllMocks()
  })

  afterEach(() => {
    if (originalKey === undefined) delete process.env.APOLLO_API_KEY
    else process.env.APOLLO_API_KEY = originalKey
  })

  it('warns with flat, greppable counts when candidates were dropped', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockApolloResponse([
        apolloPerson('1', 'Founder', 'Acme Consulting'),
        apolloPerson('2', 'Recruiter', 'Acme Consulting'),          // excluded title
        apolloPerson('3', 'Founder', 'Staffing Partners'),          // excluded keyword
        apolloPerson('4', 'Founder', 'Acme Consulting', false),     // no email
      ]),
    )

    const candidates = await apolloHandler.execute(
      { ...MINIMUM_BUILDABLE_SPEC, job_titles_excluded: ['recruiter'], keywords_excluded: ['staffing'] },
      100,
    )

    expect(candidates).toHaveLength(1)

    const completion = warn.mock.calls.find(c =>
      String(c[0]).includes('sourcing complete'),
    )
    expect(completion).toBeDefined()

    const payload = completion![1] as Record<string, unknown>
    expect(payload.dropped_total).toBe(3)
    expect(payload.dropped_no_email).toBe(1)
    expect(payload.dropped_job_titles_excluded).toBe(1)
    expect(payload.dropped_keywords_excluded).toBe(1)
    expect(payload.total_candidates).toBe(1)

    // The completion line moved to warn, so it must not also sit at info.
    const infoCompletion = info.mock.calls.find(c =>
      String(c[0]).includes('sourcing complete'),
    )
    expect(infoCompletion).toBeUndefined()
  })

  it('logs at info, not warn, when nothing was dropped', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockApolloResponse([apolloPerson('1', 'Founder', 'Acme Consulting')]),
    )

    await apolloHandler.execute({ ...MINIMUM_BUILDABLE_SPEC }, 100)

    const infoCompletion = info.mock.calls.find(c =>
      String(c[0]).includes('sourcing complete'),
    )
    expect(infoCompletion).toBeDefined()
    expect((infoCompletion![1] as Record<string, unknown>).dropped_total).toBe(0)

    expect(warn.mock.calls.find(c => String(c[0]).includes('sourcing complete'))).toBeUndefined()
  })
})
