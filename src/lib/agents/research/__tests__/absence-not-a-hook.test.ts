// A candidate that names what the prospect LACKS is not a hook.
//
// WHY IN ELIGIBILITY, NOT IN A PROSE GATE. one prospect's (id 31ebdeaf) chosen fact was an absence: "All five
// blog posts published in 2026 are personal lifestyle content ... with no IT, business
// development, or client-facing content visible." The absence IS the candidate, so a gate on the
// written sentence only teaches the writer to paraphrase it — the material it was given contains
// nothing else.
//
// THE FIXTURES ARE THE REAL OBSERVATIONS, because the controls are about whether this predicate
// separates two shapes that look similar in the abstract and are obviously different in the data:
// "there is none of X" against "they published X on a date".
//
// RULE ZERO. The prospect and firm names are replaced with invented ones; only the SHAPE of each
// observation is real, which is the part under test.

import { describe, it, expect } from 'vitest'
import { isHookEligible, namesAnAbsence, readsTheirContentAsABody } from '../synthesize'
import { absenceAboutThem } from '@/lib/style/absence-about-them'
import type { ObservationCandidate } from '../types'

function cand(observation: string, over: Partial<ObservationCandidate> = {}): ObservationCandidate {
  return {
    id: 'c1', observation, date: '2026-09-15', source: 'linkedin',
    provenance: 'LinkedIn post, example.com/in/someone',
    score_total: 4, passes_all: true, inference_direction: 'single', is_reshare: false,
    ...over,
  } as unknown as ObservationCandidate
}

// Real shapes, invented names.
const ABSENCE_LIFESTYLE = 'All five blog posts published in 2026 are personal lifestyle content covering vacations, family, and moving, with no IT, business development, or client-facing content visible.'
const ABSENCE_NOTHING_FOUND = 'No LinkedIn posts, no dated web articles, no blog content, and no 2026 press coverage exist across all four sources for Ridgemont.'
const PRESENT_POST = 'Ridgemont published a post on 15 September arguing that most firms mistake activity for progress.'
const PRESENT_BLOG = 'Casey published a blog post on 15 September 2026 on five growth challenges scaling businesses face.'

describe('an absence is not a hook', () => {
  it('EXCLUDES a candidate whose content is what they do not have', () => {
    expect(namesAnAbsence(cand(ABSENCE_LIFESTYLE))).toBe(true)
    expect(isHookEligible(cand(ABSENCE_LIFESTYLE))).toBe(false)
  })

  it('EXCLUDES a candidate that is a research dead end', () => {
    expect(namesAnAbsence(cand(ABSENCE_NOTHING_FOUND))).toBe(true)
    expect(isHookEligible(cand(ABSENCE_NOTHING_FOUND))).toBe(false)
  })

  // ─── THE PASSING CONTROLS. Without these the rule could be excluding everything. ────

  it('KEEPS a dated post about something they did', () => {
    expect(namesAnAbsence(cand(PRESENT_POST))).toBe(false)
    expect(isHookEligible(cand(PRESENT_POST))).toBe(true)
  })

  it('KEEPS a dated blog post', () => {
    expect(namesAnAbsence(cand(PRESENT_BLOG))).toBe(false)
    expect(isHookEligible(cand(PRESENT_BLOG))).toBe(true)
  })

  // ─── WHOSE ABSENCE IS IT. The three shapes the raw detector got wrong. ──────────────
  //
  // Measured across 601 real candidates 2026-09-28: the trigger gate's detector flagged 13 and
  // three were plainly wrong. Each is a dated thing the prospect DID.

  const about = { companyName: 'Ridgemont Advisory', firstName: 'Casey' }

  it('KEEPS an absence about THIRD PARTIES', () => {
    // The absence describes the recruiters, not the prospect.
    expect(absenceAboutThem({
      observation: 'Casey published a post on 15 September positioning Ridgemont against transactional recruiters who send resumes without follow-through.',
      ...about,
    })).toBeNull()
  })

  it('KEEPS an absence inside a QUOTED TITLE', () => {
    expect(absenceAboutThem({
      observation: "Casey published 'The Plan on the Wall. A Route No One Has Walked.' on July 28th.",
      ...about,
    })).toBeNull()
  })

  it('KEEPS an absence that is the PUBLISHED TOPIC', () => {
    expect(absenceAboutThem({
      observation: 'Casey published a piece on August 12 on why the right message is not enough without the right audience.',
      ...about,
    })).toBeNull()
  })

  it('EXCLUDES an absence on one of THEIR OWN surfaces', () => {
    expect(absenceAboutThem({ observation: 'The ridgemont.com site has no blog and no dated case studies.', ...about })).not.toBeNull()
  })

  it('EXCLUDES a second-person absence', () => {
    expect(absenceAboutThem({ observation: 'Your feed shows no business development content.', ...about })).not.toBeNull()
  })

  it('A COMMA INSIDE A LIST IS NOT A CLAUSE BOUNDARY', () => {
    // Splitting on every comma was tried and it broke the case this module exists for:
    // "with no IT" became its own clause with no anchor in it, so the candidate was kept.
    expect(absenceAboutThem({
      observation: 'All five blog posts published in 2026 are personal lifestyle content covering vacations, family, and moving, with no IT, business development, or client-facing content visible.',
      ...about,
    })).not.toBeNull()
  })

  // ─── The other disqualifiers still work, so this did not replace them ──────────────

  it('CONTROL: the existing ambiguous-direction exclusion still fires', () => {
    expect(isHookEligible(cand(PRESENT_POST, { inference_direction: 'ambiguous_unhandled' }))).toBe(false)
  })

  it('CONTROL: the existing passes_all exclusion still fires', () => {
    expect(isHookEligible(cand(PRESENT_POST, { passes_all: false }))).toBe(false)
  })

  it('CONTROL: an empty observation does not throw and is not called an absence', () => {
    // Nothing to read is not the same as reading an absence; passes_all would exclude it anyway.
    expect(namesAnAbsence(cand(''))).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ITEM B, WIRED: a candidate that reads their content as a body is not a hook either.
//
// The seam, not the predicate. content-characterisation.test.ts owns which sentences match;
// these assert that isHookEligible ACTS on the verdict, which is the half this project keeps
// losing. Measured over 601 stored candidates before wiring: it removes exactly one, and no
// prospect loses every candidate.
//
// RULE ZERO. Every fixture is invented and industry-neutral.
// ═══════════════════════════════════════════════════════════════════════════════

describe('item B reaches isHookEligible', () => {
  const candidate = (observation: string): ObservationCandidate => ({
    id: 'cB', observation, source: 'linkedin', provenance: 'https://example.com/post',
    date: '2026-09-15', is_composite: false,
    scores: { specific: true, verifiable: true, inferential: true, relevant: true, useful: true, non_judgemental: true },
    passes_all: true, score_total: 6, model_readable_claim: true,
    opposite_reading: 'It could mean something else.', inference_direction: 'compatible_with_both',
    readability: { hard_fail: false, penalty: 0, max_sentence_words: 9, hedges: [], nominalisation_density: 0, nominalisation_over_threshold: false, reasons: [] },
    demoted: false, rejection_reason: null,
  } as unknown as ObservationCandidate)

  it('EXCLUDES a proportion of their content, characterised', () => {
    expect(readsTheirContentAsABody(candidate('Four of the last five posts are retreat promotion or venue scouting.'))).toBe(true)
    expect(isHookEligible(candidate('Four of the last five posts are retreat promotion or venue scouting.'))).toBe(false)
  })

  it('KEEPS a dated publication burst, which is the operator control', () => {
    const obs = 'Kestrel Works published at least twelve articles in six days, 12 to 17 September 2026, covering scheduling and staffing.'
    expect(readsTheirContentAsABody(candidate(obs))).toBe(false)
    expect(isHookEligible(candidate(obs))).toBe(true)
  })

  it('CONTROL: an ordinary dated event is still eligible, so this is not rejecting everything', () => {
    expect(isHookEligible(candidate('You opened a second workshop in March.'))).toBe(true)
  })

  it('leaves the other disqualifications doing their own work', () => {
    // A candidate failing on its scores is excluded for THAT reason, not this one, so a
    // future edit here cannot quietly become the only thing rejecting it.
    const weak = { ...candidate('You opened a second workshop in March.'), passes_all: false }
    expect(readsTheirContentAsABody(weak)).toBe(false)
    expect(isHookEligible(weak)).toBe(false)
  })
})
