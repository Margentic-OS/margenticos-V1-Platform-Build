import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { CANONICAL_INDUSTRIES } from '@/lib/agents/icp-filter-spec'
import { CLASSIFIABLE_INDUSTRIES } from '@/lib/sourcing/industry-mapping'

// ─── Every list of industry names must derive from the one canonical list ────
//
// WHY THIS IS A TEST AND NOT A RULE. The industry-agnostic principle has been written
// down in CLAUDE.md since April, and it was written down after the same class of defect
// was found in all four agent prompts. Five months later this codebase still had a
// 15-name mapping table naming one market and a 17-name copy of the taxonomy in a
// component. A rule needs somebody to remember it at the moment they are typing a list.
// A test does not.
//
// NOTE WHAT EACH ASSERTION CATCHES, because "is a subset" alone is the weaker half. A
// list that claims to cover the whole taxonomy must also fail when a canonical name goes
// MISSING from it, otherwise deleting entries passes.
//
// Every test here guards itself against passing vacuously. An empty scan and a clean
// scan look identical, which is the shape that made the original audit query return zero
// rows for months while the class it was written to find sat in front of it.

const CANON = new Set<string>(CANONICAL_INDUSTRIES)

describe('industry lists derive from the canonical list', () => {
  it('has a canonical list to compare against at all', () => {
    expect(CANONICAL_INDUSTRIES.length).toBeGreaterThan(50)
    expect(new Set(CANONICAL_INDUSTRIES).size).toBe(CANONICAL_INDUSTRIES.length)
  })

  // CLASSIFIABLE_INDUSTRIES is the union of the derived identity map and the hand-written
  // alias table's RANGE. Set equality therefore fails in BOTH directions that matter:
  // an alias pointing at a name that is not canonical makes it too big, and a canonical
  // name that stops being classifiable makes it too small.
  it('the classifier can produce exactly the canonical names, no more and no fewer', () => {
    const classifiable = [...CLASSIFIABLE_INDUSTRIES].sort()
    const canonical = [...CANONICAL_INDUSTRIES].sort()

    const notCanonical = classifiable.filter(n => !CANON.has(n))
    expect(
      notCanonical,
      'A tag alias maps to a name that is not in the canonical list. Its value can never ' +
      'match a client specification, so every prospect carrying that tag is removed.',
    ).toEqual([])

    expect(
      classifiable,
      'A canonical industry is no longer classifiable. A client naming it can source ' +
      'prospects and then lose every one of them at classification.',
    ).toEqual(canonical)
  })

  it('the handler targets only canonical names', async () => {
    const { APOLLO_TARGETED_INDUSTRIES } = await import('@/lib/sourcing/handlers/adapter-apollo')
    expect(APOLLO_TARGETED_INDUSTRIES.length).toBeGreaterThan(0)

    const notCanonical = APOLLO_TARGETED_INDUSTRIES.filter(n => !CANON.has(n as string))
    expect(
      notCanonical,
      'The handler advertises an industry the taxonomy does not contain, so the ' +
      'orchestrator gate compares specification names against a name no spec can hold.',
    ).toEqual([])
  })

  // The agent prompt carries its OWN copy of the taxonomy, between marker comments, and
  // the model reads that copy rather than the TypeScript one. Two hand-maintained copies
  // of one list is the parallel-array shape at file scope: they were verified identical
  // by hand on 2026-09-03 and nothing was stopping them diverging the next day. A name
  // added to the code and not the prompt can never be produced; a name added to the
  // prompt and not the code is written into a document and then REFUSED by
  // validateCanonicalIndustry, which stores a NULL spec and stops that client sourcing.
  it('the agent prompt lists exactly the canonical names', () => {
    const raw = readFileSync(join(process.cwd(), 'docs/prompts/icp-agent.md'), 'utf-8')
    const begin = raw.indexOf('CANONICAL-INDUSTRY-LIST:BEGIN')
    const end = raw.indexOf('CANONICAL-INDUSTRY-LIST:END')
    expect(begin, 'the prompt has no canonical-industry list markers').toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(begin)

    const inPrompt = raw
      .slice(raw.indexOf('\n', begin), end)
      .split(/[|\n]/)
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('<!--'))
      .sort()

    // Guards itself: a parse that finds nothing must fail rather than pass vacuously.
    expect(inPrompt.length).toBeGreaterThan(50)
    expect(inPrompt).toEqual([...CANONICAL_INDUSTRIES].sort())
  })

  // The operator's mapping dropdown held its own 17-name list, which GATED what a tag
  // could be mapped to and contained one entry that was not a canonical name at all.
  // It takes the list as a prop now. This fails if a literal list comes back.
  it('the operator mapping component holds no list of industry names', () => {
    const src = readFileSync(
      join(process.cwd(),
        'src/app/dashboard/operator/sourcing-review/components/FlaggedIndustryTagsSection.tsx'),
      'utf-8')

    expect(src.length).toBeGreaterThan(0)
    const canonicalLiterals = CANONICAL_INDUSTRIES.filter(
      name => src.includes(`'${name}'`) || src.includes(`"${name}"`),
    )
    expect(
      canonicalLiterals,
      'This component names industries again. It must take them as a prop, or the ' +
      'taxonomy has a second copy that gates what an operator is allowed to choose.',
    ).toEqual([])
  })
})
