// The must-fail controls of a faithfulness recheck. Pure, no model.
//
// The control's whole value is that it cannot pass by accident, so each way it used to pass
// by accident is planted here: the judge never answered, and the clause was rejected for a
// word that is not the one the control exists to catch.

import { describe, it, expect } from 'vitest'
import { controlProblems, parseMustFail } from '../firm-fact-recheck'
import type { JudgeVerdict } from '../firm-fact'

const verdict = (added: string[]): JudgeVerdict => ({
  claims: [{ claim: 'x', supported: added.length === 0 }],
  added_number: false, added_praise: false, added_claim: added.length > 0, added_concepts: added,
  customers_supported: true, peer_group_supported: true,
})

describe('parseMustFail', () => {
  it('reads each prefix with its word', () => {
    expect(parseMustFail('1a2b3c4d=Automation, 5e6f7a8b=select')).toEqual([
      { idPrefix: '1a2b3c4d', word: 'automation' },
      { idPrefix: '5e6f7a8b', word: 'select' },
    ])
    expect(parseMustFail('')).toEqual([])
  })
  it('refuses a control with no word: any rejection at all would confirm it', () => {
    expect(() => parseMustFail('1a2b3c4d=automation,9c0d')).toThrow(/needs the word its clause adds/)
    expect(() => parseMustFail('9c0d=')).toThrow(/needs the word/)
  })
  it('refuses a prefix listed twice: only its first entry would ever be read', () => {
    expect(() => parseMustFail('1a2b=automation,1a2b=select')).toThrow(/listed twice/)
  })
})

describe('controlProblems', () => {
  const failing = { word: 'automation', codeAbsent: ['automation'], judge: verdict(['automation']), judgeFaithful: false }

  it('confirms a control both gates reject for its own word (the control of the control)', () => {
    expect(controlProblems(failing)).toEqual([])
  })
  it('does NOT confirm a control when the judge gave no verdict', () => {
    // The API was down, or the key was at its limit. Read as "the judge did not pass it",
    // this printed "all controls failed both checks" and exited 0.
    expect(controlProblems({ ...failing, judge: null }).join(' ')).toContain('no verdict')
  })
  it('does not confirm a control the code check passed', () => {
    expect(controlProblems({ ...failing, codeAbsent: [] }).join(' ')).toContain('the code check passed it')
  })
  it('does not confirm a control the judge passed', () => {
    expect(controlProblems({ ...failing, judge: verdict([]), judgeFaithful: true }).join(' ')).toContain('the judge passed it')
  })
  it('does not confirm a control rejected for some OTHER word', () => {
    // The known addition has started to pass; an unrelated word keeps the clause failing.
    expect(controlProblems({ ...failing, codeAbsent: ['strategy'] }).join(' ')).toContain('not for "automation"')
    expect(controlProblems({ ...failing, judge: verdict(['strategy']) }).join(' ')).toContain('not for "automation"')
  })
  it('matches the word whatever its case', () => {
    expect(controlProblems({ ...failing, codeAbsent: ['Automation'], judge: verdict(['AUTOMATION']) })).toEqual([])
  })
  it('with no expected word, any rejection by both gates confirms it', () => {
    expect(controlProblems({ word: null, codeAbsent: ['x'], judge: verdict(['y']), judgeFaithful: false })).toEqual([])
  })
})
