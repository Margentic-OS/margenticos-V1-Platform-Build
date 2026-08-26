import { describe, it, expect } from 'vitest'
import { toIso2CountryCode, aliasesForIso2 } from '../country-code'
import { checkSendEligibility } from '../send-eligibility-rules'

describe('country-code', () => {
  describe('toIso2CountryCode', () => {
    it('translates the exact string Apollo returned for the mailed German prospects', () => {
      // "Germany" is the literal value in raw_apollo for broeskamp.com and
      // knot-consulting.com, both of which were send-eligible and uploaded.
      expect(toIso2CountryCode('Germany')).toBe('DE')
    })

    it('translates the other country names present in live data', () => {
      expect(toIso2CountryCode('United States')).toBe('US')
      expect(toIso2CountryCode('Canada')).toBe('CA')
      expect(toIso2CountryCode('Australia')).toBe('AU')
    })

    it('passes an already-canonical ISO-2 code through unchanged', () => {
      expect(toIso2CountryCode('DE')).toBe('DE')
      expect(toIso2CountryCode('us')).toBe('US')
    })

    it('is tolerant of case and surrounding whitespace', () => {
      expect(toIso2CountryCode('  germany  ')).toBe('DE')
      expect(toIso2CountryCode('UNITED   STATES')).toBe('US')
    })

    it('maps alpha-3 and the native spelling for the excluded jurisdiction', () => {
      expect(toIso2CountryCode('DEU')).toBe('DE')
      expect(toIso2CountryCode('Deutschland')).toBe('DE')
    })

    it('returns null for null, undefined and empty input', () => {
      expect(toIso2CountryCode(null)).toBeNull()
      expect(toIso2CountryCode(undefined)).toBeNull()
      expect(toIso2CountryCode('   ')).toBeNull()
    })

    it('preserves an unmapped country verbatim rather than nulling it', () => {
      // Nulling would erase the only jurisdiction signal on the record, which is the exact
      // failure this module exists to close.
      expect(toIso2CountryCode('Wakanda')).toBe('Wakanda')
    })
  })

  describe('aliasesForIso2', () => {
    it('returns the code itself plus every spelling that maps to it', () => {
      const de = aliasesForIso2('DE')
      expect(de.has('DE')).toBe(true)
      expect(de.has('GERMANY')).toBe(true)
      expect(de.has('DEUTSCHLAND')).toBe(true)
      expect(de.has('DEU')).toBe(true)
    })

    it('does not leak aliases of other countries', () => {
      expect(aliasesForIso2('DE').has('UNITED STATES')).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // THE SEAM. Both sides of this were individually correct and fully tested, and the
  // defect lived entirely in the join between them. These are the tests whose absence
  // let two German prospects be mailed.
  // ═══════════════════════════════════════════════════════════════════════════
  describe('producer to consumer: the country written is the country the rule can read', () => {
    it('excludes a German prospect whose country came from Apollo as a name', () => {
      const written = toIso2CountryCode('Germany')
      const result = checkSendEligibility(written, 'broeskamp.udo@broeskamp.com')
      expect(result.is_eligible).toBe(false)
      expect(result.reason).toBe('country_excluded_de')
    })

    it('REGRESSION: the raw Apollo name alone must not read as eligible', () => {
      // This is the bug verbatim. Before 2026-08-25 this assertion failed: "Germany" is
      // not 'DE', the country branch returned eligible, and the .de domain fallback was
      // never reached because the domain is .com.
      const result = checkSendEligibility('Germany', 'jochen@knot-consulting.com')
      expect(result.is_eligible).toBe(false)
      expect(result.reason).toBe('country_excluded_de')
    })

    it('still excludes the .de prospect once its country is backfilled', () => {
      // craid.de was the ONLY excluded prospect, and only via the domain fallback. A naive
      // backfill writing "Germany" would have made the country branch return eligible and
      // skipped that fallback, turning the one working exclusion off.
      const written = toIso2CountryCode('Germany')
      const result = checkSendEligibility(written, 'daniel@craid.de')
      expect(result.is_eligible).toBe(false)
      expect(result.reason).toBe('country_excluded_de')
    })

    it('leaves non-excluded countries from live data eligible', () => {
      for (const [name, email] of [
        ['United States', 'a@example.com'],
        ['Canada', 'b@stackdconsulting.com'],
        ['Australia', 'c@electroconsulting.au'],
      ] as const) {
        const result = checkSendEligibility(toIso2CountryCode(name), email)
        expect(result.is_eligible, `${name} should be eligible`).toBe(true)
        expect(result.reason).toBeNull()
      }
    })
  })
})
