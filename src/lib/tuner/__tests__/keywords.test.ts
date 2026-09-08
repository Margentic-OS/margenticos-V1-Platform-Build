// A CANDIDATE WORD IS MEASURED BEFORE IT IS TRUSTED, and the two effects it has are kept apart.
//
// The same word list feeds the provider query and a rescue inside the tier classifier. If the
// two are optimised together, a change in survivors could be either and nothing would say
// which. So the grading effect is computed with the REAL grading function and reported
// separately, and nothing is re-graded.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { installFakeProvider, type FakeProvider } from './fake-provider'
import { measureCandidateWords, compareGrading } from '@/lib/tuner/keywords'
import { matchesTargetKeywords } from '@/lib/sourcing/tier-classification'
import { ProviderBudget } from '@/lib/tuner/count-and-sample'

let provider: FakeProvider | null = null
afterEach(() => { provider?.restore(); provider = null; vi.restoreAllMocks() })

const REQUEST = { organization_naics_codes: ['c0'], q_organization_keyword_tags: ['old'] }

/**
 * The three shapes measured on live organisations 2026-09-08.
 *
 *   'narrows'   finds a real subset                       -> kept
 *   'matches-all' finds the whole population              -> dropped, it constrains nothing
 *   'finds-none'  finds nobody                            -> dropped
 */
function population(req: Record<string, unknown>): number {
  const words = Array.isArray(req.q_organization_keyword_tags)
    ? (req.q_organization_keyword_tags as string[]) : []
  if (words.length === 0) return 20_000
  if (words[0] === 'narrows') return 8_000
  if (words[0] === 'matches-all') return 20_000
  if (words[0] === 'finds-none') return 0
  if (words[0] === 'barely') return 40      // under the 1% floor of 20,000
  return 20_000
}

describe('measuring a candidate word before proposing it', () => {
  it('keeps a word that narrows', async () => {
    provider = installFakeProvider({ populationFor: population })
    const m = await measureCandidateWords(REQUEST, ['narrows'], new ProviderBudget(50, 0))
    expect(m.withoutWordLayer).toBe(20_000)
    expect(m.kept).toEqual(['narrows'])
    expect(m.candidates[0].reason).toContain('Narrows to 8000')
  })

  it('drops a word that matches the whole population, which is what generic means', async () => {
    provider = installFakeProvider({ populationFor: population })
    const m = await measureCandidateWords(REQUEST, ['matches-all'], new ProviderBudget(50, 0))
    expect(m.kept).toEqual([])
    expect(m.candidates[0].reason).toContain('narrows nothing')
  })

  it('drops a word that finds nobody', async () => {
    provider = installFakeProvider({ populationFor: population })
    const m = await measureCandidateWords(REQUEST, ['finds-none'], new ProviderBudget(50, 0))
    expect(m.kept).toEqual([])
    expect(m.candidates[0].reason).toContain('Finds nobody')
  })

  it('drops a word that finds too few to be worth constraining on', async () => {
    provider = installFakeProvider({ populationFor: population })
    const m = await measureCandidateWords(REQUEST, ['barely'], new ProviderBudget(50, 0))
    expect(m.kept).toEqual([])
    expect(m.candidates[0].reason).toContain('floor')
  })

  it('gives the two failures DIFFERENT reasons, because they mean different things', async () => {
    provider = installFakeProvider({ populationFor: population })
    const m = await measureCandidateWords(
      REQUEST, ['matches-all', 'finds-none'], new ProviderBudget(50, 0))
    const [all, none] = m.candidates
    expect(all.reason).not.toBe(none.reason)
    // A market where every candidate matches everyone is a market whose names do not
    // discriminate. A market where every candidate finds nobody usually means the words are
    // wrong. An operator needs to be able to tell those apart from the plan.
  })

  it('replaces a hand-written generic list with a per-client measurement', async () => {
    // The same word can be generic for one client and discriminating for another. This is
    // what makes that decision per client instead of decided once, in advance, for everybody.
    provider = installFakeProvider({
      populationFor: req => {
        const w = Array.isArray(req.q_organization_keyword_tags)
          ? (req.q_organization_keyword_tags as string[])[0] : undefined
        return w === 'shared' ? 20_000 : w === undefined ? 20_000 : 900
      },
    })
    const wide = await measureCandidateWords(REQUEST, ['shared'], new ProviderBudget(50, 0))
    expect(wide.kept).toEqual([])

    provider.restore()
    provider = installFakeProvider({
      populationFor: req => {
        const w = Array.isArray(req.q_organization_keyword_tags)
          ? (req.q_organization_keyword_tags as string[])[0] : undefined
        return w === undefined ? 20_000 : 900
      },
    })
    const narrow = await measureCandidateWords(REQUEST, ['shared'], new ProviderBudget(50, 0))
    expect(narrow.kept).toEqual(['shared'])
  })
})

describe('the search effect and the grading effect are reported separately', () => {
  const prospects = [
    { id: '1', company_name: 'Org-Alpha', job_title: 'Title-A' },
    { id: '2', company_name: 'Org-Beta', job_title: 'Title-B' },
    { id: '3', company_name: 'Gamma-Works', job_title: 'Title-C' },
  ]

  it('reports identical grading when no stored prospect changes verdict', () => {
    // Neither list matches any stored prospect, which is the situation measured across all
    // three live organisations: zero prospects carry the removal reason the rescue guards.
    const c = compareGrading(prospects, ['zzz'], ['qqq'])
    expect(c.identical).toBe(true)
    expect(c.verdictsChanged).toBe(0)
    expect(c.note).toContain('not confounded')
  })

  it('reports CONFOUNDED, loudly, when a verdict would change', () => {
    const c = compareGrading(prospects, ['zzz'], ['alpha'])
    expect(c.identical).toBe(false)
    expect(c.verdictsChanged).toBe(1)
    expect(c.note).toContain('CONFOUNDED')
    expect(c.note).toContain('Nothing has been re-graded')
  })

  it('uses the REAL grading function, not a copy of it', () => {
    // A replica would agree with the original right up until the original changed. This
    // asserts the shared function is the one being exercised, on the exact semantics the
    // classifier relies on: lowercase substring over company name and job title.
    expect(matchesTargetKeywords('Org-Alpha', 'Title-A', ['alpha'])).toBe(true)
    expect(matchesTargetKeywords('Org-Alpha', 'Title-A', ['ALPHA'])).toBe(true)
    expect(matchesTargetKeywords('Org-Alpha', 'Title-A', ['beta'])).toBe(false)

    // An empty list returns false: no evidence was asked for, so none was found. It must
    // never fall back to a default list.
    expect(matchesTargetKeywords('Org-Alpha', 'Title-A', [])).toBe(false)
    expect(matchesTargetKeywords('Org-Alpha', 'Title-A', null)).toBe(false)

    const c = compareGrading(prospects, [], ['alpha'])
    expect(c.matchedByCurrent).toBe(0)
    expect(c.matchedByProposed).toBe(1)
  })
})
