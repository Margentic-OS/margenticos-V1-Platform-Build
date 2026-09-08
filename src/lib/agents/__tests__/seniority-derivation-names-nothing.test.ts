// THE BANNED-CONTENT SCAN, EXTENDED TO THE CODE THAT DERIVES SENIORITY.
//
// ─── WHY CODE AND NOT ONLY PROMPTS ───────────────────────────────────────────
//
// findBannedContent already scans the buyer-criterion PROMPT, and prompt-forbidden-content
// scans fourteen other prompt sources. Neither has ever scanned ORDINARY CODE, and the
// defect this file guards was ordinary code: two lists of seniority bands written into a
// derivation, chosen by searching a client's document for two particular words.
//
// A scan that covers prompts and not code cannot see that. So this one reads the files that
// decide a client's buyer level and fails on any seniority or buyer-type vocabulary in them.
//
// ─── THE TWO EXEMPTIONS, AND WHY EACH IS NOT A LOOPHOLE ──────────────────────
//
// THE TRANSLATION LAYER IS EXEMPT. provider-seniority.ts contains the provider's band names
// because that is its entire job: it is the module that says what one sourcing tool will
// accept, in that tool's spelling, and CLAUDE.md puts tool vocabulary in the handler layer
// and nowhere else. Scanning it would be asking for the opposite of the rule. It is exempt
// BY NAME rather than by pattern, so a second file cannot quietly join it.
//
// THE CANONICAL INDUSTRY LIST IS EXEMPT, for the same reason the existing prompt scan
// exempts it: CANONICAL_INDUSTRIES is required to hold those exact names, and one of them
// contains a word that is also a seniority word. Exempted as a REGION of one file, located
// by its own declaration, so prose elsewhere in that file is still scanned.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BANNED_TITLE_WORDS } from '@/agents/buyer-criterion-agent'
import { PROVIDER_SENIORITY_BANDS } from '@/lib/sourcing/handlers/provider-seniority'

const ROOT = process.cwd()

/**
 * The files that decide, or help decide, a client's buyer level.
 *
 * ONE LIST OF PAIRS, so a file cannot be added without saying why it is scanned. The same
 * shape the prompt-source registry uses, for the same reason.
 */
const SCANNED = [
  ['src/lib/agents/icp-filter-spec.ts', 'builds the stored spec; held the deleted rule'],
  ['src/lib/sourcing/persist-icp-filter-spec.ts', 'obtains the bands and passes them in'],
  ['src/test-utils/seniority-fixture.ts', 'supplies bands to every test that needs one'],
  ['src/lib/agents/__tests__/spec-seniority-required.test.ts', 'the refusal tests'],
] as const

/**
 * Exempt by name. Adding to this is a deliberate act with a stated reason, not a default.
 */
const TRANSLATION_LAYER = ['src/lib/sourcing/handlers/provider-seniority.ts'] as const

/** Lines of one file, with the canonical-industry declaration removed. */
function scannableLines(path: string): { n: number; text: string }[] {
  const raw = readFileSync(join(ROOT, path), 'utf-8').split('\n')

  // Locate the canonical list by its own declaration and skip to its closing bracket. If the
  // declaration is not in this file, nothing is skipped.
  let from = -1
  let to = -1
  raw.forEach((line, i) => {
    if (from === -1 && /export const CANONICAL_INDUSTRIES/.test(line)) from = i
    if (from !== -1 && to === -1 && i > from && /^\] as const/.test(line)) to = i
  })

  return raw
    .map((text, i) => ({ n: i + 1, text }))
    .filter(l => !(from !== -1 && l.n - 1 >= from && l.n - 1 <= to))
}

/**
 * Whole-word matches, but ONLY INSIDE QUOTED STRINGS.
 *
 * ─── WHY QUOTED, AND WHAT IT COST TO LEARN ───────────────────────────────────
 *
 * The first version of this scanned whole lines and fired seven times on ordinary English:
 * `head` inside a comment about head nouns, and `entry` as the name of a loop variable.
 * Both are band names and neither is a buyer-type assertion. A guard that cries wolf gets
 * loosened until it stops working, so it was narrowed rather than exempted line by line.
 *
 * The defect's actual shape is a band name USED AS A VALUE, which in TypeScript means a
 * quoted literal: the two deleted lists were arrays of them. Prose and identifiers are not
 * quoted, so restricting the search to string literals keeps every real occurrence and
 * drops every false one. A quoted band inside a comment still fires, which is correct: a
 * worked example naming one is how the deleted list got written.
 */
export function findTitleWords(text: string, words: readonly string[]): string[] {
  // Possessive apostrophes first. `client's` opens a quote that never closes, and one of
  // those on the same line as a real literal would shift the pairing and hide it. Removing
  // them is not cosmetic: the comments in these files are full of possessives.
  const depossessed = text.replace(/(\w)'s\b/g, '$1s')
  const quoted = (depossessed.match(/'[^']*'|"[^"]*"|`[^`]*`/g) ?? []).join(' ').toLowerCase()
  if (!quoted) return []
  const hits: string[] = []
  for (const word of words) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(quoted)) hits.push(word)
  }
  return hits
}

interface Hit { file: string; line: number; word: string; text: string }

function scan(): Hit[] {
  const out: Hit[] = []
  // Both vocabularies: the generic title words, AND the provider's own band names, because
  // a band name copied out of the translation layer into a derivation is exactly the defect.
  const words = [...new Set([...BANNED_TITLE_WORDS, ...PROVIDER_SENIORITY_BANDS])]
  for (const [file] of SCANNED) {
    for (const { n, text } of scannableLines(file)) {
      for (const word of findTitleWords(text, words)) {
        out.push({ file, line: n, word, text: text.trim().slice(0, 110) })
      }
    }
  }
  return out
}

describe('the seniority derivation names no buyer type and no band', () => {
  it('scans clean', () => {
    const hits = scan()
    const report = hits.map(h => `  ${h.file}:${h.line} «${h.word}» ${h.text}`).join('\n')
    // ZERO, and it must stay zero. This is not a ratchet with a baseline: unlike the prompt
    // files, none of these has a legitimate reason to name a band, so there is nothing to
    // ratchet down from.
    expect(hits, `seniority or buyer-type vocabulary in the derivation:\n${report}`).toHaveLength(0)
  })

  it('found real code to scan, so the assertion above is not vacuous', () => {
    for (const [file] of SCANNED) {
      expect(scannableLines(file).length, `${file} scanned as empty`).toBeGreaterThan(20)
    }
  })

  it('the canonical-industry exemption removes that list and nothing else', () => {
    const all = readFileSync(join(ROOT, 'src/lib/agents/icp-filter-spec.ts'), 'utf-8').split('\n').length
    const kept = scannableLines('src/lib/agents/icp-filter-spec.ts').length
    // It removes something...
    expect(kept).toBeLessThan(all)
    // ...but only the list, not most of the file.
    expect(kept).toBeGreaterThan(all * 0.7)
  })

  it('the translation layer is exempt BY NAME, and is not in the scanned set', () => {
    // The one file that must contain band names. Naming it here rather than matching a
    // directory means a second file cannot join the exemption by being put beside it.
    expect(TRANSLATION_LAYER).toHaveLength(1)
    for (const exempt of TRANSLATION_LAYER) {
      expect(SCANNED.map(([f]) => f)).not.toContain(exempt)
      // And it really does carry the vocabulary, so the exemption is load-bearing rather
      // than a precaution against something that never happens.
      // LINE BY LINE, as the scan itself runs. Matching over a whole file at once pairs
      // quotes across newlines and reports zero here, which is how this assertion first
      // failed: the file plainly contains the vocabulary.
      const found = new Set<string>()
      for (const line of readFileSync(join(ROOT, exempt), 'utf-8').split('\n')) {
        for (const w of findTitleWords(line, PROVIDER_SENIORITY_BANDS)) found.add(w)
      }
      expect(found.size).toBeGreaterThan(3)
    }
  })

  it('the scan can detect a violation, proved on a planted string rather than on the code', () => {
    // The instrument's own positive control. Without this, a scan that matched nothing
    // would pass the first test for the wrong reason.
    for (const band of PROVIDER_SENIORITY_BANDS.slice(0, 3)) {
      expect(findTitleWords(`return ['${band}'] as const`, PROVIDER_SENIORITY_BANDS)).toContain(band)
    }
    expect(findTitleWords('an ordinary sentence about nothing', PROVIDER_SENIORITY_BANDS)).toEqual([])
    // The two false positives that made the first version of this useless. Both are band
    // names in ordinary English, unquoted, and neither asserts anything about a buyer.
    expect(findTitleWords('// the head noun is the category word', PROVIDER_SENIORITY_BANDS)).toEqual([])
    expect(findTitleWords('.map(entry => entry.fragment)', PROVIDER_SENIORITY_BANDS)).toEqual([])
    // And the shape that must still fire: a band quoted inside a comment.
    expect(findTitleWords("// for example, return ['director']", PROVIDER_SENIORITY_BANDS)).toContain('director')
  })
})
