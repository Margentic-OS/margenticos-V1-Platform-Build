// THE INVERTED CHECK ON PROMPT EXAMPLES. Added 2026-08-29.
//
// ─── WHY THE EXISTING SCAN CANNOT DO THIS ────────────────────────────────────
//
// prompt-forbidden-content.test.ts reads 0 on buildWriterPrompt. Roughly a dozen real
// company, person and organisation names sit in that file's worked examples. Both facts
// are true at once, and the scan is not broken: a DENY LIST CANNOT HOLD A REAL NAME
// without publishing it in a public repository, and it could never be complete anyway.
// Its own data file says so. So a green scan there means "no banned sector words", not
// "no client-specific content", and reading it as the second thing is the mistake.
//
// This check inverts it. Every capitalised token inside a prompt EXAMPLE must be
// something a prompt example is allowed to contain: ordinary English, a deliberate
// neutral placeholder, a benign acronym, canonical industry vocabulary, or one of a
// short list of argued exceptions. ANYTHING ELSE IS A NAME BY DEFAULT AND FAILS. A
// company invented tomorrow is caught without this file ever learning it exists.
//
// ─── WHY THIS IS THE HIGHEST-RISK CATEGORY ───────────────────────────────────
//
// write-opening.ts has eight recorded instances of an example being lifted verbatim into
// a prospect's email. A real company inside an example is therefore not a tidiness
// problem. It is the single thing most likely to be copied.
//
// ─── WHAT IT DOES NOT SEE, STATED RATHER THAN DISCOVERED LATER ───────────────
//
//   1. ONLY QUOTED TEXT. A name in ordinary prose outside quotes is invisible here. See
//      exampleSpans in prompt-scan.ts for why that is deliberate.
//   2. A NAME THAT IS ALSO AN ORDINARY WORD passes. A company called "Bridge" would not
//      be seen. This is the same trade-off ordinary-words.ts already documents and
//      accepts, and it is the price of an inverted check that does not need a name list.
//   3. IT DOES NOT PROVE A NAME IS SAFE. It proves a token is on a list of things that
//      are not names. Those are different claims.

import { describe, it, expect } from 'vitest'
import { PROMPT_SOURCES, readSource } from './prompt-sources'
import { exampleSpans } from './prompt-scan'
import { ALLOWLIST, MAX_ALLOWLIST_ENTRIES } from './prompt-name-allowlist.data'
import { scanNames, isAllowedToken, type NameHit } from './prompt-name-scan'

const report = (v: NameHit[]) =>
  v.map(x => `  ${x.source}:${x.line} «${x.token}» in "${x.quote}"`).join('\n')

// ─── The measurement ──────────────────────────────────────────────────────────
//
// MEASURED 2026-08-29 on 73c0081, before any swap. 49 unvouched tokens, 30 distinct, and
// EVERY ONE IS A REAL ENTITY NAME: zero false positives against a 133-entry allowlist. Every figure below is a count of
// capitalised tokens inside quoted example spans that nothing vouches for. It is NOT a
// count of distinct companies: "Hollywood Food Coalition" is three tokens and one
// organisation, which is the correct behaviour for a token-level gate and the reason
// these numbers look larger than the inventory.
//
// THE NUMBER MAY ONLY GO DOWN.
const BASELINE_TOTAL_AT_INTRODUCTION = 49
const BASELINE_TOTAL = 49

const BASELINE_BY_SOURCE: Record<string, number> = {
  'docs/prompts/icp-agent.md': 0,
  'docs/prompts/positioning-agent.md': 2,
  'docs/prompts/tov-agent.md': 0,
  'docs/prompts/messaging-agent.md': 2,
  'docs/prompts/faq-extraction-agent.md': 3,
  'docs/prompts/reply-draft-agent.md': 1,
  'src/lib/agents/research/write-opening.ts:buildWriterPrompt': 33,
  'src/lib/agents/research/write-opening.ts:buildFloorPrompt': 0,
  'src/lib/agents/research/write-opening.ts:buildJudgePrompt': 0,
  'src/lib/agents/research/prompts/synthesis-prompt.ts:buildSynthesisPrompt': 8,
  'src/lib/agents/reply-classifier.ts:SYSTEM_PROMPT': 0,
  'src/lib/agents/faq-seed-agent.ts:buildSystemPrompt': 0,
  'src/lib/composition/personalization.ts:systemPrompt': 0,
  'src/lib/agents/revision/run-revision.ts:buildRevisionPrompt': 0,
}

describe('prompt examples name nothing real', () => {
  it.fails('GOAL: every capitalised token in every example is vouched for', () => {
    const v = scanNames()
    expect(v, `${v.length} unvouched tokens:\n${report(v)}`).toEqual([])
  })

  it('no source exceeds the count measured on 2026-08-29', () => {
    const v = scanNames()
    for (const s of PROMPT_SOURCES) {
      const label = s.kind === 'markdown' ? s.path : `${s.path}:${s.symbol}`
      const allowed = BASELINE_BY_SOURCE[label]
      expect(allowed, `${label} has no recorded baseline`).toBeTypeOf('number')
      const mine = v.filter(x => x.source === label)
      expect(
        mine.length,
        `${label}: ${mine.length} unvouched tokens, baseline ${allowed}. Baselines may only go down.\n${report(mine)}`,
      ).toBeLessThanOrEqual(allowed)
    }
  })

  it('the baseline has not been raised, and the allowlist has not been grown', () => {
    expect(Object.values(BASELINE_BY_SOURCE).reduce((a, b) => a + b, 0)).toBe(BASELINE_TOTAL)
    expect(BASELINE_TOTAL).toBeLessThanOrEqual(BASELINE_TOTAL_AT_INTRODUCTION)
    expect(BASELINE_TOTAL_AT_INTRODUCTION).toBe(49)
    expect(Object.keys(BASELINE_BY_SOURCE)).toHaveLength(PROMPT_SOURCES.length)
    // THE OTHER DIRECTION, and the one that matters more. Driving the count above to zero
    // by adding the offending tokens to the allowlist would satisfy every assertion above
    // it. This is what stops that, and it is why the cap is a literal.
    expect(ALLOWLIST.size).toBeLessThanOrEqual(MAX_ALLOWLIST_ENTRIES)
  })

  it('found real examples to scan, so nothing above passes vacuously', () => {
    // The failure this catches is a span extractor that matches nothing and reports a
    // clean sweep. Measured 2026-08-29: 896 spans across the fourteen sources.
    let spans = 0
    let capitalised = 0
    for (const s of PROMPT_SOURCES) {
      const { lines } = readSource(s)
      for (const span of exampleSpans(lines)) {
        spans++
        capitalised += [...span.text.matchAll(/\b[A-Z][a-z]+\b/g)].length
      }
    }
    expect(spans, 'no quoted example spans found at all').toBeGreaterThan(900)
    expect(capitalised, 'spans found but no capitalised tokens in them').toBeGreaterThan(500)
  })
})

// ─── The check discriminates ─────────────────────────────────────────────────
//
// BOTH DIRECTIONS, because an allowlist that allows everything is an outage that reports
// success, and one that allows nothing is a test people delete.

describe('the inverted check tells a name from a word', () => {
  it('rejects an invented company nobody has ever written down', () => {
    // THE MUTATION TEST, as a permanent assertion rather than a one-off. This is the whole
    // claim of an inverted check: it does not need to have heard of the company.
    expect(isAllowedToken('Zentara')).toBe(false)
    expect(isAllowedToken('Quillion')).toBe(false)
    expect(isAllowedToken('Fernbrook')).toBe(false)
  })

  it('rejects the real names the swap pass is removing', () => {
    for (const n of ['Taffet', 'Sovern', 'Visteon', 'Stanford', 'Hollywood', 'Pani']) {
      expect(isAllowedToken(n), `${n} must not be allowed`).toBe(false)
    }
  })

  it('rejects a real organisation acronym while allowing internal jargon', () => {
    // The pair that rules out a blanket all-caps exemption. Both shapes are identical.
    for (const n of ['DTCC', 'GSB', 'SCG', 'CRC', 'CAVE']) {
      expect(isAllowedToken(n), `${n} must not be allowed`).toBe(false)
    }
    for (const n of ['ICP', 'TOV', 'ARR', 'SaaS']) {
      expect(isAllowedToken(n), `${n} must be allowed`).toBe(true)
    }
  })

  it('allows ordinary English, contractions, single letters and compounds', () => {
    for (const w of ['Running', 'Because', 'Their', 'Company', 'Founder']) {
      expect(isAllowedToken(w), `${w} must be allowed`).toBe(true)
    }
    expect(isAllowedToken("I'm")).toBe(true)
    expect(isAllowedToken("We've")).toBe(true)
    expect(isAllowedToken('X')).toBe(true)
    expect(isAllowedToken('English-speaking')).toBe(true)
    expect(isAllowedToken('ICP-derived')).toBe(true)
  })

  it('does not let a compound smuggle a name through one of its halves', () => {
    // The hole a naive hyphen rule opens: allow the compound if ANY half is ordinary.
    expect(isAllowedToken('Taffet-led')).toBe(false)
    expect(isAllowedToken('post-Visteon')).toBe(false)
  })

  it('sees a name at the start of a sentence, where capitalisation proves nothing', () => {
    // The documented hole in the shipped sentence-initial gate. This check has no
    // position-based exemption at all, so it does not inherit it.
    const spans = exampleSpans([{ n: 1, text: '"Taffet publishes commentary. Sovern LA is next."' }])
    expect(spans).toHaveLength(1)
    const toks = [...spans[0].text.matchAll(/\b[A-Za-z][A-Za-z'-]*\b/g)]
      .map(m => m[0]).filter(t => /^[A-Z]/.test(t)).filter(t => !isAllowedToken(t))
    expect(toks).toContain('Taffet')
    expect(toks).toContain('Sovern')
  })

  it('reads an example that spans several lines', () => {
    // Measured: line-by-line matching found 40 tokens where spanning found 143. A matcher
    // that silently stops at the newline reports the smaller number as a clean result.
    const spans = exampleSpans([
      { n: 10, text: 'FAILING: "Two new board seats in early 2026. Hollywood Food' },
      { n: 11, text: '   Coalition and Sovern LA, on top of the day job."' },
    ])
    expect(spans).toHaveLength(1)
    expect(spans[0].from).toBe(10)
    expect(spans[0].to).toBe(11)
    expect(spans[0].text).toContain('Sovern')
  })
})
