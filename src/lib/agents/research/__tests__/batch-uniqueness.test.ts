// Retry feedback used to say a closing question was taken without saying which ones were.
// Udo burned all three attempts re-offering questions that were already gone, and fell back
// to template with good findings unused.

import { describe, it, expect } from 'vitest'
import { BatchUniquenessRegistry } from '../batch-uniqueness'

const BRIDGE_A = 'Board dates are fixed. Selling is what moves.'
const BRIDGE_B = 'A conference fills the room once. The months after run on follow-up.'
const BRIDGE_C = 'Two roles means one calendar. Outreach is scheduled around them.'

describe('takenQuestions lists what the writer has to avoid', () => {
  it('returns nothing on an empty batch', () => {
    expect(new BatchUniquenessRegistry().takenQuestions('p1')).toEqual([])
  })

  it('returns questions reserved by other prospects, as written', () => {
    const reg = new BatchUniquenessRegistry()
    reg.reserve('p1', BRIDGE_A, 'Is pipeline consistency something you are trying to fix?')
    reg.reserve('p2', BRIDGE_B, 'Worth a look to see if it fits?')
    expect(reg.takenQuestions('p3').sort()).toEqual([
      'Is pipeline consistency something you are trying to fix?',
      'Worth a look to see if it fits?',
    ].sort())
  })

  it('excludes the asking prospect own reservation', () => {
    // A retrying prospect must not be shown its own question as an obstacle to avoid.
    const reg = new BatchUniquenessRegistry()
    reg.reserve('p1', BRIDGE_A, 'Is that a gap you are looking to close?')
    reg.reserve('p2', BRIDGE_B, 'Worth a look?')
    expect(reg.takenQuestions('p1')).toEqual(['Worth a look?'])
  })

  it('drops a question again when its attempt is released', () => {
    // A question that lost to its template never shipped, so it blocks nobody and must not
    // appear in anyone feedback as unavailable.
    const reg = new BatchUniquenessRegistry()
    reg.reserve('p1', BRIDGE_A, 'Is that a gap?')
    expect(reg.takenQuestions('p2')).toEqual(['Is that a gap?'])
    reg.release('p1')
    expect(reg.takenQuestions('p2')).toEqual([])
  })

  it('records nothing from a refused reservation', () => {
    const reg = new BatchUniquenessRegistry()
    reg.reserve('p1', BRIDGE_A, 'Is that a gap?')
    reg.reserve('p2', BRIDGE_A, 'Something else entirely?')   // bridge collides, so refused
    expect(reg.takenQuestions('p3')).toEqual(['Is that a gap?'])
  })

  it('replaces the text when a prospect re-reserves with a new question', () => {
    const reg = new BatchUniquenessRegistry()
    reg.reserve('p1', BRIDGE_A, 'First attempt question?')
    reg.reserve('p1', BRIDGE_C, 'Second attempt question?')
    expect(reg.takenQuestions('p2')).toEqual(['Second attempt question?'])
  })
})
