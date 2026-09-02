// THE WORKED EXAMPLES IN buildWriterPrompt MAY NOT MODEL A BACKWARD REFERENCE.
//
// ─── WHY A TEST AND NOT JUST THE RULE ────────────────────────────────────────
//
// The prompt has carried "NEVER POINT BACK. NAME THE THING AGAIN." since 2026-09-01 and
// the fault kept shipping. The reason was not the rule's wording. It was that the page
// around the rule DEMONSTRATED the fault: 13 of the specimens labelled WORKS, WORKING,
// PLAIN, CLEAN, CONCRETE or CORRECTED pointed backwards, so the model had one rule telling
// it not to and thirteen worked examples showing it how. Examples beat rules in this file
// by measured history, which is exactly why they beat this one.
//
// So the thing that has to stay true is a property of the EXAMPLES, and a rule cannot hold
// itself. This test is what holds it.
//
// ─── WHAT IT SCANS ───────────────────────────────────────────────────────────
//
// Every double-quoted specimen of >= 5 words inside buildWriterPrompt. That is the set the
// model reads as copy: observations, bridges, closing questions and opening fragments. The
// short quoted spans are rule vocabulary ("because", "your diary", "one", "ones") and are
// not specimens, which is what the word floor removes.
//
// ─── THE THREE SIGNALS, AND WHY TWO OF THEM ARE LOCAL ────────────────────────
//
// findOpeningReferences is the SHIPPED detector and is imported, never restated, so this
// test cannot agree with a copy of the detector while disagreeing with the real one.
//
// The other two patterns are LOCAL TO THIS TEST ON PURPOSE. opening-reference.ts is wired
// onto live writer output and its precision on fresh prospect copy has been measured and
// found too low to block. These two have not been measured on that corpus at all. Putting
// them here scans a FIXED, HAND-READ 73-specimen corpus, where a false positive is found
// once and allowlisted by hand; putting them in the shipped module would point an unmeasured
// pattern at real output. Same reasoning the shipped module gives for keeping pronominal-one
// out of findBackReferences.
//
// ─── THE ALLOWLIST IS PHRASES, NOT SPECIMENS ─────────────────────────────────
//
// Three specimens still flag, and all three are the documented false-positive shapes:
// a relative pronoun ("a firm that rely"), a degree modifier ("that fast"), and a deictic
// ("a firm that size") that binds no earlier noun. They are allowlisted BY PHRASE, so a
// specimen that acquires a real pointer still fails even if it already held an allowlisted
// one. Allowlisting the specimen instead would switch the check off for that line.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { findOpeningReferences } from '@/lib/style/opening-reference'
import { buildWriterPrompt, buildWriterAssignment } from '../write-opening'

const FILE = join(process.cwd(), 'src/lib/agents/research/write-opening.ts')

// An auxiliary negated with no main verb after it: the verb sits in an earlier sentence.
// "February does not" points back; "a gap that does not arrive" does not, because the verb
// is present. The lookahead is what separates them.
const ELIDED_VERB_PHRASE =
  /\b(?:does|do|did|is|are|was|were|has|have|had|can|could|will|would|should)\s+(?:not|n't|never)\b(?=\s*(?:[,.;:]|and\b|but\b|so\b|or\b|$))|\b(?:never|rarely|seldom)\s+(?:does|do|did|is|are|was|were|has|have|had)\b(?=\s*(?:[,.;:]|and\b|but\b|so\b|or\b|$))/gi

// "one"/"ones" standing in for a noun, including the determiners the shipped module's
// PRONOMINAL_ONE does not carry.
const NOUN_PHRASE_POINTER =
  /\b(?:whichever|whatever|each|every|another|the\s+(?:next|last|current|first|second|other))\s+(?:[a-z-]+\s+){0,2}ones?\b/gi

// A sentence that OPENS on a bare demonstrative or pronoun subject. Its subject is
// whatever the sentence before it was about, which is the fault stated exactly.
// Only checked from the second sentence on: a specimen's first sentence opening on "That"
// points at the observation paragraph, which is a real fault too, so the first sentence is
// checked separately below by anchoring on the start of the specimen.
const BARE_SUBJECT = /(?:^|(?<=[.!?])\s+)(That|This|These|Those|It|They)\s+(?:is|are|was|were|also|tends?|books?|means?|shows?|does|do|will|would|has|have|had|gets?|goes)\b/g

/** Phrases measured as false positives by hand over all 73 specimens. */
const ALLOWED_PHRASES = new Set(['that size', 'that rely', 'that follow', 'that moves', 'that fast'])

/**
 * TWO SPECIMENS WHERE THE POINTER IS THE FAULT BEING TAUGHT, listed by exact text.
 *
 * Both are quoted as DEFECTS and named as defects in the sentence underneath them, so they
 * teach the pointer as wrong. Rewriting the pointer out of either one would delete the
 * lesson it was written for, which is the one thing the clarity pass was told not to do.
 *
 * BY EXACT TEXT, NOT BY LINE, so neither entry can drift onto a different specimen, and a
 * specimen that changes at all stops matching and has to be re-read by a human.
 */
const CONDEMNED_IN_PLACE = new Set([
  // "Until it does not" is named on the next line as "a shape where a fact should be".
  // The elision IS the defect. Its antecedent is also in its own sentence, so it is not a
  // violation of the rule as scoped ("a reference back from a PREVIOUS SENTENCE").
  'Outreach for the new-business side sits until it does not.',
  // Quoted to condemn a bare abstract subject: "leaves the reader wondering what output".
  // The same sentence was ENDORSED 89 lines above as a CLEAN rewrite until this pass, which
  // is the contradiction the rewrite of that specimen resolved.
  'that output shows where your thinking is',
])

/**
 * Rule vocabulary, not a specimen: a sentence SHAPE written with placeholders rather than
 * copy. "Firms that X often find Y" is named as a construction to vary, and X and Y are
 * slots. Excluded by the placeholder, so real copy can never be excluded this way.
 */
const isSchema = (text: string) => /\b[XY]\b/.test(text)

interface Specimen { line: number; text: string }

function specimens(): Specimen[] {
  const lines = readFileSync(FILE, 'utf8').split('\n')
  const start = lines.findIndex(l => l.includes('export function buildWriterPrompt()'))
  expect(start, 'buildWriterPrompt not found').toBeGreaterThan(-1)
  const endRel = lines.slice(start).findIndex(l => l.trimEnd().endsWith('`') && l.includes('SUBJECT:'))
  expect(endRel, 'end of the writer prompt literal not found').toBeGreaterThan(-1)

  const body = lines.slice(start, start + endRel + 1).join('\n')
  const offToLine: number[] = []
  let n = start + 1
  for (let i = 0; i < body.length; i++) { offToLine[i] = n; if (body[i] === '\n') n++ }

  const out: Specimen[] = []
  for (const m of body.matchAll(/"([^"]+)"/g)) {
    const text = m[1].replace(/\s*\n\s*/g, ' ').trim()
    if (text.split(/\s+/).length >= 5) out.push({ line: offToLine[m.index!], text })
  }
  return out
}

describe('buildWriterPrompt worked examples do not model a backward reference', () => {
  const all = specimens()

  // GUARDS ITSELF. A scan that finds nothing passes vacuously, which is the shape this
  // repository has already been bitten by twice. If the extraction breaks, this fails
  // rather than reporting a clean prompt.
  it('finds the specimen corpus at all', () => {
    expect(all.length).toBeGreaterThanOrEqual(60)
  })

  it('no specimen points back instead of naming the thing again', () => {
    const bad: string[] = []
    for (const s of all) {
      if (isSchema(s.text) || CONDEMNED_IN_PLACE.has(s.text)) continue
      const hits = findOpeningReferences('', s.text)
        .filter(h => !ALLOWED_PHRASES.has(h.phrase.toLowerCase().trim()))
        .map(h => `${h.kind} "${h.phrase}"`)

      for (const m of s.text.matchAll(ELIDED_VERB_PHRASE)) hits.push(`elided-verb-phrase "${m[0]}"`)
      for (const m of s.text.matchAll(NOUN_PHRASE_POINTER)) hits.push(`noun-phrase-pointer "${m[0]}"`)
      for (const m of s.text.matchAll(BARE_SUBJECT)) hits.push(`bare-subject "${m[0].trim()}"`)

      if (hits.length) bad.push(`  write-opening.ts:${s.line} [${hits.join(', ')}]\n    ${s.text}`)
    }
    expect(bad, `${bad.length} specimen(s) model a backward reference:\n${bad.join('\n')}`).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE SHAPE NO PATTERN ABOVE CAN EXPRESS, PINNED BY TEXT INSTEAD.
//
// Three of the rewrites remove a BARE OBJECT PRONOUN whose antecedent is in the paragraph
// ABOVE the specimen: "the right buyers hear it on the day", "nobody gets to it", "the
// founders who hear it". Every one of them is ordinary anaphora on its face. What makes it
// a fault is that the noun "it" stands for is in the OBSERVATION, which is a different
// paragraph that the writer has not written yet when it writes the bridge.
//
// NO REGEX SEPARATES THAT FROM ORDINARY ANAPHORA, and the shipped detector agrees: its
// unanchored it/they/them signal measured ZERO hits across both of its corpora, 85 real
// openings, precisely because the pronouns are locally anchorable and globally dangling.
//
// So these three are pinned as EXACT TEXT rather than detected. A pin proves the rewrite
// stays; it does not prove the property holds for a sentence nobody has written yet. That
// limit is stated here so the next reader does not over-trust this block, and the honest
// version of the guard is a human reading the bridges, which is what Part 5 of the clarity
// pass did.
// ═════════════════════════════════════════════════════════════════════════════
describe('the bare-pronoun rewrites stay rewritten', () => {
  const PINNED = [
    'The right buyers hear the talk on the day. Then the event ends, and most buyers do not follow up first.',
    'Outreach gets whatever hours are left at the end of the day. Most weeks nobody makes the call.',
    'The founders who hear the talk and are ready to buy tend to need a nudge before they become a conversation.',
  ]
  const flat = readFileSync(FILE, 'utf8').replace(/\s*\n\s*/g, ' ')

  it.each(PINNED)('still reads: %s', text => {
    expect(flat).toContain(text)
  })

  // The pin is only meaningful if the phrases it replaced are gone.
  it.each([
    'The right buyers hear it on the day',
    'Most weeks nobody gets to it',
    'The founders who hear it and are ready to buy',
  ])('no longer reads: %s', text => {
    expect(flat).not.toContain(text)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE CACHE INVARIANT, RE-ASSERTED BECAUSE THIS PASS EDITED THE PROMPT.
//
// The writer system prompt is ~10.6k tokens and is sent up to three times per prospect.
// It is worth that only while it is BYTE-IDENTICAL for every client, because a prefix that
// differs by one byte pays full input price on every writer call in the system and nothing
// else in the suite would notice.
//
// TWO CLAIMS, and the first is the structural one. buildWriterPrompt takes NO ARGUMENTS, so
// there is no client to vary on: asserting `.length === 0` is what makes the second claim
// more than a coincidence of two fixtures happening to agree. The second runs two genuinely
// different clients through buildWriterAssignment, which is where the per-client text is
// SUPPOSED to live, and asserts the system prompt hash is unmoved while the assignment moves.
// ═════════════════════════════════════════════════════════════════════════════
describe('the writer system prompt is client-invariant', () => {
  const sha = (x: string) => createHash('sha256').update(x, 'utf8').digest('hex')

  const CLIENT_A = { clientName: 'CLIENT_A_NAME', buyer: 'BUYER_TITLE_A', p3: 'P3_LINE_A', cta: 'CTA_LINE_A?' }
  const CLIENT_B = { clientName: 'CLIENT_B_NAME', buyer: 'BUYER_TITLE_B', p3: 'P3_LINE_B', cta: 'CTA_LINE_B?' }

  it('takes no arguments, so no client can reach it', () => {
    expect(buildWriterPrompt.length).toBe(0)
  })

  it('is byte-identical across two different clients', () => {
    const a = buildWriterAssignment(CLIENT_A)
    const first = sha(buildWriterPrompt())
    const b = buildWriterAssignment(CLIENT_B)
    const second = sha(buildWriterPrompt())

    expect(second).toBe(first)
    // The control. If the assignment were ALSO identical the fixtures would be proving
    // nothing, so the test asserts the per-client text really did move.
    expect(a).not.toBe(b)
  })

  it('carries no client value from either fixture', () => {
    buildWriterAssignment(CLIENT_A)
    buildWriterAssignment(CLIENT_B)
    const p = buildWriterPrompt()
    for (const v of [...Object.values(CLIENT_A), ...Object.values(CLIENT_B)]) {
      expect(p).not.toContain(v)
    }
  })
})
