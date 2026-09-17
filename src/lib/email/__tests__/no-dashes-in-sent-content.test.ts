// No CUSTOMER-FACING copy may contain an em dash or an en dash — INCLUDING the copy that
// does not live in src/lib/email/templates/.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY A SECOND FILE RATHER THAN A WIDER GLOB IN THE FIRST ONE
//
// no-dashes-in-templates.test.ts scans WHOLE FILES. That is right for a templates
// directory, where essentially every byte is copy, and its own header explains why:
// deciding which bytes are sent content needs a parser, and a parser that guesses wrong in
// the permissive direction reopens the hole silently.
//
// That reasoning does not transfer. Measured 2026-09-15: process-reply.ts contains 33 em
// or en dashes, every one of them in a comment or a logger call, all legitimate. A
// whole-file scan pointed at it fails instantly and permanently. Widening the glob would
// force the scan to become a parser, which is the thing the first file refused to build.
//
// ═══════════════════════════════════════════════════════════════════════════════
// SO THIS FILE CHECKS BYTES, NOT SOURCE TEXT
//
// Each entry CALLS the producer and scans what it RETURNS. That is the string the prospect
// receives, so it cannot be wrong in the permissive direction the way a parser can: there
// is no question of which bytes count, because the bytes are the answer.
//
// It is also stronger than a source scan in one way and weaker in another, and both are
// worth stating. Stronger: it sees interpolated values, so a dash arriving through a
// parameter is caught too. Weaker: it only covers the argument combinations listed here,
// so a branch of a producer that no case reaches is not checked. The producers below have
// no such branch today; if one grows a branch, add a case.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY THIS COPY HAS NO OTHER PROTECTION AT ALL
//
// validateEmailContent in src/lib/email/send.ts rejects a dash at send. It is reached only
// through sendTransactionalEmail. The reply path does not use it: send-approved-draft.ts
// and process-reply.ts call sendThreadReply, which POSTs to the provider and validates
// nothing. Verified 2026-09-15: validateEmailContent has no reference outside send.ts.
//
// So for this copy there is no build-time scan and no runtime check. This file is the only
// thing standing between an em dash and a prospect who has just asked to book a call,
// which is the single worst audience for the tell that MargenticOS's own ICP is defined by
// noticing. Per ADR-050 the operator exemption does not apply here: this is customer copy.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildBookingReplyBody } from '@/lib/reply-handling/process-reply'
import { OPT_OUT_FOOTER } from '@/lib/composition/opt-out-footer'
import { plainTextToHtml } from '@/lib/composition/custom-variables'

const EM_DASH = '—'
const EN_DASH = '–'

function offendingChars(text: string): string[] {
  const hits: string[] = []
  if (text.includes(EM_DASH)) hits.push('em dash')
  if (text.includes(EN_DASH)) hits.push('en dash')
  return hits
}

/**
 * Customer-facing copy produced OUTSIDE the templates directory.
 *
 * `produce` returns the exact string that reaches the prospect. Arguments are plain and
 * dash-free on purpose: a dash appearing in the OUTPUT can then only have come from the
 * producer's own hardcoded text, which is what this gate is about.
 */
const SENT_CONTENT: { name: string; where: string; produce: () => string }[] = [
  {
    name: 'buildBookingReplyBody',
    where: 'src/lib/reply-handling/process-reply.ts',
    produce: () =>
      buildBookingReplyBody('Sam', 'Alex', 'https://example.com/book', null) ?? '',
  },
  {
    name: 'buildBookingReplyBody (no prospect first name, falls back to "there")',
    where: 'src/lib/reply-handling/process-reply.ts',
    produce: () => buildBookingReplyBody(null, 'Alex', 'https://example.com/book', null) ?? '',
  },
  {
    name: 'OPT_OUT_FOOTER',
    where: 'src/lib/composition/opt-out-footer.ts',
    produce: () => OPT_OUT_FOOTER,
  },
  {
    name: 'plainTextToHtml (the wrapper every reply body is rendered through)',
    where: 'src/lib/composition/custom-variables.ts',
    produce: () => plainTextToHtml(`Hi Sam,\n\nA plain line.\n\n${OPT_OUT_FOOTER}`),
  },
]

describe('customer-facing copy outside the templates directory carries no dashes', () => {
  it('has producers to check at all', () => {
    // The guard on the guard. An empty registry would make every assertion below pass over
    // nothing, which is the vacuous-green shape this suite exists to prevent.
    expect(SENT_CONTENT.length).toBeGreaterThan(3)
  })

  it('can detect a dash it is given, so a clean result means something', () => {
    // Positive control on the matcher, before its negatives are trusted.
    expect(offendingChars(`a ${EM_DASH} b`)).toEqual(['em dash'])
    expect(offendingChars(`a ${EN_DASH} b`)).toEqual(['en dash'])
    expect(offendingChars('a - b')).toEqual([])
  })

  it('every producer actually returns copy, so an empty string cannot pass as clean', () => {
    // A producer that silently returned '' would satisfy the dash assertion forever. This
    // is the same failure the templates test guards with its file-count check.
    for (const { name, produce } of SENT_CONTENT) {
      expect(produce().trim().length, `${name} returned nothing`).toBeGreaterThan(10)
    }
  })

  it.each(SENT_CONTENT.map(s => [s.name, s] as const))(
    '%s contains no em or en dash',
    (_name, entry) => {
      const output = entry.produce()
      const hits = offendingChars(output)
      expect(
        hits,
        `${entry.name} (${entry.where}) is customer-facing copy and its OUTPUT contains ` +
          `${hits.join(' and ')}. This copy is sent through sendThreadReply, which never ` +
          `calls validateEmailContent, so nothing catches this at runtime either.`
      ).toHaveLength(0)
    },
  )
})

// ═══════════════════════════════════════════════════════════════════════════════
// THE SECOND HALF: a producer added later is not silently uncovered.
//
// The registry above is a hand-maintained list, which is the "second list to keep in step"
// shape CLAUDE.md warns about. It cannot be derived — knowing which function emits prospect
// copy is a judgement, not a property of the filesystem. So instead of pretending to derive
// it, this asserts the KNOWN producers still exist where the registry says they do. A
// rename or a move fails here rather than quietly exempting the thing it names.
describe('the registry still points at real code', () => {
  const ROOT = process.cwd()

  it.each([
    ['src/lib/reply-handling/process-reply.ts', 'export function buildBookingReplyBody'],
    ['src/lib/composition/opt-out-footer.ts', 'export const OPT_OUT_FOOTER'],
    ['src/lib/composition/custom-variables.ts', 'export function plainTextToHtml'],
  ])('%s still declares %s', (relPath, declaration) => {
    const contents = readFileSync(join(ROOT, relPath), 'utf8')
    expect(
      contents.includes(declaration),
      `${relPath} no longer declares "${declaration}". If it moved, update the registry in ` +
        `this file; if it was deleted, remove its entry. Do not delete this assertion.`
    ).toBe(true)
  })

  it('the reply send path still bypasses validateEmailContent, which is why this file exists', () => {
    // If this ever goes red it is GOOD NEWS: it means the reply path gained a runtime dash
    // check and this file's urgency drops. Read the change before editing this assertion.
    const replyActions = readFileSync(
      join(ROOT, 'src/lib/integrations/handlers/instantly/reply-actions.ts'), 'utf8')
    expect(replyActions.includes('validateEmailContent')).toBe(false)
  })
})
