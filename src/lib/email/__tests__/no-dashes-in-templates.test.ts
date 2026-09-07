// No CUSTOMER-FACING email template may contain an em dash or an en dash.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY CUSTOMER-FACING ONLY, WHICH IS NARROWER THAN THIS TEST FIRST WAS
//
// This file originally scanned every template. It was narrowed when it met main, which had
// independently established the better rule: the dash ban is a PROSPECT-FACING STYLE RULE,
// not a rendering rule. MargenticOS's ICP is founder-led consulting firms burned by AI
// email and the em dash is the most recognisable tell. An internal alert reaches neither a
// client nor a prospect, so applying the rule there was a category error, and it cost every
// operator notification the system ever tried to send.
//
// sendTransactionalEmail now skips the dash checks for audience: 'operator'. So a dash in
// an operator template is no longer a defect and this test must not claim it is. Forbidding
// what the sender deliberately permits would be a test asserting a rule the system does not
// have.
//
// For a CUSTOMER template the dash is still two faults at once: the send is rejected
// outright, and if it were not, the copy carries the tell. That is what remains guarded.
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE LIST IS AN OPERATOR ALLOWLIST, SO THE DEFAULT IS STRICT
//
// A template not named below is treated as customer-facing and scanned. That matches the
// sender's own default ('customer', the strict choice), so forgetting to classify a new
// template can only ever make it stricter, never laxer.
//
// The allowlist is checked against the filesystem: if a named file stops existing the test
// fails rather than silently exempting nothing.
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

// Templates sent with audience: 'operator'. Verified against their call sites on
// 2026-09-07. Everything else is treated as customer-facing and scanned.
const OPERATOR_TEMPLATES = [
  'agent-failure.ts',
  'approval-reminder.ts',
  'intake-complete.ts',
  'multi-user-signup-attempt.ts',
  'operator-reply.ts',
  'revision-gate-failure.ts',
  'suggestion-ready.ts',
]

function templateFiles(): string[] {
  return readdirSync(TEMPLATE_DIR)
    .filter(name => name.endsWith('.ts'))
    .sort()
}

function customerFacingTemplates(): string[] {
  return templateFiles().filter(name => !OPERATOR_TEMPLATES.includes(name))
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
    expect(customerFacingTemplates().length).toBeGreaterThan(5)
  })

  it('can detect a dash it is given, so a clean result means something', () => {
    // Positive control. Proves the matcher works before its negative is trusted.
    const planted = `const x = 'MargenticOS ${EM_DASH} Operator Alert'`
    expect(offendingLines(planted)).toHaveLength(1)
    expect(offendingLines(`const y = 'a ${EN_DASH} b'`)).toHaveLength(1)
    expect(offendingLines("const z = 'a - b'")).toHaveLength(0)
  })

  it('every allowlisted operator template actually exists', () => {
    // Guards the allowlist itself. A renamed file would otherwise exempt nothing while
    // looking like it exempted something, and the renamed template would be scanned under
    // rules it was deliberately released from.
    const present = templateFiles()
    const missing = OPERATOR_TEMPLATES.filter(name => !present.includes(name))
    expect(missing, `allowlisted but absent: ${missing.join(', ')}`).toHaveLength(0)
  })

  it.each(customerFacingTemplates())('%s contains no em or en dash', (name) => {
    const contents = readFileSync(join(TEMPLATE_DIR, name), 'utf8')
    const hits = offendingLines(contents)

    const report = hits
      .map(h => `  line ${h.line}: ${h.char} in "${h.text}"`)
      .join('\n')

    expect(
      hits,
      `${name} is customer-facing and contains ${hits.length} forbidden dash(es). ` +
        `sendTransactionalEmail rejects these for a customer audience, so every send ` +
        `using this template fails, and the dash is an AI tell besides.\n${report}`
    ).toHaveLength(0)
  })
})
