// The skip must be VISIBLE and must not read as a search failure.
//
// "Research was skipped because intake did not supply a buyer" and "research returned
// nothing" are different statements about a document and only the first is actionable.
// Three ICP generations reported the second when the first was true, so the operator was
// told the market had no data when the truth was that we never asked.
//
// These tests guard the wording at both surfaces the operator actually reads:
//   suggestion_reason  the approval-queue line
//   the prompt         which decides what the model writes into the document banner

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildResearchPlan, buildResearchBlock } from '../icp-generation-agent'

function row(field_key: string, response_value: string) {
  return { field_key, field_label: field_key, response_value, section: 's', is_critical: true }
}

// Phrasings that assert or imply a search happened. On the skip path every one of these is
// a false statement, and the two marked SHIPPED are the ones that actually reached
// documents.
const IMPLIES_A_SEARCH_RAN = [
  'returned no results',
  'returned nothing',
  'returned limited',           // SHIPPED — the old limitedNote wording
  'no usable research results', // SHIPPED — the old prompt wording
  'search failed',
  'no market data exists',
  'no market data is available',
]

const SKIPPED_PLAN = buildResearchPlan([
  row('clients_clone', 'They were the founder, with two people working for them'),
  row('company_what_you_do', ''),
])

describe('the skip is stated as a skip, at every surface', () => {
  it('the plan actually skips for this intake', () => {
    expect(SKIPPED_PLAN.skipped).toBe(true)
    expect(SKIPPED_PLAN.queries).toEqual([])
  })

  it('suggestion_reason says SKIPPED and never implies a search ran', () => {
    const reason = SKIPPED_PLAN.skipReason
    expect(reason).toMatch(/SKIPPED/)
    for (const phrase of IMPLIES_A_SEARCH_RAN) {
      expect(reason.toLowerCase(), `skipReason implies a search ran: "${phrase}"`)
        .not.toContain(phrase)
    }
  })

  it('suggestion_reason tells the operator what to change', () => {
    // A statement the operator cannot act on is the failure being fixed, so the reason
    // must name the intake answer at fault and what regenerating alone will do.
    const reason = SKIPPED_PLAN.skipReason
    expect(reason).toMatch(/ideal-client answer/i)
    expect(reason).toMatch(/regenerating/i)
  })

  it('the prompt block for the skip never implies a search ran', () => {
    const block = buildResearchBlock('', true)
    expect(block).toContain('CASE 3')
    expect(block).toContain('NO RESEARCH WAS RUN')

    // The block has two halves and only one of them makes claims. Everything before
    // "Follow the" states what happened; everything after instructs the model, and that
    // half QUOTES the forbidden phrasings in order to forbid them. Scanning the whole
    // string finds those quotes and reads them as the very assertion they prohibit.
    const claims = block.slice(0, block.indexOf('Follow the'))
    expect(claims, 'the block lost its instruction half').not.toBe(block)

    for (const phrase of IMPLIES_A_SEARCH_RAN) {
      expect(claims.toLowerCase(), `skip block ASSERTS a search ran: "${phrase}"`)
        .not.toContain(phrase)
    }
  })

  it('the skip block asks for the unresolved_fields entry that renders the banner', () => {
    // unresolved_fields renders above the document on the approval screen. Without this
    // the skip is only in suggestion_reason, which is a different screen.
    expect(buildResearchBlock('', true)).toContain('unresolved_fields')
  })

  it('a search that ran and found nothing is NOT the same block', () => {
    const ranAndFoundNothing = buildResearchBlock('', false)
    expect(ranAndFoundNothing).toContain('CASE 2')
    expect(ranAndFoundNothing).toContain('research ran')
    expect(ranAndFoundNothing).not.toContain('CASE 3')
    // And it must not raise the banner, or the banner stops meaning anything.
    expect(ranAndFoundNothing).toMatch(/Do NOT add an\s+unresolved_fields entry/)
  })

  it('usable findings are CASE 1', () => {
    const block = buildResearchBlock('## WEB RESEARCH\n\n- a finding', true)
    // researchSection wins over the skip flag: if there are findings, research ran.
    expect(block).toContain('CASE 1')
  })
})

describe('the prompt file and the code name the same three cases', () => {
  // CLAUDE.md: when a prompt and the code enforcing it state the same rule, they must
  // agree exactly, and one must not be updated without the other.
  const prompt = readFileSync(
    join(process.cwd(), 'docs', 'prompts', 'icp-agent.md'), 'utf-8')

  it('the prompt documents the three-case distinction', () => {
    expect(prompt).toContain('## When no research was run at all')
    expect(prompt).toMatch(/NO RESEARCH WAS RUN/)
  })

  it('every case label the code emits is defined in the prompt', () => {
    for (const [section, skipped] of [['', true], ['', false], ['x', false]] as const) {
      const label = buildResearchBlock(section, skipped).match(/CASE \d/)?.[0]
      expect(label, 'code emitted a block with no case label').toBeTruthy()
      expect(prompt, `${label} is emitted by the code but not defined in the prompt`)
        .toContain(`${label!.replace('CASE ', '')}. `)
    }
  })

  it('the prompt forbids the phrasings that actually shipped', () => {
    // These are listed as Wrong examples in the prompt. If someone deletes them, the
    // model loses the only statement of what not to write.
    expect(prompt).toContain('Research returned no results.')
    expect(prompt).toContain('No market data is available for this category.')
  })
})
