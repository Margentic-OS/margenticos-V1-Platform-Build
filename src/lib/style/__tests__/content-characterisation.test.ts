// A CANDIDATE THAT READS THEIR CONTENT AS A BODY IS NOT A HOOK.
//
// MEASURED BEFORE BUILT, and the measurement is the reason this module is as narrow as it is.
// All three hooks the operator named as controls already came out correctly WITHOUT it: two
// were excluded by absenceAboutThem on their omission, and the dated publication burst was
// eligible because nothing fired. So the gap left is only the case that names NO omission,
// and over the 601 stored candidates of the uploaded cohort this module excludes exactly one.
//
// THE DISTINCTION IS PROPORTION versus COUNT, and it is the whole rule:
//   a stated fraction of a bounded set   -> says what their content IS        -> not a hook
//   a plain count of things published    -> says what they DID                -> a hook
// No date is needed to tell them apart, which matters because the strongest hooks are dated
// and the weakest characterisations often are too.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect } from 'vitest'
import { characterisesTheirContent } from '../content-characterisation'

const excluded = (s: string) => characterisesTheirContent(s) !== null

describe('a proportion of their content, characterised', () => {
  it('excludes a stated fraction of a bounded set', () => {
    expect(excluded('Four of the last five posts are retreat promotion or venue scouting.')).toBe(true)
    expect(excluded('All five of the last posts are about pricing.')).toBe(true)
    expect(excluded('Most of the blog entries focus on hiring.')).toBe(true)
  })

  it('excludes a totality, however it is phrased', () => {
    expect(excluded('All five posts in the last 60 days are framed around one theme.')).toBe(true)
    expect(excluded('Every update in the last 60 days is about the other brand.')).toBe(true)
    expect(excluded('None of the articles are about the firm itself.')).toBe(true)
    expect(excluded('The last six updates all cover the same ground.')).toBe(true)
  })
})

describe('a count of what they DID stays a hook', () => {
  it('keeps a dated publication burst, which is the operator control', () => {
    // A plain count in a named window. This is an event, and it is the strongest kind of
    // finding there is, so counting alone must never disqualify.
    expect(excluded('Kestrel Works published at least twelve articles in six days, 12 to 17 September 2026, covering scheduling and staffing.')).toBe(false)
  })

  it('keeps a single dated piece, and a plain count with no proportion', () => {
    expect(excluded('You published a piece on procurement on 14 March.')).toBe(false)
    expect(excluded('The insights page ran twelve new articles last month.')).toBe(false)
    expect(excluded('You shared two posts in March about a new location.')).toBe(false)
  })

  it('keeps "most" used as an ADJECTIVE rather than a quantifier', () => {
    // Found on the stored corpus: a bare `most` matched "their most recent post is", which is
    // a single dated piece. "most recent", "most read" and "most talked about" say nothing
    // about a body of content.
    expect(excluded("Rowan's most recent post is from a networking event in March.")).toBe(false)
    expect(excluded('Your most read article is about scheduling.')).toBe(false)
  })

  it('keeps an event that is not about content at all', () => {
    expect(excluded('You opened a second workshop in March.')).toBe(false)
    expect(excluded('You posted for a site manager on 13 August.')).toBe(false)
  })
})

describe('the hit is readable', () => {
  it('returns the sentence and the matched span, so a rejection can be quoted', () => {
    const hit = characterisesTheirContent('You opened in March. Every update in the last 60 days is about the other brand.')
    expect(hit).not.toBeNull()
    expect(hit!.sentence.startsWith('Every update')).toBe(true)
    expect(hit!.matched.toLowerCase()).toContain('every update')
  })

  it('returns null for empty or absent input rather than throwing', () => {
    expect(characterisesTheirContent('')).toBeNull()
    expect(characterisesTheirContent(null)).toBeNull()
    expect(characterisesTheirContent(undefined)).toBeNull()
  })
})
