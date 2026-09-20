// WHICH VARIANTS SHIP AN OPENING THAT NEEDS THE PARAGRAPH ABOVE IT. Item 16.
//
// RULE ZERO ON THE FIXTURES. Every document below is invented here. No client, sector,
// buyer type or real variant copy appears: the real paragraph that prompted this names an
// industry, and a fixture is copyable.
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/operator/__tests__/fallback-opening-report.test.ts

import { describe, it, expect } from 'vitest'
import { reportFallbackOpenings } from '../fallback-opening-report'

/** A document in the current four-variant format, with one Email 1 per variant. */
function doc(openings: Record<string, string>) {
  return {
    variants: Object.fromEntries(
      Object.entries(openings).map(([id, opening]) => [
        id,
        {
          emails: [
            {
              sequence_position: 1,
              body: `{{first_name}}\n\n${opening}\n\nWe run outbound for you.\n\nWorth a look?\n\nSam\nNorthwind`,
            },
            { sequence_position: 2, body: '{{first_name}}\n\nFollowing up.\n\nSam\nNorthwind' },
          ],
        },
      ]),
    ),
  }
}

describe('reportFallbackOpenings', () => {
  it('reports a variant whose opening points at something never named', () => {
    const { findings, variantsChecked } = reportFallbackOpenings(
      doc({ a: 'Where this tends to show up is in the third month of a quarter.' }),
    )
    expect(variantsChecked).toBe(1)
    expect(findings).toHaveLength(1)
    expect(findings[0].variantId).toBe('a')
    expect(findings[0].faults.length).toBeGreaterThan(0)
  })

  // THE CONTROL. A report that flags every variant is not a report.
  it('reports nothing for openings that stand on their own', () => {
    const { findings, variantsChecked } = reportFallbackOpenings(
      doc({
        a: 'Your last three hires were all in delivery, none in sales.',
        b: 'Most teams your size run outreach off one person’s calendar.',
      }),
    )
    expect(variantsChecked).toBe(2)
    expect(findings).toEqual([])
  })

  it('reports only the variants that are actually faulty', () => {
    const { findings, variantsChecked } = reportFallbackOpenings(
      doc({
        clean: 'Your last three hires were all in delivery, none in sales.',
        broken: 'But the follow-up never gets written.',
      }),
    )
    expect(variantsChecked).toBe(2)
    expect(findings.map(f => f.variantId)).toEqual(['broken'])
  })

  it('carries the opening itself, so an operator can read what is wrong', () => {
    const opening = 'That gap widens every month.'
    const { findings } = reportFallbackOpenings(doc({ a: opening }))
    expect(findings[0].opening).toBe(opening)
  })

  // ── "NOTHING FOUND" AND "NOTHING LOOKED AT" ARE DIFFERENT ANSWERS ─────────
  //
  // This is the distinction the whole return shape exists for. An empty findings array
  // from an unreadable document must not read as a clean bill of health, which is the
  // failure mode CLAUDE.md records again and again.
  it.each([
    ['null', null],
    ['a string', 'not a document'],
    ['an empty object', {}],
    ['variants with no emails', { variants: { a: {} } }],
  ])('reports nothing checked for %s', (_name, content) => {
    const report = reportFallbackOpenings(content)
    expect(report.variantsChecked).toBe(0)
    expect(report.findings).toEqual([])
  })

  // A variant whose emails ARE a readable array but hold no opening line must not be
  // counted as checked. Found by mutation-testing: the earlier fixtures all failed the
  // is-it-an-array guard first, so the path that decides this was never exercised.
  it.each([
    ['no Email 1 at all', [{ sequence_position: 2, body: '{{first_name}}\n\nFollow-up.' }]],
    ['an Email 1 with only a greeting', [{ sequence_position: 1, body: '{{first_name}}' }]],
    ['an Email 1 with an empty body', [{ sequence_position: 1, body: '' }]],
  ])('does not count a variant with %s as checked', (_name, emails) => {
    const report = reportFallbackOpenings({ variants: { a: { emails } } })
    expect(report.variantsChecked).toBe(0)
    expect(report.findings).toEqual([])
  })

  it('counts only the variants it could actually read', () => {
    const report = reportFallbackOpenings({
      variants: {
        readable: {
          emails: [{ sequence_position: 1, body: '{{first_name}}\n\nThat gap widens.\n\nSam' }],
        },
        unreadable: { emails: [{ sequence_position: 1, body: '{{first_name}}' }] },
      },
    })
    expect(report.variantsChecked).toBe(1)
    expect(report.findings).toHaveLength(1)
  })

  it('distinguishes a clean document from an unreadable one by the count', () => {
    const clean = reportFallbackOpenings(doc({ a: 'Your team shipped twice last month.' }))
    const unreadable = reportFallbackOpenings(null)
    expect(clean.findings).toEqual(unreadable.findings)       // both empty
    expect(clean.variantsChecked).not.toBe(unreadable.variantsChecked) // and tell apart
  })

  // The single-sequence format pre-dates ADR-014 and stored documents still carry it.
  it('reads the legacy single-sequence format too', () => {
    const { variantsChecked, findings } = reportFallbackOpenings({
      emails: [
        {
          sequence_position: 1,
          body: '{{first_name}}\n\nThose meetings stop appearing in the diary.\n\nSam\nNorthwind',
        },
      ],
    })
    expect(variantsChecked).toBe(1)
    expect(findings).toHaveLength(1)
  })

  it('judges the same shape identically across unrelated subject matter', () => {
    const { findings } = reportFallbackOpenings(
      doc({
        freight: 'That backlog grows quietly between releases.',
        clinical: 'That ward runs short of beds every winter.',
        software: 'That queue never empties before Friday.',
      }),
    )
    expect(findings).toHaveLength(3)
  })
})
