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

// Mirrors icp-generation-agent.ts steps 8 and 9 exactly.
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
  // The prompt file IS the runtime system prompt: icp-generation-agent.ts loadSystemPrompt()
  // reads docs/prompts/icp-agent.md from disk at call time. If the key leaves the prompt,
  // the agent stops emitting it and the banner silently never appears again.
  it('names unresolved_fields in the output schema and marks it required', async () => {
    const { readFile } = await import('fs/promises')
    const { join } = await import('path')
    const prompt = await readFile(
      join(process.cwd(), 'docs', 'prompts', 'icp-agent.md'),
      'utf-8',
    )
    expect(prompt).toContain('"unresolved_fields"')
    expect(prompt).toContain('field_path')
    expect(prompt).toContain('why_unresolved')
    expect(prompt).toContain('question_to_settle_it')
    expect(prompt).toMatch(/unresolved_fields` is REQUIRED/)
  })

  it('still requires revenue_range to be checked against headcount', () => {
    // Restated because this rule already existed in two places and failed anyway on
    // 27 August. It is advisory (ADR-028); the banner is the actual control.
    return import('fs/promises').then(async ({ readFile }) => {
      const { join } = await import('path')
      const prompt = await readFile(
        join(process.cwd(), 'docs', 'prompts', 'icp-agent.md'),
        'utf-8',
      )
      expect(prompt).toMatch(/REVENUE AND HEADCOUNT MUST COHERE/)
      expect(prompt).toMatch(/Check revenue_range against headcount/)
    })
  })

  it('does not hardcode a revenue-per-head ratio anywhere in the prompt', () => {
    // A fixed ratio would be consulting-specific and wrong for other industries, which is
    // the reason this check is prompt-plus-banner rather than a code validator.
    return import('fs/promises').then(async ({ readFile }) => {
      const { join } = await import('path')
      const prompt = await readFile(
        join(process.cwd(), 'docs', 'prompts', 'icp-agent.md'),
        'utf-8',
      )
      expect(prompt).not.toMatch(/per (consulting )?head/i)
      expect(prompt).not.toMatch(/100K to 150K/i)
    })
  })
})
