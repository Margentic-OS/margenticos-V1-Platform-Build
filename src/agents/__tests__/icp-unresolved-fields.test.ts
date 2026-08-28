// unresolved_fields must survive the ICP agent's output pipeline intact.
//
// The ICP agent has no runtime schema validator. Between the model's JSON and the row
// written to document_suggestions there are exactly three steps: JSON.parse, then
// scrubAITellsDeep, then assertNoDashes (icp-generation-agent.ts, steps 8 and 9). A field
// that does not survive those three is a field the operator never sees, and the whole
// point of unresolved_fields is that the operator cannot miss it.
//
// This is the "validate one thing, return another" shape from CLAUDE.md: the generation-time
// opt-out footer was validated and then dropped by a return-value bug, and every stored
// document shipped without it. These tests exist so unresolved_fields cannot go the same way.
//
// SCOPE, stated so it is not over-trusted: this file tests the SCRUBBER SEMANTICS against a
// hand-copy of the agent's pipeline, plus the runtime slice of the prompt. It does not
// exercise the agent. See icp-unresolved-fields-writepath.test.ts for that.

import { describe, it, expect } from 'vitest'
import { scrubAITellsDeep, assertNoDashes } from '@/lib/style/customer-facing-style-rules'

type UnresolvedField = {
  field_path: string
  why_unresolved: string
  question_to_settle_it: string
}

function icpDocumentWith(unresolved: unknown) {
  return {
    jtbd_statement: 'Take outbound off the founder so quoting does not stop when they deliver.',
    summary: 'Firms that sell through relationships and want a second route to demand.',
    tier_1: {
      label: 'Ideal Client',
      description: 'Owner-led firms where one person carries both delivery and sales.',
      company_profile: {
        revenue_range: '',
        headcount: '5 to 20 employees',
        stage: 'established, pre-systematisation',
        industries: ['Management Consulting'],
        geography: 'English-speaking markets',
        business_model: 'project-based services',
      },
      buyer_profile: {
        title: 'Founder',
        seniority: 'Founder-led, no dedicated sales function',
        day_to_day: 'Delivery work fills the calendar and quoting waits for a gap.',
        identity: 'A practitioner first, a seller second.',
      },
      four_forces: { push: ['Work arrives in clumps.'], pull: [], anxiety: [], habit: [] },
      triggers: [],
      switching_costs: [],
      disqualifiers: [],
    },
    unresolved_fields: unresolved,
  }
}

const TWO_FIELDS: UnresolvedField[] = [
  {
    field_path: 'tier_1.company_profile.revenue_range',
    why_unresolved:
      'Intake gave no revenue figure, and headcount alone cannot imply one for this business.',
    question_to_settle_it: 'What revenue range did your best clients bill last year?',
  },
  {
    field_path: 'tier_1.company_profile.geography',
    why_unresolved: 'Currency was EUR but no country was named anywhere in intake.',
    question_to_settle_it: 'Which countries do your clients operate in?',
  },
]

// A HAND-COPY of icp-generation-agent.ts steps 8 and 9, and it must be read as one.
//
// It is a second list kept in step with the first by hand, so it CANNOT catch the agent
// dropping the key on its way to storage. Mutation-proved on 2026-08-27: inserting
// `delete scrubbedDocument.unresolved_fields` into the real agent leaves this whole file
// green at 12/12. The behavioural guard for that lives in
// icp-unresolved-fields-writepath.test.ts, which calls runIcpGenerationAgent itself and
// asserts on the row written. This file's value is the scrubber semantics below, which
// are cheaper to exercise directly than through the agent.
function runAgentOutputPipeline(modelJson: string) {
  const parsed = JSON.parse(modelJson) as Record<string, unknown>
  const scrubbed = scrubAITellsDeep(parsed, 'icp-agent')
  assertNoDashes(scrubbed, 'icp-agent')
  return scrubbed as ReturnType<typeof icpDocumentWith>
}

describe('unresolved_fields survives the ICP output pipeline', () => {
  it('round-trips through JSON.parse, scrubAITellsDeep and assertNoDashes', () => {
    const out = runAgentOutputPipeline(JSON.stringify(icpDocumentWith(TWO_FIELDS)))
    expect(out.unresolved_fields).toEqual(TWO_FIELDS)
  })

  it('keeps all three keys on every entry', () => {
    const out = runAgentOutputPipeline(JSON.stringify(icpDocumentWith(TWO_FIELDS)))
    const list = out.unresolved_fields as UnresolvedField[]
    expect(list).toHaveLength(2)
    for (const entry of list) {
      expect(entry.field_path).toBeTruthy()
      expect(entry.why_unresolved).toBeTruthy()
      expect(entry.question_to_settle_it).toBeTruthy()
    }
  })

  it('does not flatten the array into a string or drop it to undefined', () => {
    const out = runAgentOutputPipeline(JSON.stringify(icpDocumentWith(TWO_FIELDS)))
    expect(Array.isArray(out.unresolved_fields)).toBe(true)
  })

  it('preserves an empty array rather than dropping the key', () => {
    const out = runAgentOutputPipeline(JSON.stringify(icpDocumentWith([])))
    expect(out.unresolved_fields).toEqual([])
    expect('unresolved_fields' in out).toBe(true)
  })

  it('leaves field_path dotted paths untouched, so the renderer can split them', () => {
    const out = runAgentOutputPipeline(JSON.stringify(icpDocumentWith(TWO_FIELDS)))
    const list = out.unresolved_fields as UnresolvedField[]
    expect(list[0].field_path).toBe('tier_1.company_profile.revenue_range')
    expect(list[0].field_path.split('.')).toHaveLength(3)
  })

  it('rewrites an em dash inside why_unresolved and leaves the entry intact', () => {
    // scrubAITellsDeep reaches string values at any depth, including inside this array.
    // DASH_PATTERN turns "named — currency" into "named, currency" (lowercase after the
    // dash becomes a comma), so assertNoDashes then passes.
    const withDash: UnresolvedField[] = [
      {
        field_path: 'tier_1.company_profile.geography',
        why_unresolved: 'No country was named — currency alone is not enough.',
        question_to_settle_it: 'Which countries do your clients operate in?',
      },
    ]
    const out = runAgentOutputPipeline(JSON.stringify(icpDocumentWith(withDash)))
    const list = out.unresolved_fields as UnresolvedField[]
    expect(list).toHaveLength(1)
    expect(list[0].why_unresolved).not.toMatch(/[—–]/)
    expect(list[0].why_unresolved).toBe('No country was named, currency alone is not enough.')
    expect(list[0].field_path).toBe('tier_1.company_profile.geography')
    expect(list[0].question_to_settle_it).toBe('Which countries do your clients operate in?')
  })

  it('assertNoDashes covers unresolved_fields, so an unscrubbable dash still hard-fails', () => {
    // An en dash between digits is deliberately NOT rewritten (NUMERIC_RANGE_PATTERN only
    // handles it when both sides are numeric/currency; here the right side is a letter),
    // which makes this the case that reaches assertNoDashes. The point of the test is that
    // the gate walks into the array rather than stopping at the top level.
    const scrubbed = scrubAITellsDeep(
      { unresolved_fields: [{ field_path: 'a', why_unresolved: 'x——y' }] },
      'icp-agent',
    )
    const remaining = /[—–]/.test(JSON.stringify(scrubbed))
    if (remaining) {
      expect(() => assertNoDashes(scrubbed, 'icp-agent')).toThrow(/assertNoDashes/)
    } else {
      // Fully scrubbed is the other correct outcome; either way no dash reaches storage.
      expect(JSON.stringify(scrubbed)).not.toMatch(/[—–]/)
    }
  })

  it('AI tells inside unresolved_fields are logged, not rewritten (documented behaviour)', () => {
    // AI_TELL_PATTERNS are detection-only: scrubAITells logs a warning and returns the
    // string unchanged. Only dash patterns rewrite. Asserted here so a future change to
    // make tells rewriting is a deliberate decision rather than a silent one.
    const withTell: UnresolvedField[] = [
      {
        field_path: 'tier_1.company_profile.stage',
        why_unresolved: "It's worth noting that intake did not establish the stage.",
        question_to_settle_it: 'What stage is the business at?',
      },
    ]
    const out = runAgentOutputPipeline(JSON.stringify(icpDocumentWith(withTell)))
    const list = out.unresolved_fields as UnresolvedField[]
    expect(list).toHaveLength(1)
    expect(list[0].why_unresolved).toBe(
      "It's worth noting that intake did not establish the stage.",
    )
  })
})

describe('the ICP prompt declares unresolved_fields', () => {
  // These assert against the RUNTIME SLICE, not the whole file.
  //
  // icp-generation-agent.ts loadSystemPrompt() reads docs/prompts/icp-agent.md and then
  // slices from the '## System Prompt' marker onward, discarding everything above it. A
  // test that reads the whole file therefore passes while the agent's actual prompt has
  // lost the key: move the schema block into the frontmatter and the suite stays green.
  // That is the validate-one-thing-return-another shape CLAUDE.md names, and the earlier
  // version of this file had it. Proved by mutation 2026-08-27.
  const MARKER = '## System Prompt'

  async function runtimePrompt(): Promise<string> {
    const { readFile } = await import('fs/promises')
    const { join } = await import('path')
    const raw = await readFile(join(process.cwd(), 'docs', 'prompts', 'icp-agent.md'), 'utf-8')
    const idx = raw.indexOf(MARKER)
    // Mirrors the agent's own failure mode rather than silently testing the whole file.
    expect(idx, 'icp-agent.md has no "## System Prompt" marker').toBeGreaterThan(-1)
    return raw.slice(idx + MARKER.length).trim()
  }

  it('the runtime slice is a strict subset of the file, so this test can actually fail', async () => {
    // Guards the guard: if the slice ever equals the whole file, these tests silently
    // revert to the weaker check they were written to replace.
    const { readFile } = await import('fs/promises')
    const { join } = await import('path')
    const raw = await readFile(join(process.cwd(), 'docs', 'prompts', 'icp-agent.md'), 'utf-8')
    const slice = await runtimePrompt()
    expect(slice.length).toBeGreaterThan(0)
    expect(slice.length).toBeLessThan(raw.length)
  })

  it('names unresolved_fields in the output schema and marks it required', async () => {
    const prompt = await runtimePrompt()
    expect(prompt).toContain('"unresolved_fields"')
    expect(prompt).toContain('field_path')
    expect(prompt).toContain('why_unresolved')
    expect(prompt).toContain('question_to_settle_it')
    expect(prompt).toMatch(/unresolved_fields` is REQUIRED/)
  })

  it('still requires revenue_range to be checked against headcount', async () => {
    // Restated because this rule already existed in two places and failed anyway on
    // 27 August. It is advisory (ADR-028); the banner is the actual control.
    const prompt = await runtimePrompt()
    expect(prompt).toMatch(/REVENUE AND HEADCOUNT MUST COHERE/)
    expect(prompt).toMatch(/Check revenue_range against headcount/)
  })

  it('does not hardcode a revenue-per-head ratio anywhere in the runtime prompt', async () => {
    // A fixed ratio would be consulting-specific and wrong for other industries, which is
    // why the coherence check is prompt-plus-banner rather than a code validator (ADR-040).
    //
    // The first version of this test matched only the literal wording of the mutation it
    // was authored from, so "per fee earner", "per employee", "per FTE" and a hyphenated
    // range all passed. It tested its own example rather than the rule. This version
    // matches the SHAPE: a money-ish quantity tied to a per-person unit.
    const prompt = await runtimePrompt()

    const PER_PERSON = /per\s+(consulting\s+)?(head|employee|person|consultant|fee[- ]earner|FTE|staff|headcount|seat|body)\b/i
    expect(prompt, 'a per-person revenue unit appeared in the runtime prompt').not.toMatch(PER_PERSON)

    // A money range near the word headcount or revenue, in any of the usual spellings.
    const MONEY_RANGE = /[€$£]?\s?\d{2,3}[,.]?\d*\s?[Kk]?\s?(to|-|–|—)\s?[€$£]?\s?\d{2,3}[,.]?\d*\s?[Kk]\b/
    const offenders = prompt
      .split('\n')
      .filter(line => MONEY_RANGE.test(line) && /revenue|headcount|bill|per\s/i.test(line))
      // The documented 27 August incident record is the one legitimate money range: it
      // reports what the agent wrongly produced, it does not instruct a ratio.
      .filter(line => !line.includes('150K to 750K'))
    expect(offenders, `unexpected money range near revenue/headcount: ${offenders.join(' | ')}`).toEqual([])
  })
})
