// No email template may contain an em dash or an en dash.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A TEST AND NOT A STYLE NOTE
//
// sendTransactionalEmail REJECTS any subject, html or text containing '—' or '–'. It
// returns success: false and raises a Sentry exception. So a dash in a template is not
// a cosmetic problem: that email never sends, for anyone, for ever.
//
// Six templates carried one in their SENT content on 2026-09-07, four of them live
// operator alerts including agent-failure, which is the message that tells the operator
// a document agent has broken. Those alerts had been silently failing to send.
//
// The project has banned these characters since its first day, in prose, in CLAUDE.md.
// Prose did not enforce it. This is the same lesson as the commit-gate hooks: a rule
// that depends on somebody remembering is not a control.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY IT SCANS THE WHOLE FILE, COMMENTS INCLUDED
//
// Restricting the scan to sent content means deciding which bytes are a comment and
// which are inside a template literal. That needs a parser, and a parser that guesses
// wrong in the permissive direction reopens the exact hole this closes, silently. A
// whole-file scan cannot be wrong in that direction.
//
// The cost is that a dash in a comment fails the build. That is cheap to fix and the
// style rule bans it there too, so nothing legitimate is being blocked.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const TEMPLATE_DIR = join(process.cwd(), 'src/lib/email/templates')

const EM_DASH = '—'
const EN_DASH = '–'

function templateFiles(): string[] {
  return readdirSync(TEMPLATE_DIR)
    .filter(name => name.endsWith('.ts'))
    .sort()
}

function offendingLines(contents: string): { line: number; text: string; char: string }[] {
  const hits: { line: number; text: string; char: string }[] = []
  contents.split('\n').forEach((text, index) => {
    if (text.includes(EM_DASH)) hits.push({ line: index + 1, text: text.trim(), char: 'em dash' })
    if (text.includes(EN_DASH)) hits.push({ line: index + 1, text: text.trim(), char: 'en dash' })
  })
  return hits
}

describe('email templates carry no em or en dashes', () => {
  it('finds template files to scan at all', () => {
    // The guard on the guard. An empty directory, a moved path or a changed extension
    // would make every assertion below pass over nothing, which is the vacuous-green
    // shape this suite exists to prevent.
    expect(templateFiles().length).toBeGreaterThan(10)
  })

  it('can detect a dash it is given, so a clean result means something', () => {
    // Positive control. Proves the matcher works before its negative is trusted.
    const planted = `const x = 'MargenticOS ${EM_DASH} Operator Alert'`
    expect(offendingLines(planted)).toHaveLength(1)
    expect(offendingLines(`const y = 'a ${EN_DASH} b'`)).toHaveLength(1)
    expect(offendingLines("const z = 'a - b'")).toHaveLength(0)
  })

  it.each(templateFiles())('%s contains no em or en dash', (name) => {
    const contents = readFileSync(join(TEMPLATE_DIR, name), 'utf8')
    const hits = offendingLines(contents)

    const report = hits
      .map(h => `  line ${h.line}: ${h.char} in "${h.text}"`)
      .join('\n')

    expect(
      hits,
      `${name} contains ${hits.length} forbidden dash(es). sendTransactionalEmail ` +
        `rejects these, so every send using this template fails.\n${report}`
    ).toHaveLength(0)
  })
})
