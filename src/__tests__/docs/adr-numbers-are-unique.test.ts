// No two decisions in docs/ADR.md may carry the same number.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE DEFECT IS THE ALLOCATION METHOD, NOT EITHER SESSION
//
// On 2026-09-10 two different decisions were both holding ADR-051: one Locked in the
// Notion Decisions Log (the reply clock, 2026-09-07), one in another session's uncommitted
// working tree (client-facing counts read from our own records). Each session checked the
// file before choosing, found 051 free, and was right when it looked. A number is
// allocated by reading a file that two sessions can read at the same moment, so being
// careful does not prevent this. Only noticing at the point of landing does.
//
// Whichever lands second appends a second `## ADR-051` heading, and nothing said so. The
// numbering has drifted before: ADR-026 had to be renumbered to ADR-030 on 2026-08-24, and
// ADR-047 was nearly filed as ADR-039 on 2026-09-03.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS DOES NOT CATCH, STATED SO NOBODY OVER-TRUSTS IT
//
//   - A number claimed in Notion and never written here. The Notion ADR-051 is exactly
//     that today. This test sees the file only.
//   - Anything, if nobody runs it. This repository has no CI. The suite runs when a
//     session runs it, which by convention is before every commit, so this fires for the
//     second writer IF they run the suite. It is a tripwire, not a gate.
//
// Order is deliberately NOT checked. The file is out of order today (029 sits after 030,
// 038 after 039, 043 to 045 descend) and that is harmless. A duplicate is not.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ADR_PATH = path.resolve(__dirname, '../../../docs/ADR.md')

// The file held 50 numbered decisions on 2026-09-10. Decisions are superseded, never
// deleted, so this can only rise. It exists because a parser that silently matches NOTHING
// finds no duplicates and passes, which is the vacuous green this codebase keeps shipping.
// If the heading style changes and this trips, fix the pattern, never lower the floor.
const MIN_EXPECTED_DECISIONS = 50

interface AdrHeading {
  number: number
  line: number
  text: string
}

/**
 * Every heading that numbers a decision.
 *
 * Any heading level, because a decision filed as `### ADR-052` is still a claim on 052.
 * A hyphen, a space or nothing between ADR and the digits, and the number compared
 * NUMERICALLY, so `ADR-51` and `ADR-051` are the same claim. A two-digit number is the
 * most likely way a duplicate would otherwise slip past a three-digit pattern.
 *
 * Headings only. A decision that mentions another in prose ("see ADR-019") is a
 * reference, not a claim, and is ignored.
 */
export function findAdrHeadings(markdown: string): AdrHeading[] {
  const headings: AdrHeading[] = []
  markdown.split('\n').forEach((raw, i) => {
    const match = /^#{1,6}\s*ADR[-\s]?(\d+)\b/i.exec(raw)
    if (match) headings.push({ number: Number(match[1]), line: i + 1, text: raw.trim() })
  })
  return headings
}

export function findDuplicateNumbers(headings: AdrHeading[]): Map<number, AdrHeading[]> {
  const byNumber = new Map<number, AdrHeading[]>()
  for (const h of headings) byNumber.set(h.number, [...(byNumber.get(h.number) ?? []), h])
  return new Map([...byNumber].filter(([, claims]) => claims.length > 1))
}

function describeDuplicates(duplicates: Map<number, AdrHeading[]>): string {
  return [...duplicates]
    .map(([n, claims]) =>
      `ADR-${String(n).padStart(3, '0')} is claimed ${claims.length} times:\n` +
      claims.map(c => `    line ${c.line}: ${c.text.slice(0, 110)}`).join('\n'))
    .join('\n') +
    '\n\nTwo decisions share a number. Do not delete either. Decide which keeps it, give ' +
    'the other the next free number, and check the Notion Decisions Log for a claim on ' +
    'that number too before using it.'
}

describe('the parser', () => {
  it('reads a decision heading at any level', () => {
    const md = '# Title\n## ADR-001 — One\n### ADR-002 — Two\n## ADR-023\n'
    expect(findAdrHeadings(md).map(h => h.number)).toEqual([1, 2, 23])
  })

  it('treats a two-digit number as the same claim as its three-digit form', () => {
    const dupes = findDuplicateNumbers(findAdrHeadings('## ADR-051 — A\n## ADR-51 — B\n'))
    expect([...dupes.keys()]).toEqual([51])
  })

  it('ignores a decision mentioned in prose rather than claimed by a heading', () => {
    const md = '## ADR-019 — Tiers\nSee ADR-019 for the routing table.\nADR-019 Appendix — table\n'
    expect(findAdrHeadings(md)).toHaveLength(1)
  })

  it('finds a duplicate, and finds none where there is none', () => {
    // Both directions in one test, so a parser that reported everything or nothing as a
    // duplicate cannot pass.
    const clean = findAdrHeadings('## ADR-050 — A\n## ADR-051 — B\n')
    const dirty = findAdrHeadings('## ADR-050 — A\n## ADR-051 — B\n## ADR-051 — C\n')
    expect(findDuplicateNumbers(clean).size).toBe(0)
    expect([...findDuplicateNumbers(dirty).keys()]).toEqual([51])
  })
})

describe('docs/ADR.md', () => {
  const markdown = fs.readFileSync(ADR_PATH, 'utf8')
  const headings = findAdrHeadings(markdown)

  it('was actually read, and the parser found the decisions in it', () => {
    // Guards the assertion below against passing over an empty set.
    expect(
      headings.length,
      `found only ${headings.length} ADR headings in ${ADR_PATH}; expected at least ` +
      `${MIN_EXPECTED_DECISIONS}. Either the file moved or the heading style changed and ` +
      'the pattern in this test no longer matches it. Fix the pattern.',
    ).toBeGreaterThanOrEqual(MIN_EXPECTED_DECISIONS)
  })

  it('gives every decision its own number', () => {
    const duplicates = findDuplicateNumbers(headings)
    expect(duplicates.size, describeDuplicates(duplicates)).toBe(0)
  })
})
