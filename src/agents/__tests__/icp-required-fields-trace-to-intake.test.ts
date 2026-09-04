import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// ─── Every required ICP field must trace to a question we actually ask ───────
//
// THE DEFECT THIS PINS, measured 2026-09-03. The ICP schema carries a geography field.
// The intake questionnaire has twenty questions and NONE of them asks where a client
// sells. So the agent supplies a value by reasoning, and for three of five organisations
// that value names markets no intake answer mentions. One of those documents named
// markets the sourcing layer refuses to prospect. The same shape covers the buyer's
// revenue and headcount: the intake asks the CLIENT's own revenue and never the buyer's,
// and never asks headcount at all.
//
// None of that is the model misbehaving. The prompt tells it to reason when intake is
// thin, and reasoning is the right instruction. The defect is asking a document to carry
// a field that nothing upstream supplies, and then building a live query on it.
//
// WHAT THIS TEST DOES, and what it deliberately does not. It does not require every gap
// to be closed: closing them means adding intake questions, which is a product decision.
// It requires every gap to be DECLARED. A required field with no entry here fails, a
// declared source that no longer exists in the form fails, and the count of unbacked
// fields may shrink but never grow.

// The question set moved out of IntakeForm.tsx into this module so the server could import
// it too. Reading it here rather than the component keeps this test pointed at the one list
// that now defines what the form asks.
const INTAKE_FORM = 'src/lib/intake/questions.ts'
const SPEC_MODULE = 'src/lib/agents/icp-filter-spec.ts'

/** Every fieldKey the questionnaire actually asks. Read from the form, not from memory. */
function intakeFieldKeys(): Set<string> {
  const src = readFileSync(join(process.cwd(), INTAKE_FORM), 'utf-8')
  return new Set([...src.matchAll(/fieldKey:\s*'([a-z_]+)'/g)].map(m => m[1]))
}

/** Required (non-optional) members of an interface, read from the module source. */
function requiredMembers(interfaceName: string): string[] {
  const src = readFileSync(join(process.cwd(), SPEC_MODULE), 'utf-8')
  const start = src.indexOf(`interface ${interfaceName} {`)
  if (start < 0) return []
  const body = src.slice(start, src.indexOf('\n}', start))
  return [...body.matchAll(/^\s{2}([a-z_]+)(\??):/gm)]
    .filter(m => m[2] !== '?')
    .map(m => m[1])
}

// The declared source of every required buyer-describing field.
//
// A string value names the intake fieldKey that supplies it. UNBACKED means the
// questionnaire asks nothing that supplies it, and the reason is recorded because the
// reason is what a future reader needs in order to close it.
const UNBACKED = 'UNBACKED' as const
const FIELD_SOURCES: Record<string, string[] | typeof UNBACKED> = {
  // Supplied. Both questions describe who the client serves, which is the buyer's sector.
  industries: ['company_what_you_do', 'clients_clone'],

  // NOT supplied. `company_revenue_range` is the CLIENT's own revenue. This field is the
  // BUYER's, and the two are different numbers about different companies. Nothing asks
  // the second one.
  revenue_range: UNBACKED,

  // NOT supplied, by anyone, about anyone. And Rule 9 of the prompt names headcounts
  // among the facts that may never be invented, so the schema requires a field the same
  // prompt forbids inventing and the intake never provides.
  headcount: UNBACKED,

  // NOT supplied. Optional in the TypeScript type and unconditional in the prompt's
  // schema, so the two disagree about whether it is required at all. This is the field
  // the country list would have been derived from.
  geography: UNBACKED,

  // NOT supplied, and the questionnaire steers AWAY from it: the question that describes
  // the best client opens "Not their job title". The buyer criterion, which decides who
  // gets enriched and paid for, is derived from this field.
  title: UNBACKED,

  // NOT supplied.
  seniority: UNBACKED,
}

// Measured 2026-09-03. May shrink, never grow.
const KNOWN_UNBACKED_COUNT = 5

describe('required ICP fields trace to an intake question', () => {
  it('reads a real questionnaire and a real schema', () => {
    expect(intakeFieldKeys().size).toBeGreaterThan(10)
    expect(requiredMembers('IcpCompanyProfile').length).toBeGreaterThan(0)
  })

  it('declares a source for every required company-profile field', () => {
    const undeclared = requiredMembers('IcpCompanyProfile')
      .filter(f => !(f in FIELD_SOURCES))
    expect(
      undeclared,
      'A required ICP field has no declared intake source. Either name the question that ' +
      'supplies it, or mark it UNBACKED so the gap is visible instead of assumed.',
    ).toEqual([])
  })

  it('names only questions the form actually asks', () => {
    const asked = intakeFieldKeys()
    const missing: string[] = []
    for (const [field, source] of Object.entries(FIELD_SOURCES)) {
      if (source === UNBACKED) continue
      for (const key of source) if (!asked.has(key)) missing.push(`${field} -> ${key}`)
    }
    expect(
      missing,
      'A field claims to be supplied by an intake question that no longer exists. The ' +
      'question was renamed or removed and this field silently became unbacked.',
    ).toEqual([])
  })

  it('does not grow the set of required fields nothing asks for', () => {
    const unbacked = Object.entries(FIELD_SOURCES)
      .filter(([, v]) => v === UNBACKED)
      .map(([k]) => k)
      .sort()

    expect(
      unbacked.length,
      `Required ICP fields with no intake question behind them: ${unbacked.join(', ')}. ` +
      'A new one was added. Either add the question, or make the field optional, but do ' +
      'not let a live query be built on a value nothing supplies.',
    ).toBeLessThanOrEqual(KNOWN_UNBACKED_COUNT)
  })
})
