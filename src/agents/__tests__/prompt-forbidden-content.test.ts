// THE GUARD ON PROMPT TEXT. Added 2026-08-29.
//
// WHY THIS EXISTS. Prompt text is the only code in this repository that reaches a
// model without passing through a compiler, a linter or a type. The markdown is read
// from disk at runtime by loadSystemPrompt(); the template literals are compiled but
// their CONTENTS are just a string, so tsc has nothing to say about what is in them.
// A client name pasted into either one ships.
//
// WHAT WAS ALREADY HERE, because the brief said nothing reads these files and that is
// not accurate. Three scans already do:
//   prompt-industry-agnostic.test.ts   industry, country, public body, statute, standard
//   prompt-tool-agnostic.test.ts       vendor names
//   rule-text-category-level.test.ts   Rules 1-10 of the shared voice spec
// All three are real and all three are baseline ratchets. What none of them covers is
// the part that matters most here: they scan FIVE markdown files, and there are
// FOURTEEN prompt sources. The ~1,300 lines of prompt text living in TypeScript
// template literals — the research writer alone is 669 — have never been scanned by
// anything. That gap is what this file closes, along with two categories none of them
// checks: buyer archetypes asserted as defaults, and money or headcount figures.
//
// HOW IT WORKS, and the limit stated plainly. This is a DENY LIST, not a detector. It
// cannot know every company in the world and does not try. It holds the exact terms the
// two prior investigations found, plus a few structural patterns (a currency symbol
// before a digit, a magnitude, a headcount band, a corporate suffix). It will not catch
// a company name it has never seen and that carries no suffix. It WILL catch every one
// of the specific things the swap pass is about to remove, the day one of them comes
// back. Regression cover, not discovery.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { PROMPT_SOURCES, RUNTIME_MARKDOWN, readSource, extractTemplateLiteral } from './prompt-sources'
import { FORBIDDEN, BUYER_ARCHETYPE, NAMED_INDUSTRY } from './prompt-forbidden-content.data'

const ROOT = process.cwd()

interface Violation { source: string; line: number; category: string; label: string; match: string; text: string }

function scanAll(): Violation[] {
  const out: Violation[] = []
  for (const s of PROMPT_SOURCES) {
    const { label, lines } = readSource(s)
    for (const { n, text } of lines) {
      for (const { category, patterns } of FORBIDDEN) {
        const hit = patterns.map(p => ({ p, m: text.match(p.re) })).find(x => x.m)
        if (hit && hit.m) {
          out.push({ source: label, line: n, category, label: hit.p.label, match: hit.m[0], text: text.trim().slice(0, 110) })
          break
        }
      }
    }
  }
  return out
}

const report = (v: Violation[]) =>
  v.map(x => `  ${x.source}:${x.line} [${x.category} / ${x.label}] «${x.match}» ${x.text}`).join('\n')

// ─── The measurement ──────────────────────────────────────────────────────────
//
// MEASURED 2026-08-29 on a6ae4df, before anything was changed. 44 violations across
// 8 of the 14 sources. This number may only go DOWN.
//
// RE-MEASURED 2026-08-29 UNDER A WIDER NET, and this is the part worth reading before
// trusting the number. Two patterns were added to BUYER_ARCHETYPE that day, closing the
// bare-buyer-noun blind spot (PG-02, CD-02). The total under the wider deny list is still
// 44 and no per-source figure moved, so nothing here was relaxed to accommodate them.
//
// The two lines that motivated the patterns were REMOVED in the same change, and they were
// never part of the 44: neither was caught by any pattern that existed when the 44 was
// taken. Mutation-tested both ways rather than reasoned about. Putting the writer's line
// back takes buildWriterPrompt to 10 against a baseline of 9, and putting the judge's line
// back takes buildJudgePrompt to 1 against a baseline of 0. Both fail this test.
//
// THE FIGURE THE RATCHET MAY NEVER EXCEED. Kept as the introduction measurement rather than
// overwritten each time the baseline drops, so a later edit cannot walk the number back up
// one ratchet at a time and still satisfy a guard that only compares against itself.
const BASELINE_TOTAL_AT_INTRODUCTION = 44

// RATCHETED DOWN 2026-08-29, same day, by the swap pass over buildWriterPrompt. Nine hits
// on a named sector inside its worked examples went to zero: eight were a placeholder
// substitution, one was rule prose naming the client's own sector as the thing the bridge
// examples deliberately avoid, which had to be said at category level instead. No other
// source moved, and no pattern was narrowed to get here.
//
// RATCHETED DOWN AGAIN 2026-08-29 by the subject-parity pass, 35 -> 34. One hit, in
// messaging-agent.md, on the caption of the peer-pattern exemplar passage: it instructed
// "specific buyer type named" and the passage under it obliged. The passage was replaced
// with one that qualifies its population by SITUATION, and the caption now names that as
// what it is teaching. No other source moved and no pattern was narrowed to get here: the
// same scan re-run over the untouched thirteen returns the same thirteen figures.
//
// THE CANONICAL SPEC ADDED TO THE REGISTRY 2026-08-29, and it brings ZERO with it. That is
// a measurement, not an assumption: shared-voice-spec.md scores 0 against the deny list,
// measured before its corrections were applied and again after, so the total stays 34 and
// no existing per-source figure moves.
//
// A ZERO IS NOT A CLEAN BILL OF HEALTH HERE, and recording it without saying so would be
// the reassuring kind of wrong. The file carried the exemplar passage and the caption that
// this scan's own baseline notes describe as a violation in messaging-agent.md, and scored
// zero on both. NAMED_INDUSTRY is word-bounded on the singular, so the plural form of the
// sector noun is invisible to it, and no pattern matches a caption that INSTRUCTS the
// assertion rather than making it. The 35 -> 34 drop recorded above is attributed to that
// caption and is actually the currency figure removed in the same commit; the caption was
// never counted. So this entry is regression cover for what the deny list can see, and the
// class that motivated adding the file is measured at zero by a scan that cannot see it.
//
// THE NET WIDENED 2026-08-31 AND THE TOTAL WENT UP, 34 -> 35. Read this before treating it
// as a ratchet being walked back, because the two look identical if you only read the number.
//
// NAMED_INDUSTRY was word-bounded on the singular, which is the limit the entry above states
// and does not draw the consequence of. Making it plural-aware surfaced FIVE lines in three
// surface forms that had never been visible to any scan: two in messaging-agent.md, one in
// reply-draft-agent.md, one in buildWriterPrompt, one in buildSynthesisPrompt. FOUR WERE
// FIXED in the same commit and cost nothing here.
//
// THE FIFTH IS RECORDED RATHER THAN FIXED, and it is the whole of the +1:
// buildWriterPrompt goes 0 -> 1. It is rule prose, the verdict line under a worked example,
// and that file is the research writer's teaching corpus. Editing it in a scan-closing commit
// is how a nine-iteration example gets damaged by a drive-by. It is a real hit and it stays
// visible as one.
//
// WHAT TELLS THIS APART FROM A BASELINE BEING RAISED TO HIDE A FAILURE: no per-source figure
// moved except the one the widening newly reached, every other source re-measured identical,
// the introduction figure below is untouched at 44, and 35 is still under it. The same shape
// is recorded in prompt-names.test.ts when the canonical spec joined that registry.
//
// THE THREE DEAD FRAGMENT ENTRIES REPAIRED IN THE SAME COMMIT COST ZERO. Measured, not
// assumed: each was re-scanned alone and newly flagged no lines at all. They were dead
// entries, not suppressed hits, so repairing them changed no count anywhere.
//
// RATCHETED DOWN 2026-09-03, 35 -> 30, by the same pass, and for the same five lines. This
// scan and the industry scan hold two lists of overlapping facts, so both moved together:
// positioning 4 -> 0 and tov 1 -> 0 here as well.
//
// NO PATTERN WAS NARROWED AND NO EXEMPTION WAS ADDED TO GET HERE. Every other source
// re-measured identical, the introduction figure below is untouched at 44, and the GOAL
// test above is still red because 30 is not zero.
//
// RATCHETED DOWN AGAIN 2026-09-03, 30 -> 29, by the example pass that followed. One hit, in
// buildSynthesisPrompt: the BAD-assumption specimen opened "Given your work in consulting",
// which named the client's sector inside the very example teaching the model not to assume
// things about a prospect. It now names a different trade and the lesson is unchanged.
//
// THE SYNTHESIS PROMPT IS A TEMPLATE LITERAL, so none of the markdown exemptions reach it
// and every word in it is scanned. That is why this one moved when a dozen markdown example
// swaps in the same commit moved nothing: the markdown examples sit on labelled Wrong/Right
// lines whose quoted spans are redacted before scanning, so the scan never saw them either
// before or after. A flat figure there is the scan's reach, not the absence of a change.
//
// RATCHETED DOWN 2026-09-03, 29 -> 27, and this is the entry worth reading before trusting
// any "lesson-tied" note in a prompt.
//
// The two remaining synthesis hits were in TEST 1 of the value prop filter, which teaches
// whether a pain is the prospect's own or one they merely observe. They were left in the
// previous pass because that lesson was judged tied to its problem domain. It was not tied
// to the domain. It was tied to the RELEVANT test three hundred lines above, which at the
// time DEFINED relevance as pipeline, marketing capacity and client acquisition. Main
// replaced that definition with a client-derived one in 40e46e4, and the tie went with it.
//
// So a judgement recorded as a property of the text was actually a property of a rule far
// away in the same file, and it went stale the moment that rule moved, silently, with no
// test able to notice. Same family as the caption that asserted a word count the sentence
// under it did not have.
//
// buildSynthesisPrompt now scores 0 and every source in this table except the three markdown
// prompts is at zero. No pattern was narrowed and no exemption added.
const BASELINE_TOTAL = 27

const BASELINE_BY_SOURCE: Record<string, number> = {
  'docs/prompts/shared-voice-spec.md': 0,
  'docs/prompts/icp-agent.md': 9,
  'docs/prompts/positioning-agent.md': 0,
  'docs/prompts/tov-agent.md': 0,
  'docs/prompts/messaging-agent.md': 11,
  'docs/prompts/faq-extraction-agent.md': 2,
  'docs/prompts/reply-draft-agent.md': 3,
  'src/lib/agents/research/write-opening.ts:buildWriterPrompt': 1,
  'src/lib/agents/research/write-opening.ts:buildFloorPrompt': 0,
  'src/lib/agents/research/write-opening.ts:buildJudgePrompt': 0,
  'src/lib/agents/research/prompts/synthesis-prompt.ts:buildSynthesisPrompt': 0,
  'src/lib/agents/reply-classifier.ts:SYSTEM_PROMPT': 0,
  'src/lib/agents/faq-seed-agent.ts:buildSystemPrompt': 0,
  'src/lib/composition/personalization.ts:systemPrompt': 0,
  'src/lib/agents/revision/run-revision.ts:buildRevisionPrompt': 1,
}

describe('prompt text carries no client-specific content', () => {
  // ═════════════════════════════════════════════════════════════════════════
  // EXPECTED TO FAIL. This is the goal state, and it is red on purpose.
  //
  // WHAT UNBLOCKS IT: the swap pass that removes the 44 violations listed by
  // `npx vitest run prompt-forbidden-content` from the prompt sources. When the
  // last one goes, THIS TEST STARTS FAILING BY PASSING — vitest treats a passing
  // it.fails as a failure — and that is the signal to delete the `.fails` and the
  // baseline below, leaving a plain assertion of zero.
  //
  // IT IS NOT THE PROTECTION. The ratchet immediately below it is. This one only
  // records where we are going, so the goal cannot be quietly forgotten.
  // ═════════════════════════════════════════════════════════════════════════
  it.fails('GOAL: zero violations across every prompt source', () => {
    const v = scanAll()
    expect(v, `${v.length} violations:\n${report(v)}`).toEqual([])
  })

  // THE ONE THAT ACTUALLY PROTECTS, and it is green today. A new violation written
  // tomorrow fails this the same day, without waiting for the swap pass.
  it('no source exceeds the count measured on 2026-08-29', () => {
    const v = scanAll()
    for (const s of PROMPT_SOURCES) {
      const label = s.kind === 'markdown' ? s.path : `${s.path}:${s.symbol}`
      const allowed = BASELINE_BY_SOURCE[label]
      expect(allowed, `${label} has no recorded baseline`).toBeTypeOf('number')
      const mine = v.filter(x => x.source === label)
      expect(
        mine.length,
        `${label}: ${mine.length} violations, baseline ${allowed}. Baselines may only go down.\n${report(mine)}`,
      ).toBeLessThanOrEqual(allowed)
    }
  })

  it('the baseline has not been raised to make a failure go away', () => {
    // Guards the guard, the same way prompt-industry-agnostic.test.ts does. The
    // recorded total is what a future edit reaches for first, so it is asserted
    // against the literal measured before any prompt was touched.
    // EXACT, not <=. The per-source table and the declared total are two lists of the same
    // fact, and the shape that goes wrong is one being edited without the other. Equality
    // is what stops a source's figure being dropped while the total still looks plausible.
    expect(Object.values(BASELINE_BY_SOURCE).reduce((a, b) => a + b, 0)).toBe(BASELINE_TOTAL)
    expect(BASELINE_TOTAL).toBeLessThanOrEqual(BASELINE_TOTAL_AT_INTRODUCTION)
    expect(BASELINE_TOTAL_AT_INTRODUCTION).toBe(44)
    expect(BASELINE_TOTAL).toBe(27)
    expect(Object.keys(BASELINE_BY_SOURCE)).toHaveLength(PROMPT_SOURCES.length)
  })

  it('found real prompt text to scan, so nothing above passes vacuously', () => {
    // The failure this catches is a scan that reads nothing and reports zero. The
    // extractor throwing on a renamed symbol is the other half of the same guard.
    let totalLines = 0
    for (const s of PROMPT_SOURCES) {
      const { label, lines } = readSource(s)
      expect(lines.length, `${label} scanned no lines`).toBeGreaterThan(0)
      totalLines += lines.length
    }
    expect(totalLines).toBeGreaterThan(5000)
  })
})

// ─── RULE ZERO: the deny list must never reach a prompt ──────────────────────

describe('the deny list is data and nothing builds a prompt from it', () => {
  const DENY_FILE = 'prompt-forbidden-content.data'

  function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full, acc); continue }
      if (/\.tsx?$/.test(entry)) acc.push(full)
    }
    return acc
  }

  it('no module outside this test imports it', () => {
    // THE WHOLE POINT OF THE FILE'S EXISTENCE IS ALSO ITS WORST FAILURE MODE. It
    // holds the exact strings we ban, so importing it into anything that assembles
    // prompt text would inject the ban list into a prompt. Asserted across ALL of
    // src/ and scripts/ rather than a curated list of "prompt-building modules",
    // because a curated list is a second list to keep in step and this one only has
    // to be right once.
    const offenders = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts'))]
      .filter(f => !f.endsWith('prompt-forbidden-content.test.ts'))
      .filter(f => !f.endsWith('prompt-forbidden-content.data.ts'))
      .filter(f => readFileSync(f, 'utf-8').includes(DENY_FILE))
      .map(f => relative(ROOT, f))

    expect(offenders, `these import the deny list:\n  ${offenders.join('\n  ')}`).toEqual([])
  })

  it('no prompt source contains the deny list itself, by any route', () => {
    // The stronger version of the same rule, checked against the OUTPUT rather than
    // the imports. An import is one way the list could reach a prompt; a copy-paste
    // is another, and this catches both. Uses a phrase unique to the data file.
    for (const s of PROMPT_SOURCES) {
      const { label, lines } = readSource(s)
      const text = lines.map(l => l.text).join('\n')
      expect(text.includes('DATA FILE. NOT A MODULE'), `${label} contains deny-list header text`).toBe(false)
      expect(text.includes(DENY_FILE), `${label} names the deny-list module`).toBe(false)
    }
  })
})

// ─── The registry cannot go stale ────────────────────────────────────────────

describe('the prompt source registry stays in step with the code', () => {
  it('every loadSystemPrompt resolves to a markdown file in the registry', () => {
    // THE PARALLEL-LIST GUARD. PROMPT_SOURCES is a hand-written list, and a
    // hand-written list of things to check is exactly the shape that goes stale and
    // reports success over a shrinking set. This reads the WORLD — every
    // loadSystemPrompt in the codebase — and fails if one names a prompt file the
    // registry has never heard of.
    const files = [
      ...readdirSync(join(ROOT, 'src/agents')).map(f => join(ROOT, 'src/agents', f)),
      ...readdirSync(join(ROOT, 'src/lib/agents')).map(f => join(ROOT, 'src/lib/agents', f)),
    ].filter(f => f.endsWith('.ts') && statSync(f).isFile())

    const referenced = new Set<string>()
    for (const f of files) {
      const src = readFileSync(f, 'utf-8')
      if (!src.includes('loadSystemPrompt')) continue
      for (const m of src.matchAll(/'docs',\s*'prompts',\s*'([a-z0-9-]+\.md)'/g)) {
        referenced.add(`docs/prompts/${m[1]}`)
      }
    }

    expect(referenced.size, 'found no loadSystemPrompt prompt paths at all, so this passed vacuously').toBeGreaterThan(0)
    const missing = [...referenced].filter(p => !RUNTIME_MARKDOWN.includes(p))
    expect(missing, `runtime-loaded prompt files missing from PROMPT_SOURCES:\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('every registered template literal still resolves', () => {
    // extractTemplateLiteral throws on a renamed or deleted symbol. Called here so
    // a rename fails loudly instead of silently dropping a prompt from coverage.
    for (const s of PROMPT_SOURCES) {
      if (s.kind !== 'template-literal') continue
      expect(() => extractTemplateLiteral(join(ROOT, s.path), s.symbol), `${s.path}:${s.symbol}`).not.toThrow()
    }
  })

  it('the extractor reads whole prompts, not just the first literal', () => {
    // REGRESSION TEST FOR A REAL BUG IN THIS FILE'S FIRST DRAFT. The extractor took
    // "the next backtick after the declaration" and on run-revision.ts stopped at a
    // one-line helper, scanning 1 line of an ~81-line prompt builder and reporting a
    // clean pass. Pinned to a floor well above 1 so the truncation cannot come back.
    const lines = extractTemplateLiteral(join(ROOT, 'src/lib/agents/revision/run-revision.ts'), 'buildRevisionPrompt')
    expect(lines.length).toBeGreaterThan(50)
    const writer = extractTemplateLiteral(join(ROOT, 'src/lib/agents/research/write-opening.ts'), 'buildWriterPrompt')
    expect(writer.length).toBeGreaterThan(500)
  })
})

// ─── The patterns themselves ─────────────────────────────────────────────────

describe('the deny-list patterns discriminate', () => {
  const hits = (ps: { label: string; re: RegExp }[], s: string) => ps.some(p => p.re.test(s))

  it('flags a buyer archetype asserted as a default', () => {
    expect(hits(BUYER_ARCHETYPE, 'The buyer is typically the founder of the business.')).toBe(true)
    expect(hits(BUYER_ARCHETYPE, '"title": "e.g. Founder / Managing Director",')).toBe(true)
  })

  it('does NOT flag the rule that forbids assuming one', () => {
    // The negation guard, tested directly rather than through the real files. This
    // is the difference between a scan people trust and one they exempt: without it
    // the pattern fired on "Do not assume the prospect is a founder", which is the
    // prohibition working correctly.
    expect(hits(BUYER_ARCHETYPE, 'Do not assume the prospect is a founder.')).toBe(false)
    expect(hits(BUYER_ARCHETYPE, "Never assume the reader is the owner.")).toBe(false)
    expect(hits(BUYER_ARCHETYPE, 'Read the buyer title from the ICP document.')).toBe(false)
  })

  // ── The blind spot closed on 2026-08-29 (PG-02, CD-02) ──
  //
  // BOTH SIDES OF BOTH NEW PATTERNS, because a pattern that cannot fire is not a
  // narrowing, it is an outage that reports success. The whole reason these were needed
  // is that the scan returned zero for buildJudgePrompt while its one question named an
  // archetype outright, and a check that cannot see the class it was written to find is
  // the failure shape nothing downstream can notice.
  it('flags a bare buyer noun asserted as simple fact, which nothing caught before', () => {
    // The two lines that actually shipped, verbatim as they stood before this change.
    expect(hits(BUYER_ARCHETYPE,
      'You are writing to a founder you respect, who runs a real business and gets a lot of these.')).toBe(true)
    expect(hits(BUYER_ARCHETYPE,
      'Both go out under your name. Which one could a busy founder read once, at speed, without')).toBe(true)
    // The plural-plus-copula frame, on its own.
    expect(hits(BUYER_ARCHETYPE, 'Founders are busy people who skim.')).toBe(true)
    expect(hits(BUYER_ARCHETYPE, 'Managing directors are the ones who sign.')).toBe(true)
    expect(hits(BUYER_ARCHETYPE, 'Owners were the original audience for this.')).toBe(true)
  })

  it('does NOT flag the prohibition, nor a worked example about the CLIENT\'s own audience', () => {
    // The prohibition, in the plural frame this time.
    expect(hits(BUYER_ARCHETYPE, 'Do not assume founders are the buyer.')).toBe(false)
    expect(hits(BUYER_ARCHETYPE, 'Never write as though you are writing to a founder.')).toBe(false)
    expect(hits(BUYER_ARCHETYPE, 'The reader is not a founder unless the ICP says so.')).toBe(false)

    // WORKED EXAMPLE COPY, where the plural noun names the PROSPECT'S customers rather
    // than our reader. The writer prompt teaches from roughly a dozen of these, and a
    // pattern that allowed a clause between the noun and the verb would bury the real
    // hits under them. Requiring the copula to be adjacent is what separates the two.
    expect(hits(BUYER_ARCHETYPE, 'The founders who need you next are not reading your feed yet.')).toBe(false)
    expect(hits(BUYER_ARCHETYPE, 'The founders I speak to describe the same split.')).toBe(false)

    // And the replacement text, which must not trip the pattern that motivated it.
    expect(hits(BUYER_ARCHETYPE, 'You are writing to the person the ASSIGNMENT block names.')).toBe(false)
    expect(hits(BUYER_ARCHETYPE,
      'Who is reading it: not stated. Assume nothing about their role or seniority.')).toBe(false)
  })

  it('does NOT flag ordinary English that happens to contain an industry word', () => {
    // Both of these were real false positives before the patterns were narrowed.
    expect(hits(NAMED_INDUSTRY, 'Vary the sentence construction across variants.')).toBe(false)
    expect(hits(NAMED_INDUSTRY, 'agreement, hostility, or pure logistics')).toBe(false)
  })

  it('still flags the industry terms those narrowings were meant to keep', () => {
    // The other half. A narrowing that switches the pattern off is not a narrowing.
    expect(hits(NAMED_INDUSTRY, 'aimed at a construction firm')).toBe(true)
    expect(hits(NAMED_INDUSTRY, 'a logistics provider in the region')).toBe(true)
    expect(hits(NAMED_INDUSTRY, 'founder-led consulting firms')).toBe(true)
  })

  // ── The plural blind spot, closed 2026-08-31 ──
  //
  // BOTH SIDES, because a pattern that cannot fire is an outage that reports success, and
  // one that fires on everything is an outage that reports failure. The plural is the form
  // prompt text actually uses, since prompts generalise over a population.

  it('flags a sector named in the PLURAL, which was invisible before', () => {
    // The three surface forms that were sitting in the gap, measured on 2026-08-31.
    expect(hits(NAMED_INDUSTRY, 'Most consultants who get there built an engine.')).toBe(true)
    expect(hits(NAMED_INDUSTRY, 'a great many consultancies fill capacity that way')).toBe(true)
    expect(hits(NAMED_INDUSTRY, 'niche labels such as boutique law firms')).toBe(true)
    // And the rest of the list, so the fix is not three special cases.
    expect(hits(NAMED_INDUSTRY, 'aimed at construction firms')).toBe(true)
    expect(hits(NAMED_INDUSTRY, 'logistics companies in the region')).toBe(true)
    expect(hits(NAMED_INDUSTRY, 'healthcare providers and manufacturers')).toBe(true)
  })

  it('the repaired fragment entries match the nouns they were written for', () => {
    // THESE ALL RETURNED FALSE BEFORE THE REPAIR. Three entries ended mid-word and then
    // demanded a word boundary, so each matched nothing while reading as covered. Pinned
    // here so a future edit cannot truncate one back to a stem.
    expect(hits(NAMED_INDUSTRY, 'a recruitment agency')).toBe(true)
    expect(hits(NAMED_INDUSTRY, 'two recruitment agencies')).toBe(true)
    expect(hits(NAMED_INDUSTRY, 'an accountancy')).toBe(true)
    expect(hits(NAMED_INDUSTRY, 'small accountancies')).toBe(true)
    expect(hits(NAMED_INDUSTRY, 'a catering supplier')).toBe(true)
    expect(hits(NAMED_INDUSTRY, 'catering supplies')).toBe(true)
    // The same defect inside the two qualified groups.
    expect(hits(NAMED_INDUSTRY, 'a construction company')).toBe(true)
    expect(hits(NAMED_INDUSTRY, 'logistics industries')).toBe(true)
  })

  it('going plural did NOT widen it onto the two documented false positives', () => {
    // The narrowings that cost real debugging must survive the widening. Both of these
    // are ordinary English and neither names an industry.
    expect(hits(NAMED_INDUSTRY, 'Vary the sentence construction across variants.')).toBe(false)
    expect(hits(NAMED_INDUSTRY, 'agreement, hostility, or pure logistics')).toBe(false)
    // The plural of each, which is the shape the widening could have let through.
    expect(hits(NAMED_INDUSTRY, 'two different sentence constructions')).toBe(false)
    expect(hits(NAMED_INDUSTRY, 'the logistics of getting everyone there')).toBe(false)
  })

  it('the prohibition form stays unflagged where a negation guard owns it', () => {
    // THE NEGATION SIDE OF THE BRIEF, and it belongs to BUYER_ARCHETYPE, which is where
    // NOT_NEGATED lives. Asserted here alongside the plural work because widening one
    // category must not disturb the other's guard. The plural of the prohibition is
    // included: making a pattern plural-aware is exactly when a negation guard breaks.
    expect(hits(BUYER_ARCHETYPE, 'Do not assume the prospect is a founder.')).toBe(false)
    expect(hits(BUYER_ARCHETYPE, 'Do not assume the prospects are founders.')).toBe(false)
    expect(hits(BUYER_ARCHETYPE, 'Never assume the readers are owners.')).toBe(false)

    // AND WHY NAMED_INDUSTRY DOES NOT GET THE SAME GUARD, recorded as a measurement so the
    // next reader does not add one as an obvious improvement. A sector noun in prompt text
    // is a hit whatever the grammar around it: the prompt still contains the sector. The
    // guard was tried on 2026-08-31 and silenced positioning-agent.md L38, where "no other
    // consulting firm" puts a prohibition word inside the lookbehind's 40-character reach
    // and the sector noun is not a prohibition at all. So this fires, correctly, and the
    // line stays in that file's recorded baseline rather than being made invisible.
    expect(hits(NAMED_INDUSTRY, 'that sentence should apply to no other consulting firm')).toBe(true)
  })
})
