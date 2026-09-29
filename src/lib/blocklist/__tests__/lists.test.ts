import { describe, it, expect } from 'vitest'
import {
  BLOCKLISTS,
  BRAND_DOMAINS,
  brandDomainsFrom,
  CLEAN_CONTROL_DOMAIN,
  classifyAnswer,
  queryNameFor,
  withSpamhausDqsKey,
  type Blocklist,
} from '../lists'

/**
 * BOTH DIRECTIONS, EVERY LIST.
 *
 * Every address below was MEASURED on 2026-09-28, not invented. The listed ones came back
 * from the lists' own test points and from the two MargenticOS domains that are genuinely
 * listed; the refusal codes came back from 1.1.1.1 and 8.8.8.8.
 *
 * The direction that matters most is the refusal one. If a refusal were read as a listing
 * the monitor cries wolf about five healthy domains; if it were read as CLEAN the monitor
 * goes green over the thing it exists to find. The second is the one that has actually
 * happened to this project, repeatedly, in other checks.
 */

function list(code: string): Blocklist {
  const found = BLOCKLISTS.find(l => l.code === code)
  if (!found) throw new Error(`no such list ${code}`)
  return found
}

describe('blocklist answer classification', () => {
  // ── Guard the guard ─────────────────────────────────────────────────────────
  it('has all three lists registered, so the cases below are not vacuous', () => {
    expect(BLOCKLISTS.map(l => l.code).sort()).toEqual(['SPAMHAUS_DBL', 'SURBL', 'URIBL'])
    for (const l of BLOCKLISTS) {
      expect(l.zone, `${l.code} zone`).toBeTruthy()
      expect(l.testPoint, `${l.code} test point`).toBeTruthy()
    }
  })

  describe('Spamhaus DBL', () => {
    const dbl = list('SPAMHAUS_DBL')

    it('reads its own test point answer as LISTED', () => {
      // dbltest.com.dbl.spamhaus.org -> 127.0.1.2, measured 2026-09-28
      expect(classifyAnswer(dbl, ['127.0.1.2'])).toBe('listed')
    })

    it('reads the whole documented listing range as LISTED', () => {
      for (const octet of [2, 3, 4, 5, 11, 50, 99]) {
        expect(classifyAnswer(dbl, [`127.0.1.${octet}`]), `127.0.1.${octet}`).toBe('listed')
      }
    })

    it('does NOT read its blocked code as listed, and does not read it as clean either', () => {
      // 1.1.1.1 -> 127.255.255.254. This is "query blocked / via public resolver".
      // Treating it as listed would false-alarm on every domain; treating it as clean would
      // blind the monitor. It must be neither.
      expect(classifyAnswer(dbl, ['127.255.255.254'])).toBe('refused')
      for (const octet of [252, 253, 254, 255]) {
        expect(classifyAnswer(dbl, [`127.255.255.${octet}`])).toBe('refused')
      }
    })

    it('does not read the typing-error code as a listing', () => {
      // 127.0.1.255 is "typing error, not a domain", outside the 2..99 listing range.
      expect(classifyAnswer(dbl, ['127.0.1.255'])).toBe('refused')
    })

    it('reads an empty answer as NOT LISTED, which is only safe because of the control', () => {
      // THE DANGEROUS CASE, MEASURED: 8.8.8.8 returned empty for dbltest.com, a domain
      // Spamhaus certainly lists. Empty genuinely means "not listed" for a clean domain, so
      // this classification is correct in isolation and USELESS without the positive
      // control. sweep.test.ts is where that pairing is proved.
      expect(classifyAnswer(dbl, [])).toBe('not_listed')
    })

    it('ignores SURBL-shaped answers, because the octet position differs', () => {
      // 127.0.0.64 is a SURBL abuse listing. On DBL, the third octet must be 1.
      expect(classifyAnswer(dbl, ['127.0.0.64'])).toBe('refused')
    })
  })

  describe('SURBL', () => {
    const surbl = list('SURBL')

    it('reads its own test point answer as LISTED', () => {
      // test.surbl.org.multi.surbl.org -> 127.0.0.254, every bit set. Measured.
      expect(classifyAnswer(surbl, ['127.0.0.254'])).toBe('listed')
    })

    it('reads the real abuse listing found on 2026-09-28 as LISTED', () => {
      // getmargenticos.com and inboxmargenticos.com both returned exactly this.
      expect(classifyAnswer(surbl, ['127.0.0.64'])).toBe('listed')
    })

    it('reads each individual sublist bit as LISTED', () => {
      for (const bit of [2, 4, 8, 16, 32, 64, 128]) {
        expect(classifyAnswer(surbl, [`127.0.0.${bit}`]), `bit ${bit}`).toBe('listed')
      }
    })

    it('does NOT read a bare 127.0.0.1 as a listing: bit 1 is not a sublist', () => {
      expect(classifyAnswer(surbl, ['127.0.0.1'])).toBe('refused')
    })

    it('reads an empty answer as NOT LISTED', () => {
      expect(classifyAnswer(surbl, [])).toBe('not_listed')
    })
  })

  describe('URIBL', () => {
    const uribl = list('URIBL')

    it('reads its own test point answer as LISTED', () => {
      // test.uribl.com.multi.uribl.com -> 127.0.0.14, which is black|grey|red. Measured.
      expect(classifyAnswer(uribl, ['127.0.0.14'])).toBe('listed')
    })

    it('reads each of black, grey and red as LISTED', () => {
      expect(classifyAnswer(uribl, ['127.0.0.2'])).toBe('listed')
      expect(classifyAnswer(uribl, ['127.0.0.4'])).toBe('listed')
      expect(classifyAnswer(uribl, ['127.0.0.8'])).toBe('listed')
    })

    it('does NOT read its refusal code as a listing', () => {
      // MEASURED: both 8.8.8.8 and 208.67.222.222 returned 127.0.0.1 for URIBL's own test
      // point. That is URIBL's documented "query refused". It has no list bit set.
      expect(classifyAnswer(uribl, ['127.0.0.1'])).toBe('refused')
    })

    it('does not read a SURBL-only bit as a URIBL listing', () => {
      // 64 is SURBL's abuse bit and is not one of URIBL's three.
      expect(classifyAnswer(uribl, ['127.0.0.64'])).toBe('refused')
    })

    it('reads an empty answer as NOT LISTED', () => {
      expect(classifyAnswer(uribl, [])).toBe('not_listed')
    })
  })

  describe('anything unrecognised fails closed', () => {
    it.each(BLOCKLISTS.map(l => [l.code, l] as const))(
      '%s reads a garbage answer as refused, never as clean',
      (_code, l) => {
        expect(classifyAnswer(l, ['10.0.0.1'])).toBe('refused')
        expect(classifyAnswer(l, ['not-an-ip'])).toBe('refused')
        expect(classifyAnswer(l, ['127.0.2.5'])).toBe('refused')
      },
    )

    it('reads a listing as listed even when a refusal is also present', () => {
      // A multi-answer response with one real listing is a listing. The listing is the
      // finding; ignoring it because a sibling answer was odd would lose the signal.
      const surbl = list('SURBL')
      expect(classifyAnswer(surbl, ['127.0.0.1', '127.0.0.64'])).toBe('listed')
    })
  })
})

describe('query name construction', () => {
  it('appends the zone to the domain', () => {
    expect(queryNameFor(list('SURBL'), 'getmargenticos.com')).toBe(
      'getmargenticos.com.multi.surbl.org',
    )
  })

  it('lowercases and trims, so one domain is never queried as two', () => {
    expect(queryNameFor(list('SURBL'), '  GetMargenticos.COM ')).toBe(
      'getmargenticos.com.multi.surbl.org',
    )
  })

  it('uses each list its own test point, because they are not interchangeable', () => {
    // Asking SURBL about Spamhaus's test point returns empty, which would read as a broken
    // control on a healthy list. Each list must carry its own.
    const points = BLOCKLISTS.map(l => l.testPoint)
    expect(new Set(points).size, 'two lists share a test point').toBe(points.length)
    expect(list('SPAMHAUS_DBL').testPoint).toBe('dbltest.com')
    expect(list('SURBL').testPoint).toBe('test.surbl.org')
    expect(list('URIBL').testPoint).toBe('test.uribl.com')
  })

  it('has a clean control that is not one of the test points', () => {
    expect(BLOCKLISTS.map(l => l.testPoint)).not.toContain(CLEAN_CONTROL_DOMAIN)
  })
})

describe('Spamhaus DQS key swaps only the Spamhaus zone', () => {
  it('leaves the public zone in place when no key is set', () => {
    for (const raw of [undefined, '', '   ']) {
      const lists = withSpamhausDqsKey(BLOCKLISTS, raw)
      expect(lists.find(l => l.code === 'SPAMHAUS_DBL')!.zone).toBe('dbl.spamhaus.org')
    }
  })

  it('uses the per-account zone when a key is set, and touches nothing else', () => {
    const lists = withSpamhausDqsKey(BLOCKLISTS, 'abc123')
    expect(lists.find(l => l.code === 'SPAMHAUS_DBL')!.zone).toBe('abc123.dbl.dq.spamhaus.net')
    expect(lists.find(l => l.code === 'SURBL')!.zone).toBe('multi.surbl.org')
    expect(lists.find(l => l.code === 'URIBL')!.zone).toBe('multi.uribl.com')
  })

  it('keeps the classifier working after the zone swap', () => {
    // The swap spreads the object. A shallow copy that dropped isListed would make every
    // answer 'refused' and the monitor permanently red, so assert the function survived.
    const swapped = withSpamhausDqsKey(BLOCKLISTS, 'abc123').find(
      l => l.code === 'SPAMHAUS_DBL',
    )!
    expect(classifyAnswer(swapped, ['127.0.1.2'])).toBe('listed')
    expect(classifyAnswer(swapped, ['127.255.255.254'])).toBe('refused')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE BRAND-DOMAIN FLOOR
//
// margenticos.com has no mailboxes, so it can never come back from
// sendingDomainsInUse(). Coverage of it depends entirely on this floor, which means the
// failure mode to guard against is not "the wrong domain is checked" but "no domain is
// checked and the monitor still says OK".
// ═════════════════════════════════════════════════════════════════════════════

describe('brandDomainsFrom: the floor cannot be configured away', () => {
  it('includes the corporate domain when the env var is absent', () => {
    expect(brandDomainsFrom(undefined)).toContain('margenticos.com')
  })

  it.each([
    ['empty string', ''],
    ['whitespace', '   '],
    ['just separators', ' , ,, '],
    ['junk that is not a domain', 'not a domain!, @@@, http://x.com'],
    ['a bare word with no dot', 'localhost'],
  ])('degrades to the floor rather than to empty: %s', (_label, raw) => {
    // The point of the assertion: a mistyped or empty environment variable must not be able
    // to reduce coverage to nothing. An empty result here would be a monitor reporting OK
    // while asking about no domain at all.
    expect(brandDomainsFrom(raw)).toEqual(['margenticos.com'])
  })

  it('adds extra domains without displacing the floor', () => {
    const got = brandDomainsFrom('margenticos.co.uk, example.org')
    expect(got).toContain('margenticos.com')
    expect(got).toContain('margenticos.co.uk')
    expect(got).toContain('example.org')
  })

  it('normalises case and whitespace, and de-duplicates', () => {
    expect(brandDomainsFrom('  MARGENTICOS.COM , margenticos.com ')).toEqual(['margenticos.com'])
  })

  it('drops junk entries while keeping the valid ones in the same input', () => {
    const got = brandDomainsFrom('good.example, !!!bad!!!, also-good.example')
    expect(got).toContain('good.example')
    expect(got).toContain('also-good.example')
    expect(got.some(d => d.includes('!'))).toBe(false)
  })

  it('BRAND_DOMAINS itself is non-empty, which is what every guarantee above rests on', () => {
    // If this list were ever emptied, every test above would still pass vacuously except
    // this one. That is the whole reason it is asserted separately.
    expect(BRAND_DOMAINS.length).toBeGreaterThan(0)
    expect(BRAND_DOMAINS).toContain('margenticos.com')
  })
})
