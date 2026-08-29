// The inverted name check itself, kept out of the test file so it can be exercised
// directly. prompt-scan.ts and prompt-sources.ts already sit here for the same reason.

import { PROMPT_SOURCES, readSource } from './prompt-sources'
import { exampleSpans } from './prompt-scan'
import { ALLOWLIST } from './prompt-name-allowlist.data'
import { isOrdinaryWord } from '../../lib/style/ordinary-words'

export interface NameHit { source: string; line: number; token: string; quote: string }

// Contractions, stripped before the question is asked. "I'm" and "We've" are not names,
// and isOrdinaryWord only strips a possessive 's.
const decontract = (w: string) => w.replace(/['’](m|d|re|ve|ll|s)$/i, '')

const letters = (w: string) => w.replace(/[^A-Za-z]/g, '')

/**
 * True when a capitalised token is something a prompt example may contain.
 *
 * A SINGLE LETTER IS NEVER A NAME. "not just X, but Y and Z" is a style rule written with
 * placeholder variables, and single letters accounted for 65 of the first measurement's
 * 208 hits. No realistic leak is a one-letter company, so this costs nothing and removes
 * a third of the noise STRUCTURALLY rather than by blessing X, Y and Z by name.
 */
export function isAllowedToken(raw: string): boolean {
  const w = decontract(raw)
  if (letters(w).length <= 1) return true
  if (ALLOWLIST.has(w.toLowerCase())) return true
  if (isOrdinaryWord(w)) return true
  // A hyphenated compound is allowed when EVERY half is: "English-speaking",
  // "ICP-derived", "Founder-led". Checked against both lists, so a compound cannot be
  // allowed by a half that nothing has vouched for.
  if (w.includes('-')) {
    const parts = w.split('-').filter(p => letters(p).length > 0)
    return parts.length > 1 && parts.every(p =>
      letters(p).length <= 1 || ALLOWLIST.has(p.toLowerCase()) || isOrdinaryWord(p))
  }
  return false
}

export function scanNames(): NameHit[] {
  const out: NameHit[] = []
  for (const s of PROMPT_SOURCES) {
    const { label, lines } = readSource(s)
    for (const span of exampleSpans(lines)) {
      for (const m of span.text.matchAll(/\b[A-Za-z][A-Za-z'’-]*\b/g)) {
        const token = m[0]
        if (!/^[A-Z]/.test(token)) continue
        if (isAllowedToken(token)) continue
        out.push({ source: label, line: span.from, token, quote: span.text.replace(/\s+/g, ' ').slice(0, 90) })
      }
    }
  }
  return out
}
