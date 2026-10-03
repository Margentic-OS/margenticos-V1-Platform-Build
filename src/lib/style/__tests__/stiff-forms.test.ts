// The written-out pair is the plainest mark of a stiff line. Every check has a planted
// failure and a passing control.

import { describe, it, expect } from 'vitest'
import { findStiffForms } from '../stiff-forms'

const found = (text: string) => findStiffForms(text).map(f => `${f.found.toLowerCase()} -> ${f.write}`)

describe('findStiffForms', () => {
  it('PLANTED: the break-up the operator refused holds two', () => {
    expect(found('It is fine if this is not a fit right now.')).toEqual(["it is -> it's", "is not -> isn't"])
  })

  it.each([
    ['We are glad to talk when the time is right.', "we are -> we're"],
    ['That is when growth can stall.', "that is -> that's"],
    ['Some firms do not hear from the right buyers.', "do not -> don't"],
    ['A firm cannot grow on one channel.', "cannot -> can't"],
    ['You will see who we write to.', "you will -> you'll"],
    ['There is a short way to find out.', "there is -> there's"],
    ['We have helped firms in your field.', "we have -> we've"],
  ])('PLANTED: "%s"', (text, expected) => {
    expect(found(text)).toContain(expected)
  })

  it.each([
    "No worries if now's not the time.",
    "It's fine if this isn't a fit right now.",
    "We're glad to talk when the time's right.",
    "Some firms don't hear from the right buyers.",
    'Is new client flow hard to predict?',
    'Are there fewer conversations with buyers than you need?',
    'We learn who fits and book first meetings, so you keep winning the right clients.',
    // "we have" as a plain verb does not contract in writing.
    'We have a short way to show this.',
    // "Let us know" does not contract, and "let's" is a different sentence. Until
    // 2026-10-02 this was refused and the writer was told to write "let's know".
    'If that changes, let us know and we can pick this up.',
    'Let us know if that changes.',
    // Inside a wh-clause the pair does not contract.
    'We ask what it is that slows pay runs.',
    'Buyers want to know who we are before they reply.',
  ])('"%s" holds none (control)', text => {
    expect(found(text)).toEqual([])
  })

  it('does not ask for a contraction where English has none: at the end of a clause', () => {
    expect(found('We can leave it as it is.')).toEqual([])
    expect(found('If it is, we are happy to help.')).toEqual(["we are -> we're"])
  })

  it('reads a curly apostrophe as an apostrophe', () => {
    expect(found('It’s fine if now’s not the time.')).toEqual([])
  })
})
