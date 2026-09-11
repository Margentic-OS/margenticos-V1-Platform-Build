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
import { scanNames, isAllowedToken, unvouchedTokens, type NameHit } from './prompt-name-scan'

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

// RATCHETED DOWN 2026-08-29, same day, by the swap pass over the six low-risk sources.
// Twelve tokens went, all of them real organisations or real people:
//
//   synthesis-prompt.ts  8 -> 1   two firms and a real review platform, across a failing
//                                 example, a benchmark, a provenance string, a
//                                 winner/trigger pair and a judgemental example
//   faq-extraction       3 -> 0   the OPERATOR'S OWN NAME, twice, in a public repository
//   reply-draft          1 -> 0   a first name in a "never invent context" example
//   positioning          2 -> 1   a real author and their book title
//
// WHAT DID NOT MOVE, and it is the measurement that justifies this file existing: the
// deny-list scan read 35 before the swap and 35 after. Twelve real names left the prompts
// and it did not notice one of them, because it never could.
//
// THE TWO THAT REMAIN IN THE EDITED FILES ARE DELIBERATE, not missed:
//   positioning-agent.md  "Moore"  is load-bearing on the OUTPUT SCHEMA FIELD
//                         moore_positioning, which has stored documents behind it and
//                         legacy moore_statement handling in the dashboard. Renaming it is
//                         a schema migration, not a text swap.
//   synthesis-prompt.ts   "Apollo" is a registered VENDOR in a provenance example, which
//                         is ADR-001 tool-agnosticism, a different rule with a different
//                         fix. Swapping it here would make a silent architectural call.
//
// THE CANONICAL SPEC ADDED TO THE REGISTRY 2026-08-29, BRINGING TWO HITS WITH IT. The total
// moves 37 -> 39 and NO EXISTING PER-SOURCE FIGURE MOVES. That is a source joining the scan,
// not a baseline being walked back up: the introduction figure below is untouched at 49, and
// 39 is still under it, which is the assertion that tells the two apart.
//
// THE TWO WERE ALWAYS THERE AND NOTHING WAS LOOKING. Neither is a real organisation or
// person, and neither is newly written:
//   L12   "Verbatim"  the word, quoted, in this file's own sync-rule header. A capitalised
//                     ordinary word inside quotes, which is the known false-positive shape
//                     this check documents rather than exempts.
//   L174  "IP"        an acronym inside Rule 7's "Wrong final sentence" example. It exists
//                     only here: recorded divergence 5 is that the four prompts carry a
//                     shorter Rule 7 example with no worked wrong sentence, so no scanned
//                     file has ever contained this line.
// Recorded rather than fixed, because editing rule text is a different change from adding a
// source to the registry, and mixing them makes both harder to review.
// WIDENED 2026-09-08, 39 -> 40, by the six src/agents user-message sources joining the shared
// registry, and one stale figure ratcheted down in the same pass.
//
// THE SIX NEW SOURCES CARRY TWO HITS BETWEEN THEM, and four of the six are clean:
//
//   icp / positioning / tov / buyer-criterion buildUserMessage   0 each
//   messaging buildUserMessage                                   1   «Restore»
//   messaging buildSingleVariantUserMessage                      1   «Qualify»
//
// BOTH ARE FALSE POSITIVES and both are RECORDED RATHER THAN ALLOWLISTED. They are ordinary
// capitalised sentence-openers inside quoted rule prose ("Restore the noun and the sentence
// survives any P2", "Qualify the population by role"), not names of anything. Adding them to
// the allowlist is precisely the move the guard below exists to prevent, and it would also
// blind the scan to a real name that happened to be spelled Restore. Two visible false
// positives cost less than a widened allowlist.
//
// AND shared-voice-spec.md GOES 2 -> 1, which is NOT caused by this commit: the file is
// byte-identical to origin/main. The per-source assertion is `<=`, so a stale high baseline
// passes silently, which is how it survived unnoticed. Recording the measured figure is the
// point of the table.
//
// WHAT TELLS THIS APART FROM A BASELINE RAISED TO HIDE A FAILURE: every other pre-existing
// source re-measured identical, the allowlist did not grow, the introduction figure is
// untouched at 49, and 40 is still under it.
//
// RATCHETED DOWN 2026-09-10, 40 -> 21, by the writer-example rewrite. buildWriterPrompt goes
// 33 -> 14. Nineteen tokens left, eighteen of them real organisations, a real prospect's
// company or a real trade show, and one an ordinary word the scan misread:
//
//   DTCC x2, Treasury x2, SEC, SEC's                         the regulatory-commentary pair
//   Taffet                                                   that pair's clean rewrite
//   Hollywood x2, Coalition x2, Sovern x2, LA x2, SCG x2     the board-seat pair
//   CAVE                                                     the third worked pair
//   Peak                                                     "Peak season", a false positive
//
// THE SAME COMMIT ADDED A NARROW EXCEPTION TO THE SCAN, which is the first thing to suspect
// when a baseline drops, so it was measured on its own: the NEW scan over the OLD prompt
// reads 33, identical to the old scan. The exception moved nothing that already existed. It
// only stops "Drivers", opening one of the new examples, from counting as a name.
//
// No other source moved, the allowlist did not grow, and the introduction figure is untouched.
const BASELINE_TOTAL = 21

const BASELINE_BY_SOURCE: Record<string, number> = {
  'docs/prompts/shared-voice-spec.md': 1,
  'docs/prompts/icp-agent.md': 0,
  'docs/prompts/positioning-agent.md': 1,
  'docs/prompts/tov-agent.md': 0,
  'docs/prompts/messaging-agent.md': 2,
  'docs/prompts/faq-extraction-agent.md': 0,
  'docs/prompts/reply-draft-agent.md': 0,
  'src/lib/agents/research/write-opening.ts:buildWriterPrompt': 14,
  'src/lib/agents/research/write-opening.ts:buildFloorPrompt': 0,
  'src/lib/agents/research/write-opening.ts:buildJudgePrompt': 0,
  'src/lib/agents/research/prompts/synthesis-prompt.ts:buildSynthesisPrompt': 1,
  'src/lib/agents/reply-classifier.ts:SYSTEM_PROMPT': 0,
  'src/lib/agents/faq-seed-agent.ts:buildSystemPrompt': 0,
  'src/lib/composition/personalization.ts:systemPrompt': 0,
  'src/lib/agents/revision/run-revision.ts:buildRevisionPrompt': 0,
  // The sourcing tuner's judge, added to the registry 2026-09-08. ZERO, and measured rather
  // than assumed: the entry was added and this scan re-run, and neither BASELINE_TOTAL nor
  // any other per-source figure moved. It is the second scan over the same registry, so a
  // source added for one is automatically covered by both, which is the point of the
  // registry being shared.
  'src/lib/tuner/judge.ts:buildJudgePrompt': 0,
  // The fit judge, added 2026-09-09. Zero against both scans, measured rather than assumed:
  // the entry was added, both scans re-run, and neither total nor any other source moved.
  'src/lib/tuner/fit-judge.ts:buildFitJudgePrompt': 0,
  // ADDED 2026-09-09. MEASURED, not assumed. Zero is the only acceptable value here: this is
  // the prompt whose whole subject is what a name means, so any entry above zero is a rule
  // about names that would apply to every client at once.
  'src/lib/tuner/name-signal.ts:buildNameSignalPrompt': 0,
  // ADDED 2026-09-09 with the cheaper read. MEASURED, not assumed: the entry was added and
  // the scan re-run, and neither total moved.
  'src/lib/agents/tools/webSearch.ts:searchViaNativeAnthropic': 0,
  // The document agents' user messages, added 2026-09-08. Four clean; two false positives
  // recorded rather than allowlisted. See the note above BASELINE_TOTAL.
  'src/agents/icp-generation-agent.ts:buildUserMessage': 0,
  'src/agents/positioning-generation-agent.ts:buildUserMessage': 0,
  'src/agents/tov-generation-agent.ts:buildUserMessage': 0,
  'src/agents/buyer-criterion-agent.ts:buildUserMessage': 0,
  'src/agents/messaging-generation-agent.ts:buildUserMessage': 1,
  'src/agents/messaging-generation-agent.ts:buildSingleVariantUserMessage': 1,
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
    // clean sweep. Measured 2026-08-29: 896 spans across fourteen sources, and 1,099 across
    // fifteen once the shared spec joined. 1,098 on 2026-08-31, when the writer prompt's
    // endorsed ATTRIBUTED example was deleted along with the rule it illustrated. The floor
    // stays at the figure that was argued for rather than tracking the newest measurement,
    // so it keeps catching an extractor that reads nothing without being re-set every time a
    // source is added.
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

// ─── A plural opening a sentence ─────────────────────────────────────────────
//
// ADDED 2026-09-10. See isOrdinaryPlural. Tested in BOTH directions, because an exception is
// only narrow if it is shown refusing the cases next to the one it lets through.

describe('a plural at the start of a sentence is not a name when its singular is English', () => {
  it('lets through the plural that forced a writer example out of its natural order', () => {
    expect(unvouchedTokens('Drivers pass your orchard sign at fifty miles an hour.')).toEqual([])
    expect(unvouchedTokens('The sign is on the main road. Drivers pass it at fifty miles an hour.')).toEqual([])
  })

  it('still catches a real name in the same position', () => {
    // THE POSITIVE CONTROL. The exception is about position, and position is exactly where
    // capitalisation stops meaning anything, so the check has to prove it still sees a
    // name there.
    expect(unvouchedTokens('Taffet publishes regulatory commentary regularly.')).toEqual(['Taffet'])
    expect(unvouchedTokens('The report is out. Visteon led the round.')).toEqual(['Visteon'])
  })

  it('still catches an invented name that merely looks plural', () => {
    expect(unvouchedTokens('Zentaras opened a second office. Quillions followed.')).toEqual(['Zentaras', 'Quillions'])
  })

  it('applies only at the start of a sentence', () => {
    // Mid-sentence the capital means something, so the same word is still a candidate.
    expect(unvouchedTokens('We spoke to Drivers about the contract.')).toEqual(['Drivers'])
  })

  it('stays narrow: a plural whose singular is not vouched for is still flagged', () => {
    // "parent" is not in the ordinary list. That is a vocabulary gap, not a plural problem,
    // and widening this rule to reach it would admit any capitalised word ending in s.
    expect(unvouchedTokens('Parents hear the concert.')).toEqual(['Parents'])
  })
})
