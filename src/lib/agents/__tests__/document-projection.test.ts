// The projection, and the drift guard that keeps it honest.
//
// The projection itself is easy to test. The part that matters is the LAST describe block,
// which checks the allowlist against the WORLD rather than against itself: it parses the
// ICP output schema out of the runtime slice of docs/prompts/icp-agent.md and fails if the
// schema declares a top-level key that has been classified in neither list.
//
// Without that, an allowlist is just another second list kept in step by hand. Add a key to
// the schema, forget this file, and the key is silently invisible to every downstream agent
// with nothing to say so. That is the monitor-sweep shape from CLAUDE.md: a check that runs,
// reports success, and never reaches the thing it was meant to protect.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  projectIcpForDownstream,
  ICP_DOWNSTREAM_KEYS,
  ICP_OPERATOR_ONLY_KEYS,
} from '../document-projection'

const FULL_ICP = {
  jtbd_statement: 'Take outbound off the founder.',
  summary: 'Firms that sell through relationships.',
  tier_1: { label: 'Ideal Client', four_forces: { push: ['Work arrives in clumps.'] } },
  tier_2: { label: 'Good Client' },
  tier_3: { label: 'Do Not Target' },
  unresolved_fields: [
    {
      kind: 'unverified_claim',
      field_path: 'tier_1.company_profile.industries',
      claim: 'A public body sets the terms this buyer operates under.',
      why_unresolved: 'Stated from general knowledge, not supplied in this message.',
      question_to_settle_it: 'Is that accurate for your market?',
    },
  ],
  assumptions_we_have_made: ['We assumed something the operator should confirm.'],
}

describe('projectIcpForDownstream', () => {
  it('keeps every downstream key', () => {
    const out = projectIcpForDownstream(FULL_ICP)
    for (const key of ICP_DOWNSTREAM_KEYS) expect(out[key]).toBeDefined()
  })

  it('strips every operator-only key', () => {
    const out = projectIcpForDownstream(FULL_ICP)
    for (const key of ICP_OPERATOR_ONLY_KEYS) expect(key in out).toBe(false)
  })

  it('strips a key that is in NEITHER list, because the allowlist fails closed', () => {
    // The whole reason this is an allowlist. A future operator-facing key is invisible
    // downstream by default rather than leaking until someone remembers to deny it.
    const out = projectIcpForDownstream({ ...FULL_ICP, some_future_operator_key: 'secret' })
    expect('some_future_operator_key' in out).toBe(false)
  })

  it('returns exactly the allowlist and nothing else', () => {
    expect(Object.keys(projectIcpForDownstream(FULL_ICP)).sort())
      .toEqual([...ICP_DOWNSTREAM_KEYS].sort())
  })

  it('does not mutate the input', () => {
    const input = structuredClone(FULL_ICP)
    projectIcpForDownstream(input)
    expect(input.unresolved_fields).toBeDefined()
    expect(input.assumptions_we_have_made).toBeDefined()
  })

  it('omits an allowlisted key that is absent rather than inventing undefined', () => {
    const out = projectIcpForDownstream({ summary: 'only this' })
    expect(Object.keys(out)).toEqual(['summary'])
  })

  it('degrades to {} on malformed input rather than throwing', () => {
    // A bad upstream row should thin the prompt, not fail the run.
    for (const bad of [null, undefined, 'a string', 42, [1, 2, 3]]) {
      expect(projectIcpForDownstream(bad)).toEqual({})
    }
  })

  it('the two lists do not overlap', () => {
    const overlap = (ICP_DOWNSTREAM_KEYS as readonly string[])
      .filter(k => (ICP_OPERATOR_ONLY_KEYS as readonly string[]).includes(k))
    expect(overlap).toEqual([])
  })
})

// ─── Drift guard: the allowlist checked against the schema, not against itself ────────

describe('the allowlist covers the ICP output schema', () => {
  const MARKER = '## System Prompt'

  function runtimeSchemaKeys(): string[] {
    const raw = readFileSync(join(process.cwd(), 'docs', 'prompts', 'icp-agent.md'), 'utf-8')
    const idx = raw.indexOf(MARKER)
    expect(idx, 'icp-agent.md has no "## System Prompt" marker').toBeGreaterThan(-1)
    const runtime = raw.slice(idx + MARKER.length)

    // The schema is the fenced block under "## Output format". Take the first fence after
    // that heading so a later fenced example cannot be mistaken for the schema.
    const outputIdx = runtime.indexOf('## Output format')
    expect(outputIdx, 'icp-agent.md has no "## Output format" section').toBeGreaterThan(-1)
    const fence = runtime.slice(outputIdx).match(/```\n([\s\S]*?)```/)
    expect(fence, 'no fenced schema block under Output format').toBeTruthy()

    // Top-level keys are the ones indented exactly two spaces inside the outer braces.
    return [...fence![1].matchAll(/^ {2}"([a-z0-9_]+)"\s*:/gim)].map(m => m[1])
  }

  it('found schema keys at all, so the checks below cannot pass vacuously', () => {
    const keys = runtimeSchemaKeys()
    expect(keys.length).toBeGreaterThanOrEqual(5)
  })

  it('every top-level schema key is classified as downstream or operator-only', () => {
    // THE GUARD. Add a key to the ICP schema and forget this file, and this fails rather
    // than the key silently vanishing from every downstream prompt.
    const known = new Set<string>([...ICP_DOWNSTREAM_KEYS, ...ICP_OPERATOR_ONLY_KEYS])
    const unclassified = runtimeSchemaKeys().filter(k => !known.has(k))
    expect(
      unclassified,
      `unclassified ICP schema keys: ${unclassified.join(', ')}. Add each to ` +
      'ICP_DOWNSTREAM_KEYS or ICP_OPERATOR_ONLY_KEYS in src/lib/agents/document-projection.ts.',
    ).toEqual([])
  })

  it('unresolved_fields is in the schema and is classified operator-only', () => {
    // Directional: catches both the key leaving the schema and it being reclassified as
    // downstream, which would put flagged claims back into copy.
    expect(runtimeSchemaKeys()).toContain('unresolved_fields')
    expect(ICP_OPERATOR_ONLY_KEYS as readonly string[]).toContain('unresolved_fields')
    expect(ICP_DOWNSTREAM_KEYS as readonly string[]).not.toContain('unresolved_fields')
  })
})

// ─── The call sites actually use it ──────────────────────────────────────────────────

describe('the agents that embed an ICP use the projection', () => {
  // Source-scan, and it says what it proves: that each agent imports and calls the
  // projection. The behavioural proof that a flagged claim cannot reach the messaging
  // prompt is the round-trip in the projection tests above. This guards the wiring.
  const AGENTS = ['messaging-generation-agent.ts', 'positioning-generation-agent.ts']

  it.each(AGENTS)('%s imports projectIcpForDownstream', file => {
    const src = readFileSync(join(process.cwd(), 'src/agents', file), 'utf8')
    expect(src).toContain("from '@/lib/agents/document-projection'")
  })

  it.each(AGENTS)('%s calls it, not merely imports it', file => {
    // The first version of this matched /projectIcpForDownstream[,)\s]/, which the IMPORT
    // LINE satisfies. Deleting the actual call left it green: a check that passes in both
    // the correct and the broken world. Mutation-found 2026-08-28. Now it counts
    // occurrences outside the import.
    const src = readFileSync(join(process.cwd(), 'src/agents', file), 'utf8')
    const nonImport = src
      .split('\n')
      .filter(l => !l.trimStart().startsWith('import '))
      .join('\n')
    const uses = [...nonImport.matchAll(/projectIcpForDownstream/g)].length
    expect(uses, `${file} imports the projection but never calls it`).toBeGreaterThan(0)
  })

  it('formatDoc requires an explicit projection decision at every call site', () => {
    // The real guard is the TYPE, not this test. `project` is a required parameter, so
    // omitting it at a call site is a compile error rather than a silent leak. This test
    // stops someone relaxing it back to optional and reopening the hole.
    const src = readFileSync(
      join(process.cwd(), 'src/agents/messaging-generation-agent.ts'), 'utf8',
    )
    expect(src, 'formatDoc project parameter was made optional again').not.toMatch(
      /project\?:\s*\(\(?content/,
    )
    expect(src).toMatch(/project:\s*\(\(content: unknown\) => Record<string, unknown>\) \| null/)
  })

  it('neither agent still stringifies a raw ICP document', () => {
    // The exact shape that leaked: JSON.stringify(<something>.content) with no projection.
    for (const file of AGENTS) {
      const src = readFileSync(join(process.cwd(), 'src/agents', file), 'utf8')
      expect(
        src,
        `${file} still stringifies icpDocument.content directly`,
      ).not.toMatch(/JSON\.stringify\(\s*icpDocument\.content/)
    }
  })
})
