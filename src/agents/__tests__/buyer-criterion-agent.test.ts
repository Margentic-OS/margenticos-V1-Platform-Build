// RULE ZERO ENFORCEMENT FOR THE BUYER CRITERION PROMPT.
//
// The derivation this prompt drives is ABOUT job titles, which makes it the single most
// likely place in this codebase for a worked example to be written. A worked example
// naming a real title does not stay an example: it is sent with every client's documents
// and gets reproduced verbatim for clients whose market uses different words. That has
// happened eight recorded times in this project.
//
// This file is the control. A review is not sufficient, because a review happens once and
// this runs on every commit.
//
// NOTE ON WHY THE SCAN TARGETS THE PROMPT AND NOT THE WHOLE FILE. The banned-word lists
// themselves live in the agent module and necessarily contain title vocabulary, so a
// whole-file scan could never pass. What can actually be reproduced for every client is
// the string that is SENT, and that is what is scanned.

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  BUYER_CRITERION_PROMPT,
  BANNED_TITLE_WORDS,
  BANNED_INDUSTRY_WORDS,
  findBannedContent,
} from '@/agents/buyer-criterion-agent'
import { CANONICAL_INDUSTRIES } from '@/lib/agents/icp-filter-spec'

describe('Rule Zero: the buyer criterion prompt names no titles and no industries', () => {
  it('contains no banned title or industry content', () => {
    // THE ASSERTION. Deleting it is what this file exists to prevent, and the tests
    // below prove it is not vacuous: the scanner has teeth and the lists are populated.
    expect(findBannedContent(BUYER_CRITERION_PROMPT)).toEqual([])
  })

  it('states the criterion at category level, so it has something to say instead', () => {
    // The prompt has to ASK the question some other way, or "no titles" is satisfied by
    // an empty prompt. These three are the category-level tests it must pose.
    const prompt = BUYER_CRITERION_PROMPT.toLowerCase()
    expect(prompt).toContain('owns the problem')
    expect(prompt).toContain('controls the spend')
    expect(prompt).toContain('convene the decision')
  })

  it('tells the model that an unsettled answer is a correct outcome', () => {
    expect(BUYER_CRITERION_PROMPT.toLowerCase()).toContain('unsettled')
  })
})

describe('the assertion itself cannot be quietly removed', () => {
  // Every other test here goes green if someone deletes the one line that scans the
  // prompt, because an empty test body passes. No framework can see a missing
  // assertion. So this reads THIS FILE and fails if the scan is not in it.
  //
  // Same shape as the registry test CLAUDE.md describes: check against the world, not
  // against yourself, and fail if the scan finds nothing rather than passing over an
  // empty set.
  it('still scans the prompt', () => {
    const ownSource = readFileSync(__filename, 'utf8')

    // Built in two halves ON PURPOSE. Written whole, this literal would satisfy its own
    // search and the guard would pass with the real assertion deleted, which is exactly
    // what happened on the first attempt. Concatenated, the complete string exists only
    // at run time, so the only place it can be FOUND is the real assertion.
    const needle = 'findBannedContent(BUYER_CRITERION' + '_PROMPT)).toEqual([])'

    expect(ownSource.length).toBeGreaterThan(0)
    expect(ownSource).toContain(needle)
  })
})

describe('the scanner is not vacuous', () => {
  // A scan that finds nothing because it looks for nothing passes forever and protects
  // nothing. This is the same shape as the monitor sweep whose loop was bounded by the
  // shorter of two arrays: the check ran, reported success, and never reached the thing
  // it was supposed to protect.

  it('has words to look for', () => {
    expect(BANNED_TITLE_WORDS.length).toBeGreaterThan(10)
    expect(BANNED_INDUSTRY_WORDS.length).toBeGreaterThan(10)
    expect(CANONICAL_INDUSTRIES.length).toBeGreaterThan(10)
  })

  it('detects every banned title word when one is planted', () => {
    // The probes are BUILT FROM THE LIST rather than typed out, so no job title appears
    // as a literal anywhere in this test file. That is the same Rule Zero the prompt is
    // held to, applied to the thing that checks it.
    for (const word of BANNED_TITLE_WORDS) {
      const planted = `A sentence that happens to mention ${word} in passing.`
      expect(findBannedContent(planted)).toContain(word)
    }
  })

  it('detects every banned industry word when one is planted', () => {
    for (const word of BANNED_INDUSTRY_WORDS) {
      expect(findBannedContent(`A sentence mentioning ${word} here.`)).toContain(word)
    }
  })

  it('detects a canonical industry name, which is the other place one could be copied from', () => {
    for (const industry of CANONICAL_INDUSTRIES) {
      const hits = findBannedContent(`The business serves ${industry} and nothing else.`)
      expect(hits.length).toBeGreaterThan(0)
    }
  })

  it('matches whole words only, so it does not cry wolf', () => {
    // A substring scan flags real words that merely contain a banned one, and a guard
    // that fires on correct prompts is one that gets loosened until it stops working.
    // Built by concatenation so no banned word appears as a literal here either.
    const chief = BANNED_TITLE_WORDS.find(w => w === 'chief')!
    const principal = BANNED_TITLE_WORDS.find(w => w === 'principal')!
    expect(findBannedContent(`${chief}ly concerned`)).toEqual([])
    expect(findBannedContent(`the ${principal}le of the thing`)).toEqual([])
  })
})
