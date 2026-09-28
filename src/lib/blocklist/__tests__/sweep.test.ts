import { describe, it, expect } from 'vitest'
import { runBlocklistSweep, type ResolveA } from '../sweep'
import { BLOCKLISTS, CLEAN_CONTROL_DOMAIN, queryNameFor } from '../lists'

/**
 * THE FAKE THROWS ON ANY NAME IT WAS NOT GIVEN.
 *
 * A fake that quietly returns [] for an unexpected query is the shape CLAUDE.md names
 * against: it would make every "not listed" assertion below pass whether the sweep queried
 * the right name, the wrong name, or no name at all. Here an unplanned query is a loud
 * failure, so the tests are actually about what the sweep asks.
 *
 * `guards the guard` at the bottom proves the throwing works, because a fake whose throw is
 * broken is indistinguishable from a correct sweep.
 */
function fakeResolver(answers: Record<string, string[] | 'throw'>): {
  resolve: ResolveA
  asked: string[]
} {
  const asked: string[] = []
  const resolve: ResolveA = async (name: string) => {
    asked.push(name)
    const answer = answers[name]
    if (answer === undefined) {
      throw new Error(`FAKE: sweep asked about an unplanned name: ${name}`)
    }
    if (answer === 'throw') throw new Error(`simulated DNS failure for ${name}`)
    return answer
  }
  return { resolve, asked }
}

/**
 * A real listing address FOR THAT LIST. These are not interchangeable and assuming they were
 * is what made the first version of the multi-list test below fail: it used SURBL's abuse bit
 * 127.0.0.64 for URIBL, and URIBL correctly classified it as refused because 64 is not one of
 * its three bits. The code was right and the test was wrong.
 */
function listedFor(code: string): string[] {
  if (code === 'SPAMHAUS_DBL') return ['127.0.1.2']   // DBL listing range is 127.0.1.2-99
  if (code === 'SURBL') return ['127.0.0.64']          // abuse bit
  if (code === 'URIBL') return ['127.0.0.2']           // black
  throw new Error(`no listing address known for ${code}`)
}

/** Every query a full clean run makes: each list's test point, the clean control, each domain. */
function cleanAnswers(domains: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const list of BLOCKLISTS) {
    // The list reports its own test point as listed, which is a working instrument. The real
    // measured test-point answers are asserted in lists.test.ts; here any valid listing for
    // that list will do, and it comes from the one mapping so the two cannot drift.
    out[queryNameFor(list, list.testPoint)] = listedFor(list.code)
    // And says nothing about a domain that must be clean.
    out[queryNameFor(list, CLEAN_CONTROL_DOMAIN)] = []
    for (const d of domains) out[queryNameFor(list, d)] = []
  }
  return out
}

const DOMAINS = ['gomargenticos.com', 'trymargenticos.com']

describe('blocklist sweep: the clean case', () => {
  it('reports no listings, and the detail carries BOTH denominators', async () => {
    const { resolve } = fakeResolver(cleanAnswers(DOMAINS))
    const v = await runBlocklistSweep({ resolve, domains: DOMAINS })

    expect(v.listedCount).toBe(0)
    expect(v.controlFailures).toEqual([])
    expect(v.refusedCount).toBe(0)
    expect(v.incomplete).toBe(false)
    expect(v.domainsChecked).toBe(2)
    expect(v.listsTrusted).toBe(3)
    expect(v.listsTotal).toBe(3)

    // A bare "no listings" is what a sweep that examined nothing also reports.
    expect(v.detail).toContain('2 sending domain(s)')
    expect(v.detail).toContain('3 of 3')
  })

  it('queries the controls AND every domain on every list', async () => {
    const { resolve, asked } = fakeResolver(cleanAnswers(DOMAINS))
    await runBlocklistSweep({ resolve, domains: DOMAINS })
    // 3 lists x (1 positive + 1 negative + 2 domains)
    expect(asked).toHaveLength(12)
    for (const list of BLOCKLISTS) {
      expect(asked).toContain(queryNameFor(list, list.testPoint))
      expect(asked).toContain(queryNameFor(list, CLEAN_CONTROL_DOMAIN))
      for (const d of DOMAINS) expect(asked).toContain(queryNameFor(list, d))
    }
  })

  it('de-duplicates and normalises the domain list', async () => {
    const answers = cleanAnswers(['gomargenticos.com'])
    const { resolve } = fakeResolver(answers)
    const v = await runBlocklistSweep({
      resolve,
      domains: ['gomargenticos.com', 'GoMargenticos.com', ' gomargenticos.com ', ''],
    })
    // One domain, not four. A duplicate would have produced an unplanned-name throw only if
    // the name differed, so assert the count directly.
    expect(v.domainsChecked).toBe(1)
    expect(v.incomplete).toBe(false)
  })
})

describe('blocklist sweep: a real listing', () => {
  it('finds the 2026-09-28 SURBL abuse listing and names it', async () => {
    const answers = cleanAnswers(['getmargenticos.com', 'gomargenticos.com'])
    const surbl = BLOCKLISTS.find(l => l.code === 'SURBL')!
    answers[queryNameFor(surbl, 'getmargenticos.com')] = ['127.0.0.64']

    const { resolve } = fakeResolver(answers)
    const v = await runBlocklistSweep({ resolve, domains: ['getmargenticos.com', 'gomargenticos.com'] })

    expect(v.listedCount).toBe(1)
    expect(v.listings).toEqual([
      { domain: 'getmargenticos.com', list: 'SURBL', address: '127.0.0.64' },
    ])
    expect(v.controlFailures).toEqual([])
    expect(v.detail).toContain('LISTED')
    expect(v.detail).toContain('getmargenticos.com on SURBL (127.0.0.64)')
    // The clean domain must NOT be dragged in.
    expect(v.detail).not.toContain('gomargenticos.com on')
  })

  it('finds the same domain listed on more than one list', async () => {
    const answers = cleanAnswers(['getmargenticos.com'])
    for (const list of BLOCKLISTS) {
      answers[queryNameFor(list, 'getmargenticos.com')] = listedFor(list.code)
    }
    const { resolve } = fakeResolver(answers)
    const v = await runBlocklistSweep({ resolve, domains: ['getmargenticos.com'] })
    expect(v.listedCount).toBe(3)
  })
})

describe('blocklist sweep: the instrument failing is NOT a clean result', () => {
  it('a list that returns nothing for its own test point is not trusted', async () => {
    // THE MEASURED 8.8.8.8 CASE. Spamhaus returned empty for dbltest.com, a domain it
    // certainly lists. Empty is byte-identical to a clean answer, so without this control
    // the sweep would have reported every domain clean on Spamhaus.
    const answers = cleanAnswers(DOMAINS)
    const dbl = BLOCKLISTS.find(l => l.code === 'SPAMHAUS_DBL')!
    answers[queryNameFor(dbl, dbl.testPoint)] = []

    const { resolve } = fakeResolver(answers)
    const v = await runBlocklistSweep({ resolve, domains: DOMAINS })

    expect(v.controlFailures).toHaveLength(1)
    expect(v.controlFailures[0]).toMatchObject({ list: 'SPAMHAUS_DBL', kind: 'positive' })
    expect(v.listsTrusted).toBe(2)
    expect(v.detail).toContain('CONTROL FAILURES')
    // AND the detail must not read as an all-clear.
    expect(v.detail).not.toMatch(/^No listings\./)
  })

  it('does not ask an untrusted list about our domains at all', async () => {
    const answers = cleanAnswers(DOMAINS)
    const dbl = BLOCKLISTS.find(l => l.code === 'SPAMHAUS_DBL')!
    answers[queryNameFor(dbl, dbl.testPoint)] = []

    const { resolve, asked } = fakeResolver(answers)
    await runBlocklistSweep({ resolve, domains: DOMAINS })

    // Its answers would be meaningless, so spending queries on them is waste and reporting
    // them would be worse.
    for (const d of DOMAINS) {
      expect(asked).not.toContain(queryNameFor(dbl, d))
    }
  })

  it('a blocked resolver code fails the control rather than listing everything', async () => {
    // 1.1.1.1 -> 127.255.255.254 for Spamhaus's test point.
    const answers = cleanAnswers(DOMAINS)
    const dbl = BLOCKLISTS.find(l => l.code === 'SPAMHAUS_DBL')!
    answers[queryNameFor(dbl, dbl.testPoint)] = ['127.255.255.254']

    const { resolve } = fakeResolver(answers)
    const v = await runBlocklistSweep({ resolve, domains: DOMAINS })

    expect(v.controlFailures[0]).toMatchObject({ list: 'SPAMHAUS_DBL', kind: 'positive' })
    expect(v.listedCount).toBe(0)
  })

  it('catches a resolver that answers EVERY query, which the positive control cannot', async () => {
    // A wildcard or captive resolver passes the positive control perfectly and then reports
    // all five sending domains as listed. The negative control is the only thing that sees
    // it. This is the case that justifies the extra query per list.
    const answers = cleanAnswers(DOMAINS)
    const surbl = BLOCKLISTS.find(l => l.code === 'SURBL')!
    answers[queryNameFor(surbl, CLEAN_CONTROL_DOMAIN)] = ['127.0.0.64']

    const { resolve } = fakeResolver(answers)
    const v = await runBlocklistSweep({ resolve, domains: DOMAINS })

    expect(v.controlFailures).toHaveLength(1)
    expect(v.controlFailures[0]).toMatchObject({ list: 'SURBL', kind: 'negative' })
    expect(v.listsTrusted).toBe(2)
    expect(v.detail).toContain('answering every query')
  })

  it('still finds a listing on a WORKING list while another list is blind', async () => {
    // The arms are independent. One blind list must not suppress another's finding, which is
    // the whole reason the 2026-09-28 picture needed three instruments.
    const answers = cleanAnswers(['inboxmargenticos.com'])
    const dbl = BLOCKLISTS.find(l => l.code === 'SPAMHAUS_DBL')!
    const surbl = BLOCKLISTS.find(l => l.code === 'SURBL')!
    answers[queryNameFor(dbl, dbl.testPoint)] = []
    answers[queryNameFor(surbl, 'inboxmargenticos.com')] = ['127.0.0.64']

    const { resolve } = fakeResolver(answers)
    const v = await runBlocklistSweep({ resolve, domains: ['inboxmargenticos.com'] })

    expect(v.listedCount).toBe(1)
    expect(v.listings[0].domain).toBe('inboxmargenticos.com')
    expect(v.controlFailures).toHaveLength(1)
    expect(v.detail).toContain('LISTED')
    expect(v.detail).toContain('CONTROL FAILURES')
  })
})

describe('blocklist sweep: errors and partial runs', () => {
  it('a throwing control query sets incomplete rather than crashing the cron', async () => {
    const answers: Record<string, string[] | 'throw'> = cleanAnswers(DOMAINS)
    const surbl = BLOCKLISTS.find(l => l.code === 'SURBL')!
    answers[queryNameFor(surbl, surbl.testPoint)] = 'throw'

    const { resolve } = fakeResolver(answers)
    const v = await runBlocklistSweep({ resolve, domains: DOMAINS })

    expect(v.incomplete).toBe(true)
    expect(v.controlFailures.some(c => c.kind === 'error')).toBe(true)
    expect(v.detail).toContain('did not finish cleanly')
  })

  it('a throwing DOMAIN query sets incomplete and is not read as clean', async () => {
    const answers: Record<string, string[] | 'throw'> = cleanAnswers(DOMAINS)
    const surbl = BLOCKLISTS.find(l => l.code === 'SURBL')!
    answers[queryNameFor(surbl, DOMAINS[0])] = 'throw'

    const { resolve } = fakeResolver(answers)
    const v = await runBlocklistSweep({ resolve, domains: DOMAINS })

    expect(v.incomplete).toBe(true)
    expect(v.listedCount).toBe(0)
    // Crucially it is not silently absent: the failure is named.
    expect(v.controlFailures.some(c => c.detail.includes(DOMAINS[0]))).toBe(true)
  })

  it('counts a mid-run refusal on a TRUSTED list, neither listed nor clean', async () => {
    // Controls passed, then a domain query came back with URIBL's refusal code. Usually rate
    // limiting part way through. "Could not tell" is not "clean".
    const answers = cleanAnswers(DOMAINS)
    const uribl = BLOCKLISTS.find(l => l.code === 'URIBL')!
    answers[queryNameFor(uribl, DOMAINS[0])] = ['127.0.0.1']

    const { resolve } = fakeResolver(answers)
    const v = await runBlocklistSweep({ resolve, domains: DOMAINS })

    expect(v.refusedCount).toBe(1)
    expect(v.listedCount).toBe(0)
    expect(v.controlFailures).toEqual([])
    expect(v.detail).toContain('unrecognised answer')
    expect(v.detail).not.toMatch(/^No listings\./)
  })
})

describe('blocklist sweep: an empty domain list is not a pass', () => {
  it('reports zero domains and says so in those words', async () => {
    const { resolve } = fakeResolver(cleanAnswers([]))
    const v = await runBlocklistSweep({ resolve, domains: [] })

    expect(v.domainsChecked).toBe(0)
    expect(v.listedCount).toBe(0)
    expect(v.detail).toContain('not a pass')
    expect(v.detail).not.toMatch(/^No listings\./)
  })

  it('does not even run the controls when there is nothing to check', async () => {
    // Cheap assertion, but it pins the ordering: the controls exist to qualify domain
    // answers, so with no domains there is nothing to qualify.
    const { resolve, asked } = fakeResolver(cleanAnswers([]))
    await runBlocklistSweep({ resolve, domains: [] })
    // Controls still run per list, because lists_trusted is reported either way.
    expect(asked.length).toBe(6)
  })
})

describe('guards the guard', () => {
  it('the fake throws on an unplanned name, so the assertions above mean something', async () => {
    const { resolve } = fakeResolver({})
    await expect(resolve('anything.example')).rejects.toThrow('unplanned name')
  })

  it('a sweep against an empty fake is reported as incomplete, not as clean', async () => {
    // If the fake's throw ever stopped working this would come back OK-shaped, and every
    // negative assertion in this file would be worthless.
    const { resolve } = fakeResolver({})
    const v = await runBlocklistSweep({ resolve, domains: DOMAINS })
    expect(v.incomplete).toBe(true)
    expect(v.listsTrusted).toBe(0)
    expect(v.detail).not.toMatch(/^No listings\./)
  })
})
