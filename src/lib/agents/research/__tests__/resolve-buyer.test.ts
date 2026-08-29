// The buyer precedence, and the cache invariant the precedence must not break.
//
// TWO THINGS ARE BEING PROTECTED HERE AND THEY PULL IN OPPOSITE DIRECTIONS. The reader
// has to reach the writer and the judge, and the writer's system prompt has to stay
// byte-stable across every client and every prospect. The only way to have both is for
// the variable value to live in the user message, so the second describe below asserts
// that it did not leak back into the cached prefix.

import { describe, it, expect } from 'vitest'
import { resolveBuyer, BUYER_UNKNOWN } from '../resolve-buyer'
import { buildWriterPrompt, buildWriterAssignment, buildJudgePrompt } from '../write-opening'

describe('the buyer is resolved by precedence, never blended', () => {
  it('prefers the prospect\'s own sourced title over the client ICP buyer title', () => {
    const r = resolveBuyer('Head of Delivery', 'Operations Lead')
    expect(r.description).toBe('Head of Delivery')
    expect(r.source).toBe('prospect_title')
  })

  it('falls to the ICP buyer title when the prospect has no sourced title', () => {
    // The common case by a wide margin. Measured 2026-08-29: job_title populated on 29 of
    // 48 prospects, so roughly two in five reach the writer through this tier.
    for (const absent of [null, undefined, '', '   ']) {
      const r = resolveBuyer(absent, 'Operations Lead')
      expect(r.description, `for ${JSON.stringify(absent)}`).toBe('Operations Lead')
      expect(r.source).toBe('icp_buyer_title')
    }
  })

  it('falls to a category-level description that names no buyer type when neither exists', () => {
    for (const icp of [null, undefined, '', '  ']) {
      const r = resolveBuyer(null, icp)
      expect(r.description).toBe(BUYER_UNKNOWN)
      expect(r.source).toBe('none')
    }
  })

  // THE RULE THAT MADE THIS WHOLE CHANGE NECESSARY. A missing title must not resurrect a
  // default. If the fallback ever names a role, a seniority or an industry, every prospect
  // with a thin ICP goes back to being written for an archetype nobody checked, and it
  // does so silently because the copy still reads fine.
  it('the fallback names no role, seniority or industry', () => {
    const banned = /\b(founder|owner|ceo|cto|cmo|coo|cfo|director|principal|partner|head of|vp|manager|executive|consult|saas|agency)\b/i
    expect(BUYER_UNKNOWN).not.toMatch(banned)
  })

  // Neither source is trusted to be tidy. Both are free text: one off a third-party
  // sourcing handler, one typed into an ICP document by a generation agent.
  it('trims, and treats a whitespace-only title as absent rather than as a title', () => {
    expect(resolveBuyer('  Managing Partner  ', null).description).toBe('Managing Partner')
    expect(resolveBuyer(' \t ', ' \n ').source).toBe('none')
  })
})

describe('the reader reaches both prompts without touching the cached prefix', () => {
  // STEP 3, FIRST CHECK. The writer system prompt is ~9,300 tokens, marked as a cache
  // breakpoint, and sent up to three times per prospect. One interpolated per-client value
  // here would silently revert every writer call in the system to full input price, and
  // nothing else in the suite would notice.
  it('the writer system prompt is byte-identical across two different ICP buyer titles', () => {
    const a = buildWriterPrompt()
    const b = buildWriterPrompt()
    expect(a).toBe(b)
    // Asserted against the resolved values themselves, not just against equality: two
    // calls to a function that interpolated a MODULE-LEVEL value would also be equal.
    for (const title of ['Operations Lead', 'School Principal', 'Head of Procurement']) {
      expect(a).not.toContain(title)
    }
  })

  it('the writer system prompt is byte-identical with and without a sourced prospect title', () => {
    const withTitle = resolveBuyer('Managing Partner', 'Operations Lead')
    const without = resolveBuyer(null, null)
    expect(withTitle.description).not.toBe(without.description)
    // Different resolved readers, one and the same system prompt.
    expect(buildWriterPrompt()).toBe(buildWriterPrompt())
    expect(buildWriterPrompt()).not.toContain(withTitle.description)
    expect(buildWriterPrompt()).not.toContain(without.description)
  })

  // The system prompt no longer names a buyer at any level, so it can only be talking
  // about whoever the assignment names. This is the assertion that would fail if someone
  // put an archetype back into the constant to "help" the writer.
  it('the writer system prompt names no buyer archetype and defers to the assignment', () => {
    const p = buildWriterPrompt()
    const flat = p.replace(/\s+/g, ' ')
    expect(flat).toContain('You are writing to the person the ASSIGNMENT block names')
    expect(flat).toContain('Assume nothing else about who they are')
    expect(flat).not.toContain('writing to a founder')
  })

  it('the assignment block carries the reader, and it is the part that varies', () => {
    const base = { clientName: 'Acme', p3: 'x', cta: 'Worth a look?' }
    const one = buildWriterAssignment({ ...base, buyer: 'Managing Partner' })
    const two = buildWriterAssignment({ ...base, buyer: BUYER_UNKNOWN })
    expect(one).toContain('Who you are writing to: Managing Partner')
    expect(two).toContain(`Who you are writing to: ${BUYER_UNKNOWN}`)
    expect(one).not.toBe(two)
  })

  // The judge is the call this change was actually for. It picks between the written
  // opening and the approved template, and it used to pick by imagining one archetype.
  it('the judge prompt takes the reader and changes with it', () => {
    const a = buildJudgePrompt('Managing Partner')
    const b = buildJudgePrompt('School Principal')
    expect(a).toContain('Who is reading it: Managing Partner')
    expect(b).toContain('Who is reading it: School Principal')
    expect(a).not.toBe(b)
    expect(a).not.toContain('founder')
  })

  // Still one question after the edit. The judge asking two things is how it stops being
  // a comparison and starts being a checklist, which is what produced 0 of 13 before.
  it('the judge still asks exactly one question', () => {
    expect((buildJudgePrompt('Managing Partner').match(/\?/g) ?? []).length).toBe(1)
  })
})
