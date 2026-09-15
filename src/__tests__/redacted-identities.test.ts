// ═══════════════════════════════════════════════════════════════════════════
// THE REGRESSION GUARD FOR THE 2026-09-15 IDENTITY SCRUB.
//
// It walks every tracked file, hashes every token, and fails if any token matches a
// digest in the data file beside this one. The names are never written down here or
// there; see that file for why a plaintext list would have been the leak itself.
//
// WHAT IT PROTECTS. A scrub is a one-off. Nothing stops the next session pasting a
// real prospect back in from a database read, a Sentry payload or an old branch, and
// the thing that makes that dangerous is that it looks exactly like ordinary test
// data. This is the check that notices.
//
// THE POSITIVE CONTROL IS PART OF THE TEST, not a thing done once by hand. A scanner
// that silently stops scanning reports the same green as a clean repository, which is
// the failure this repository has hit more than once. So one test below plants a known
// token, in memory, and asserts the scanner FINDS it. If that test ever fails, every
// other green in this file is meaningless.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REDACTED_TOKEN_HASHES, REDACTED_PHRASE_HASHES, REDACTED_TOKEN_LENGTHS } from './redacted-identities.data'

const REPO_ROOT = join(__dirname, '..', '..')

const NUL = String.fromCharCode(0)

// 40-char prefix, matching the data file. See there for why it is not the full digest.
const sha256 = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 40)

const TOKENS = new Set(REDACTED_TOKEN_HASHES)
const PHRASES = new Set(REDACTED_PHRASE_HASHES)
// Cheap pre-filter; see REDACTED_TOKEN_LENGTHS. A token of an unlisted length is
// skipped without hashing, which is what keeps a whole-repository scan fast.
const LENGTHS = new Set<number>(REDACTED_TOKEN_LENGTHS)

// THIS FILE AND ITS DATA FILE ARE EXEMPT, and they are the only exemptions. They hold
// digests rather than names, so they cannot match on content; the exemption exists so
// that a future maintainer adding a hash does not have to wonder.
const EXEMPT = new Set([
  'src/__tests__/redacted-identities.data.ts',
  'src/__tests__/redacted-identities.test.ts',
])

/** Tracked, non-binary files. git ls-files rather than a directory walk, so node_modules,
 *  build output and anything gitignored are excluded by construction rather than by a
 *  pattern list that would drift. */
function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
  return out.toString('utf8').split('\0').filter(Boolean).filter(f => !EXEMPT.has(f))
}

/** Lowercased alphanumeric runs. Apostrophes and hyphens split, so "Rowan's" yields
 *  "rowan" and "knot-consulting" yields "knot" and "consulting": a name hiding behind
 *  punctuation is still found. */
function tokenise(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9À-ɏ]+/g) ?? []
}

function scanText(text: string): string[] {
  const toks = tokenise(text)
  const hits: string[] = []
  for (let i = 0; i < toks.length; i++) {
    if (LENGTHS.has(toks[i].length) && TOKENS.has(sha256(toks[i]))) hits.push(`token#${i}`)
    if (i + 1 < toks.length && PHRASES.has(sha256(`${toks[i]} ${toks[i + 1]}`))) hits.push(`phrase#${i}`)
  }
  return hits
}

describe('the identity scrub does not regress', () => {
  // MUTATION: delete any replacement made on 2026-09-15 and this goes red.
  it('no tracked file contains a redacted identity', () => {
    const offenders: string[] = []
    for (const f of trackedFiles()) {
      let text: string
      try {
        text = readFileSync(join(REPO_ROOT, f), 'utf8')
      } catch {
        continue // unreadable or binary; nothing to match
      }
      if (text.indexOf(NUL) !== -1) continue // binary; nothing to match
      if (scanText(text).length > 0) offenders.push(f)
    }

    expect(
      offenders,
      `A redacted identity reappeared in:\n  ${offenders.join('\n  ')}\n` +
      'These are real people or real client organisations removed from this PUBLIC ' +
      'repository on 2026-09-15. Do not add an exemption. Replace the value with a ' +
      'placeholder from the prompt name allowlist data file.',
    ).toEqual([])
  }, 120_000)

  // THE CONTROL. Without this, a scanner that matched nothing would look identical to a
  // clean repository. It plants a token whose digest IS in the list and demands a hit.
  it('POSITIVE CONTROL: the scanner finds a planted identity', () => {
    // Reconstructed at runtime from character codes so the plaintext is not in the file.
    const planted = String.fromCharCode(115, 104, 101, 118, 111, 110, 110, 101)
    expect(TOKENS.has(sha256(planted))).toBe(true)
    expect(scanText(`a line of ordinary prose mentioning ${planted} in passing`)).not.toEqual([])
  })

  it('POSITIVE CONTROL: the scanner finds a planted two-word phrase', () => {
    const a = String.fromCharCode(102, 117, 108, 108)   // 4 letters
    const b = String.fromCharCode(98, 108, 111, 111, 109) // 5 letters
    expect(scanText(`she has run ${a} ${b} since 2023`)).not.toEqual([])
  })

  it('does not fire on ordinary prose', () => {
    expect(scanText('The writer prompt asks for one sentence, and the gate enforces it.')).toEqual([])
  })

  it('actually scanned a meaningful number of files', () => {
    // A zero-file scan passes the assertion above vacuously. This is the guard on the guard.
    expect(trackedFiles().length).toBeGreaterThan(500)
  })
})
