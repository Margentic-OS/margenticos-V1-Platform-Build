// Staleness, forbidden moves, the instruction entry point, and the shared in-flight guard.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { installFakeProvider, forbiddenJudge, type FakeProvider } from './fake-provider'
import { runTuner } from '@/lib/tuner/run-tuner'
import { checkStaleness } from '@/lib/tuner/staleness'
import { checkForbidden, checkCountriesPermitted, boundsFromSpec } from '@/lib/tuner/forbidden'
import { resolveInstruction } from '@/lib/tuner/instruction'
import { findInFlight, BLOCKING_AGENT_NAMES, TUNER_AGENT_NAME } from '@/lib/tuner/in-flight'
import { readUnresolvedFields, describeBlockingFields } from '@/lib/tuner/unresolved-fields'
import { ALL_EXCLUDED_COUNTRIES } from '@/lib/sourcing/geography-exclusion'

let provider: FakeProvider | null = null
afterEach(() => { provider?.restore(); provider = null; vi.restoreAllMocks() })

// ─── Staleness ───────────────────────────────────────────────────────────────

describe('a plan can tell that the document it was built from has moved', () => {
  const marker = { documentId: 'doc-1', version: '4', updatedAt: '2026-09-07T20:00:46.294Z' }

  it('is current when nothing moved', () => {
    const v = checkStaleness(marker, {
      id: 'doc-1', version: '4', updated_at: '2026-09-07T20:00:46.294Z',
    })
    expect(v.stale).toBe(false)
    expect(v.changed).toEqual([])
  })

  it('MOVE THE DOCUMENT AND THE PLAN SAYS SO', () => {
    // The measured case: one live organisation's ICP went from version 4 to version 8 in a
    // day and the population its search reaches fell from 142 people to 1. The document id
    // did not change, because the row is updated in place.
    const v = checkStaleness(marker, {
      id: 'doc-1', version: '8', updated_at: '2026-09-08T14:01:04.704Z',
    })
    expect(v.stale).toBe(true)
    expect(v.changed).toContain('version')
    expect(v.changed).toContain('updated_at')
    expect(v.changed).not.toContain('document_id')
    expect(v.reason).toContain('version 4')
    expect(v.reason).toContain('version 8')
    expect(v.reason).toContain('Re-run the tuner')
  })

  it('catches an in-place edit that did not bump the version', () => {
    // This is why the marker is three fields. Version alone would report current here.
    const v = checkStaleness(marker, {
      id: 'doc-1', version: '4', updated_at: '2026-09-08T09:00:00.000Z',
    })
    expect(v.stale).toBe(true)
    expect(v.changed).toEqual(['updated_at'])
  })

  it('a missing marker is stale, never current', () => {
    // The direction the check has to fail in. A plan that cannot say what it was built from
    // cannot be shown to still describe it.
    expect(checkStaleness(null, { id: 'doc-1', version: '4', updated_at: '2026-09-07T20:00:46.294Z' }).stale).toBe(true)
    expect(checkStaleness(marker, null).stale).toBe(true)
  })

  it('does not report stale merely because a timestamp came back in a different form', () => {
    // Otherwise every reload reports stale and an operator learns to ignore the warning.
    const v = checkStaleness(marker, {
      id: 'doc-1', version: '4', updated_at: '2026-09-07 20:00:46.294+00',
    })
    expect(v.stale).toBe(false)
  })

  it('an unparseable timestamp reports stale rather than current', () => {
    expect(checkStaleness(marker, { id: 'doc-1', version: '4', updated_at: 'not a date' }).stale).toBe(true)
  })

  it('the marker travels on the plan the run produces', async () => {
    provider = installFakeProvider({ populationFor: () => 40_000 })
    const chain: Record<string, unknown> = {}
    Object.assign(chain, {
      select: () => chain, eq: () => chain, in: () => chain, gte: () => chain, order: () => chain,
      limit: async () => ({ data: [], error: null }),
      single: async () => ({
        data: {
          id: 'doc-9', version: '12', updated_at: '2026-09-08T10:00:00.000Z',
          content: {
            tier_1: { company_profile: { industries: ['Higher Education'], headcount: '5-20' } },
            tier_2: { company_profile: { industries: ['Higher Education'], headcount: '5-20' } },
          },
          icp_filter_spec: {
            job_titles: ['t-a'], job_titles_excluded: [], seniority_levels: ['founder'],
            person_countries: ['GB'], company_countries: ['GB'],
            company_headcount_min: 5, company_headcount_max: 20,
            industries: ['Higher Education'], industries_excluded: [],
            keywords: ['w-a'], keywords_excluded: [],
          },
        },
        error: null,
      }),
    })
    const result = await runTuner({
      supabase: { from: () => chain } as never,
      organisationId: 'org', judge: forbiddenJudge, throttleMs: 0,
    })
    expect(result.documentMarker).toEqual({
      documentId: 'doc-9', version: '12', updatedAt: '2026-09-08T10:00:00.000Z',
    })
  })
})

// ─── Forbidden moves ─────────────────────────────────────────────────────────

describe('forbidden moves are reported, never made smaller and made anyway', () => {
  const bounds = boundsFromSpec(
    { company_countries: ['GB'], person_countries: ['GB'] },
    { organization_naics_codes: ['c0'], person_titles: ['t0'], person_seniorities: ['s0'] },
  )

  it('refuses to relax a layer the document states', () => {
    const v = checkForbidden(
      { axis: 'job_title', action: 'relax_layer', index: null, value: null, evidence: 'e' },
      bounds,
    )
    expect(v.forbidden).toBe(true)
    expect(v.reason).toContain('widens the search past what the client\'s own document states')
    expect(v.reason).toContain('needs the document changed')
  })

  it('refuses a country the legal subtraction removes', () => {
    // The excluded set is imported rather than restated, so this test cannot drift from the
    // list the sourcing handler enforces.
    const excluded = Array.from(ALL_EXCLUDED_COUNTRIES)
    expect(excluded.length).toBeGreaterThan(0)
    const v = checkCountriesPermitted([excluded[0]])
    expect(v.forbidden).toBe(true)
    expect(v.reason).toContain('refused outright rather than quietly dropped')
  })

  it('permits a country list that survives the subtraction', () => {
    expect(checkCountriesPermitted(['GB']).forbidden).toBe(false)
  })

  it('permits adding a measured search word, which narrows within the document', () => {
    const v = checkForbidden(
      { axis: 'search_word', action: 'add_word', index: null, value: 'alpha', evidence: 'e' },
      bounds,
    )
    expect(v.forbidden).toBe(false)
  })

  it('refuses an empty word rather than proposing something that constrains nothing', () => {
    const v = checkForbidden(
      { axis: 'search_word', action: 'add_word', index: null, value: '   ', evidence: 'e' },
      bounds,
    )
    expect(v.forbidden).toBe(true)
  })
})

// ─── The instruction entry point ─────────────────────────────────────────────

describe('an instruction is resolved into a change, or refused with a reason', () => {
  it('refuses a request to widen, and says what it can do instead', () => {
    const r = resolveInstruction('There are far too few of these, we need more companies.')
    expect(r.intent).toBe('too_narrow')
    expect(r.actionable).toBe(false)
    expect(r.resolution).toContain('CANNOT DO THIS')
    expect(r.resolution).toContain('ceiling')
  })

  it('refuses anything it does not recognise rather than doing something adjacent', () => {
    const r = resolveInstruction('Please make the emails sound friendlier.')
    expect(r.actionable).toBe(false)
    expect(r.resolution).toContain('refused rather than approximated')
    expect(r.emphasis).toEqual([])
  })

  it('reads a fit complaint as fit, not as breadth', () => {
    // "Too many of the wrong kind" is about fit. Reading it as breadth would tighten a search
    // that is already finding the wrong people, so it would find fewer wrong people.
    const r = resolveInstruction('Too many of these are the wrong kind of organisation.')
    expect(r.intent).toBe('wrong_population')
    expect(r.actionable).toBe(true)
  })

  it('reads a breadth complaint as breadth', () => {
    const r = resolveInstruction('This is far too broad, it is picking up everyone.')
    expect(r.intent).toBe('too_broad')
    expect(r.actionable).toBe(true)
    expect(r.emphasis).toContain('search_word')
  })

  it('records the complaint verbatim beside what it did', async () => {
    provider = installFakeProvider({ populationFor: () => 40_000 })
    const complaint = 'These are the wrong kind of organisation entirely.'
    const chain: Record<string, unknown> = {}
    Object.assign(chain, {
      select: () => chain, eq: () => chain, in: () => chain, gte: () => chain, order: () => chain,
      limit: async () => ({ data: [], error: null }),
      single: async () => ({
        data: {
          id: 'doc-1', version: '4', updated_at: '2026-09-02T23:10:26.721Z',
          content: { tier_1: { company_profile: { industries: ['Higher Education'], headcount: '5-20' } },
                     tier_2: { company_profile: { industries: ['Higher Education'], headcount: '5-20' } } },
          icp_filter_spec: {
            job_titles: ['t-a'], job_titles_excluded: [], seniority_levels: ['founder'],
            person_countries: ['GB'], company_countries: ['GB'],
            company_headcount_min: 5, company_headcount_max: 20,
            industries: ['Higher Education'], industries_excluded: [],
            keywords: ['w-a'], keywords_excluded: [],
          },
        },
        error: null,
      }),
    })
    const result = await runTuner({
      supabase: { from: () => chain } as never,
      organisationId: 'org', instruction: complaint, judge: forbiddenJudge, throttleMs: 0,
    })
    expect(result.instruction?.text).toBe(complaint)
    expect(result.instruction?.resolution).toContain('wrong kind')
  })

  it('a refused instruction spends nothing at all', async () => {
    provider = installFakeProvider({ populationFor: () => 40_000 })
    const result = await runTuner({
      supabase: { from: () => ({}) } as never,
      organisationId: 'org',
      instruction: 'Make it find more people.',
      judge: forbiddenJudge, throttleMs: 0,
    })
    expect(result.terminalState).toBe('forbidden_change_required')
    expect(result.providerCalls).toBe(0)
    expect(result.modelCalls).toBe(0)
  })
})

// ─── The shared in-flight guard ──────────────────────────────────────────────

describe('the tuner and sourcing can see each other', () => {
  it('blocks on a sourcing run, not only on another tuning run', async () => {
    // ONE list, so the two directions cannot disagree. Sourcing registers under its own name
    // and this is what makes the tuner notice it.
    expect(BLOCKING_AGENT_NAMES).toContain('sourcing_entry')
    expect(BLOCKING_AGENT_NAMES).toContain(TUNER_AGENT_NAME)

    let filtered: unknown = null
    const chain: Record<string, unknown> = {}
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      in: (_col: string, values: unknown) => { filtered = values; return chain },
      gte: () => chain,
      order: () => chain,
      limit: async () => ({
        data: [{ agent_name: 'sourcing_entry', started_at: '2026-09-08T10:00:00.000Z' }],
        error: null,
      }),
    })

    const found = await findInFlight({ from: () => chain } as never, 'org')
    expect(found?.agentName).toBe('sourcing_entry')
    expect(filtered).toEqual([...BLOCKING_AGENT_NAMES])
  })

  it('ANNOUNCES itself, so sourcing can see it, not only the other way round', async () => {
    // THE TEST THAT WAS MISSING. The first version of this module checked agent_runs and never
    // wrote to it, so the tuner could see a sourcing run and sourcing could not see the tuner.
    // A one-directional guard reads as a working one, and the direction it failed in is the
    // one that spends money.
    provider = installFakeProvider({ populationFor: () => 1 })

    const inserted: Record<string, unknown>[] = []
    const updated: Record<string, unknown>[] = []
    const chain: Record<string, unknown> = {}
    Object.assign(chain, {
      select: () => chain, eq: () => chain, in: () => chain, gte: () => chain, order: () => chain,
      limit: async () => ({ data: [], error: null }),
      insert: (row: Record<string, unknown>) => { inserted.push(row); return chain },
      update: (row: Record<string, unknown>) => { updated.push(row); return chain },
      single: async () => ({
        data: inserted.length && !('icp_filter_spec' in (inserted[0] ?? {}))
          ? { id: 'agent-run-1' }
          : {
              id: 'doc-1', version: '4', updated_at: '2026-09-02T23:10:26.721Z',
              content: {
                tier_1: { company_profile: { industries: ['Higher Education'], headcount: '5-20' } },
                tier_2: { company_profile: { industries: ['Higher Education'], headcount: '5-20' } },
              },
              icp_filter_spec: {
                job_titles: ['t-a'], job_titles_excluded: [], seniority_levels: ['founder'],
                person_countries: ['GB'], company_countries: ['GB'],
                company_headcount_min: 5, company_headcount_max: 20,
                industries: ['Higher Education'], industries_excluded: [],
                keywords: ['w-a'], keywords_excluded: [],
              },
            },
        error: null,
      }),
    })

    await runTuner({
      supabase: { from: () => chain } as never,
      organisationId: 'org', judge: forbiddenJudge, throttleMs: 0,
    })

    // It wrote a row under a name sourcing's own guard already looks for.
    const announcement = inserted.find(r => r.agent_name === TUNER_AGENT_NAME)
    expect(announcement).toBeDefined()
    expect(announcement!.status).toBe('running')
    expect(BLOCKING_AGENT_NAMES).toContain(announcement!.agent_name)

    // And it closed the row. One left 'running' blocks the organisation for ten minutes.
    expect(updated.some(u => u.status === 'completed' || u.status === 'failed')).toBe(true)
  })

  it('proceeds when the check itself fails, and says so rather than blocking', async () => {
    // The trade is deliberate: this guard protects a shared rate limit rather than data
    // integrity, so a database blip disabling it is a smaller harm than refusing every run.
    const chain: Record<string, unknown> = {}
    Object.assign(chain, {
      select: () => chain, eq: () => chain, in: () => chain, gte: () => chain, order: () => chain,
      limit: async () => ({ data: null, error: { message: 'connection reset' } }),
    })
    expect(await findInFlight({ from: () => chain } as never, 'org')).toBeNull()
  })
})

// ─── Unresolved fields ───────────────────────────────────────────────────────

describe('the document\'s own unresolved fields are read before anything is tuned', () => {
  it('blocks only on a field the search is actually built from', () => {
    const found = readUnresolvedFields({
      unresolved_fields: [
        { kind: 'unestablished_field', field_path: 'tier_1.company_profile.industries',
          why_unresolved: 'The intake did not say.', question_to_settle_it: 'Which do you serve?' },
      ],
    })
    expect(found[0].bearsOnSearch).toBe(true)
    const reason = describeBlockingFields(found)
    expect(reason).toContain('tier_1.company_profile.industries')
    // The document's own question, verbatim, so it can be put to the client as written.
    expect(reason).toContain('Which do you serve?')
  })

  it('does NOT block on a field the search never reads', () => {
    // MEASURED: the one live organisation carrying unresolved fields carries two, on a
    // revenue band and a stage descriptor, and neither reaches the search. Blocking on those
    // would have stopped a run for a reason that was not true.
    const found = readUnresolvedFields({
      unresolved_fields: [
        { kind: 'unverified_claim', field_path: 'tier_1.company_profile.revenue_range',
          why_unresolved: 'w', question_to_settle_it: 'q' },
        { kind: 'unestablished_field', field_path: 'tier_1.company_profile.stage',
          why_unresolved: 'w', question_to_settle_it: 'q' },
      ],
    })
    expect(found.every(f => !f.bearsOnSearch)).toBe(true)
    expect(describeBlockingFields(found)).toBe('')
  })

  it('says so when the document recorded no question, rather than inventing one', () => {
    const found = readUnresolvedFields({
      unresolved_fields: [{ kind: 'unestablished_field', field_path: 'tier_2.company_profile.headcount' }],
    })
    expect(describeBlockingFields(found)).toContain('recorded no question')
  })

  it('tolerates a malformed entry instead of failing the run', () => {
    const found = readUnresolvedFields({ unresolved_fields: [null, 'nonsense', { field_path: 42 }] })
    expect(found).toHaveLength(1)
    expect(found[0].bearsOnSearch).toBe(false)
  })

  it('returns nothing for a document that carries none', () => {
    expect(readUnresolvedFields({})).toEqual([])
    expect(readUnresolvedFields(null)).toEqual([])
  })
})
