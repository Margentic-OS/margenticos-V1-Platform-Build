// The Email 1 prompt carries the chosen fact and nothing else; the gate corpus stays wide.
//
// WHAT IT COST. Measured on the 105-prospect cohort, 2026-09-28: Gabriela Norton's Email 1
// shipped "PPR turns fifteen this year", a sentence nowhere in her chosen candidate. It came
// from another finding in the prompt block, because a numbered list of facts invites the writer
// to draw on all of them.
//
// THE ASYMMETRY IS THE POINT and is asserted here rather than described: the prompt narrows,
// the evidence corpus does not. Traceability asks where a phrase COULD have come from, and the
// honest answer includes everything the writer was ever shown.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect } from 'vitest'
import { narrowToChosen, buildFindingsBlock, buildFindingsEvidence } from '../write-opening'
import type { ObservationCandidate } from '../types'

function cand(id: string, observation: string, over: Partial<ObservationCandidate> = {}): ObservationCandidate {
  return {
    id, observation, date: '2026-06-01', source: 'linkedin',
    provenance: 'LinkedIn post, example.com/in/someone',
    score_total: 4, passes_all: true, matched_trigger: 3,
    ...over,
  } as unknown as ObservationCandidate
}

const CHOSEN = cand('c1', 'Northgate posted for a site manager on 2 June.')
const SUPPORT = cand('c2', 'Northgate opened a second depot in March.', { score_total: 5 })
// The one that leaked. It is the highest scoring, so any "just take the top" shortcut keeps it.
const OTHER = cand('c3', 'Northgate turns fifteen this year.', { score_total: 6 })
const ALL = [CHOSEN, SUPPORT, OTHER]

describe('the prompt sees the chosen fact and its supporting event', () => {
  it('keeps the chosen candidate alone when there is no supporting event', () => {
    expect(narrowToChosen(ALL, 'c1', null).map(c => c.id)).toEqual(['c1'])
  })

  it('keeps the chosen candidate and the supporting event, in input order', () => {
    expect(narrowToChosen(ALL, 'c1', 'c2').map(c => c.id)).toEqual(['c1', 'c2'])
  })

  it('DROPS the other findings, including a higher-scoring one', () => {
    expect(narrowToChosen(ALL, 'c1', 'c2').map(c => c.id)).not.toContain('c3')
  })

  // ─── The measured leak, end to end through the real builder ─────────────────

  it('THE CONTROL: the leaked sentence cannot appear in the prompt block', () => {
    const narrow = buildFindingsBlock(narrowToChosen(ALL, 'c1', 'c2'), { selectedCandidateId: 'c1' })
    expect(narrow).not.toContain('turns fifteen')
    // And the chosen fact is still there, so this is narrowing rather than emptying.
    expect(narrow).toContain('posted for a site manager')
  })

  it('THE NEGATIVE CONTROL: before narrowing, the same builder DID carry it', () => {
    // Without this the assertion above would also pass against a builder that emits nothing.
    const wide = buildFindingsBlock(ALL, { selectedCandidateId: 'c1' })
    expect(wide).toContain('turns fifteen')
  })

  it('THE GATE CORPUS STILL CARRIES IT, which is what keeps traceability honest', () => {
    // buildFindingsEvidence is fed the FULL array at the call site and is unchanged.
    expect(buildFindingsEvidence(ALL)).toContain('turns fifteen')
  })

  // ─── Failing safe ──────────────────────────────────────────────────────────

  it('falls back to the full list when synthesis chose nothing', () => {
    // A run with no selection is the run with least information, and an empty prompt block
    // would be a silent behaviour change on exactly that path.
    expect(narrowToChosen(ALL, null, null)).toHaveLength(3)
  })

  it('falls back to the full list when the chosen id is not in the array', () => {
    expect(narrowToChosen(ALL, 'c-missing', null)).toHaveLength(3)
  })

  it('ignores a supporting id that is not in the array, keeping the chosen one', () => {
    expect(narrowToChosen(ALL, 'c1', 'c-missing').map(c => c.id)).toEqual(['c1'])
  })

  it('CONTROL: an empty candidate list is returned unchanged, not thrown on', () => {
    expect(narrowToChosen([], 'c1', 'c2')).toEqual([])
  })
})
