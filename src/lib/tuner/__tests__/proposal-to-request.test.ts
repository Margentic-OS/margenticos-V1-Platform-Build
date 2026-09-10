// Turning a proposal into a request the provider will honour.
//
// This is the step whose absence meant the loop could describe a better search and never
// find out whether it was better. A proposal that is never run is an opinion.
//
// NO SECTOR, COUNTRY, TITLE OR BAND IS NAMED HERE. Values are placeholders or come from the
// exported provider list by position.

import { describe, it, expect } from 'vitest'
import { proposalToRequest, describeCandidate } from '@/lib/tuner/proposal-to-request'
import { parseProposedSearch } from '@/lib/tuner/proposed-search'
import { PROVIDER_SENIORITY_BANDS } from '@/lib/sourcing/handlers/provider-seniority'
import { ALL_EXCLUDED_COUNTRIES } from '@/lib/sourcing/geography-exclusion'
import { OMITTABLE_AXES } from '@/lib/agents/icp-filter-spec'

const current = (): Record<string, unknown> => ({
  organization_naics_codes: ['c0', 'c1'],
  q_organization_keyword_tags: ['old-word'],
  person_titles: ['a-role-fragment'],
  person_seniorities: [...PROVIDER_SENIORITY_BANDS.slice(0, 2)],
  organization_num_employees_ranges: ['5,20'],
  organization_locations: ['a-place'],
  person_locations: ['a-place'],
  contact_email_status: ['verified'],
})

const el = (value: string) => ({ value, reason: 'the document states it', basis: 'stated' })

describe('an axis named twice is collapsed, not applied in order', () => {
  // MEASURED 2026-09-09 on a live client: one proposal asked for a revenue band AND asked for
  // revenue to be omitted. Both were applied in the order this file runs them, so the omission
  // won and the band vanished silently. The problem was never which one won; it was that the
  // ORDER OF THE CODE decided, and reordering two blocks would have changed a client's
  // candidate search with no word of the proposal changing.
  const contradictory = () => parseProposedSearch({
    revenue: { min: 1_000_000, max: 4_000_000, reason: 'the document states it', basis: 'stated' },
    omit: [{ value: 'company_revenue', reason: 'the document does not constrain it' }],
  })

  it('leaves the axis exactly as the stored search had it', () => {
    const before = current()
    const { request } = proposalToRequest(before, contradictory())
    // Neither thing the proposal asked for. The stored value, untouched.
    expect(request.revenue_range).toEqual(before.revenue_range)
    expect('revenue_range' in request).toBe('revenue_range' in before)
  })

  it('reports the contradiction instead of hiding it in the applied list', () => {
    const { applied, untranslated } = proposalToRequest(current(), contradictory())
    expect(applied.some(a => a.axis === 'company_revenue')).toBe(false)
    const said = untranslated.find(u => u.axis === 'company_revenue')
    expect(said).toBeDefined()
    expect(said!.why).toContain('named this axis 2 times')
  })

  it('does not punish an axis named once', () => {
    // The collapse must key on repetition, not on the axis. A single revenue proposal is an
    // ordinary change and has to survive.
    const p = parseProposedSearch({
      revenue: { min: 1_000_000, max: 4_000_000, reason: 'the document states it', basis: 'stated' },
    })
    const { request, applied, untranslated } = proposalToRequest(current(), p)
    expect(request.revenue_range).toEqual({ min: 1_000_000, max: 4_000_000 })
    expect(applied.some(a => a.axis === 'company_revenue')).toBe(true)
    expect(untranslated.some(u => u.axis === 'company_revenue')).toBe(false)
  })

  it('collapses only the contradicted axis and leaves the others applied', () => {
    const p = parseProposedSearch({
      words: [el('alpha')],
      revenue: { min: 1_000_000, max: 4_000_000, reason: 'r', basis: 'stated' },
      omit: [{ value: 'company_revenue', reason: 'r' }],
    })
    const { request, applied } = proposalToRequest(current(), p)
    expect(applied.map(a => a.axis)).toContain('search_word')
    expect(applied.map(a => a.axis)).not.toContain('company_revenue')
    expect(request.q_organization_keyword_tags).toEqual(['alpha'])
  })
})

describe('a proposal becomes a request, and only where it named something', () => {
  it('replaces the word layer with the proposed words', () => {
    const p = parseProposedSearch({ words: [el('alpha'), el('beta')] })
    const { request, applied } = proposalToRequest(current(), p)
    expect(request.q_organization_keyword_tags).toEqual(['alpha', 'beta'])
    expect(applied.map(a => a.axis)).toContain('search_word')
    // The reason travels with the change, so the plan explains itself.
    expect(applied.find(a => a.axis === 'search_word')!.reason).toContain('the document states it')
  })

  it('leaves every axis the proposal did not name exactly as it was', () => {
    // THE GUARD AGAINST SCORING WELL BY SEARCHING WIDER. A proposal cannot drop a constraint
    // by failing to mention it, and the two searches then differ only in what it named.
    const p = parseProposedSearch({ words: [el('alpha')] })
    const before = current()
    const { request } = proposalToRequest(before, p)
    for (const key of ['organization_naics_codes', 'person_titles', 'person_locations',
                       'organization_locations', 'contact_email_status']) {
      expect(request[key], `${key} moved without being proposed`).toEqual(before[key])
    }
  })

  it('applies a proposed size and revenue band', () => {
    const p = parseProposedSearch({
      size: { min: 10, max: 100, reason: 'stated', basis: 'stated' },
      revenue: { min: 1_000_000, max: 5_000_000, reason: 'stated', basis: 'stated' },
    })
    const { request } = proposalToRequest(current(), p)
    expect(request.organization_num_employees_ranges).toEqual(['10,100'])
    expect(request.revenue_range).toEqual({ min: 1_000_000, max: 5_000_000 })
  })

  it('records what each change was, before and after, for the plan', () => {
    const p = parseProposedSearch({ words: [el('alpha')] })
    const { applied } = proposalToRequest(current(), p)
    const change = applied.find(a => a.axis === 'search_word')!
    expect(change.before).toContain('old-word')
    expect(change.after).toContain('alpha')
  })
})

describe('a deliberate omission removes the parameter rather than emptying it', () => {
  it('sends the axis as ABSENT, not as an empty array', () => {
    const seniorityAxis = OMITTABLE_AXES[0]
    const p = parseProposedSearch({ omit: [{ value: seniorityAxis, reason: 'it never narrows' }] })
    const { request, applied } = proposalToRequest(current(), p)
    // Absent is the provider's own "no constraint". An empty array is read by some
    // parameters as "match nothing", which is the opposite.
    expect('person_seniorities' in request).toBe(false)
    expect(applied.some(a => a.axis === seniorityAxis)).toBe(true)
  })

  it('reports an axis it cannot send rather than silently ignoring it', () => {
    // keywords_excluded is post-filtered on results and is never a request parameter, so an
    // omission of it has nowhere to go. Reported, not dropped.
    const p = parseProposedSearch({ omit: [{ value: 'keywords_excluded', reason: 'r' }] })
    const { untranslated } = proposalToRequest(current(), p)
    expect(untranslated.some(u => u.axis === 'omit')).toBe(true)
  })
})

describe('what it refuses to guess', () => {
  it('reports a category as untranslatable instead of inventing a provider code', () => {
    const p = parseProposedSearch({ categories: [el('a kind of organisation')] })
    const { request, untranslated } = proposalToRequest(current(), p)
    // The category axis is untouched, so the candidate cannot measure well for a reason
    // nobody could name.
    expect(request.organization_naics_codes).toEqual(['c0', 'c1'])
    expect(untranslated.some(u => u.axis === 'categories')).toBe(true)
    expect(untranslated.find(u => u.axis === 'categories')!.why).toMatch(/handler owns that translation/)
  })

  it('never applies a place, and names an excluded country as refused outright', () => {
    const excluded = [...ALL_EXCLUDED_COUNTRIES][0]
    const p = parseProposedSearch({ places: [el(excluded), el('somewhere-else')] })
    const { request, untranslated } = proposalToRequest(current(), p)

    // Geography is left as the stored search has it, which has already been through the
    // legal subtraction.
    expect(request.organization_locations).toEqual(['a-place'])
    expect(request.person_locations).toEqual(['a-place'])

    const refused = untranslated.find(u => u.value === excluded)!
    expect(refused.why).toMatch(/legal subtraction removes/)
    expect(refused.why).toMatch(/Refused outright/)
  })

  it('drops seniority values outside the provider vocabulary before sending', () => {
    const withJunk = { ...current(), person_seniorities: [PROVIDER_SENIORITY_BANDS[0], 'a-value-the-provider-never-defined'] }
    const { request, applied } = proposalToRequest(withJunk, parseProposedSearch({}))
    expect(request.person_seniorities).toEqual([PROVIDER_SENIORITY_BANDS[0]])
    expect(applied.some(a => a.axis === 'seniority')).toBe(true)
  })
})

describe('a candidate that changes nothing says so', () => {
  it('describes itself as having changed nothing this layer can send', () => {
    const p = parseProposedSearch({ categories: [el('a kind of organisation')] })
    const candidate = proposalToRequest(current(), p)
    expect(candidate.applied).toHaveLength(0)
    expect(describeCandidate(candidate)).toMatch(/changed nothing this layer can send/)
  })

  it('describes the changes it did make', () => {
    const p = parseProposedSearch({ words: [el('alpha')] })
    expect(describeCandidate(proposalToRequest(current(), p))).toMatch(/search_word: .* -> .*/)
  })
})
