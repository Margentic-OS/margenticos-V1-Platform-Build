// applyFillIfNullLogic: absent means UNKNOWN, not "safe to write".
//
// The bug this covers was silent data corruption. adapter-apollo-enrichment calls
// `applyFillIfNullLogic(payload, currentProspect || {})`, and currentProspect is null
// whenever the prospect SELECT fails. That SELECT logs and continues rather than
// aborting, so a transient database error became consent to overwrite a real surname
// with Apollo's match guess. Nothing errored, nothing logged, and the wrong name went
// out on the next send.

import { describe, it, expect } from 'vitest'
import { applyFillIfNullLogic, stripNonOwnedFields, FILL_IF_NULL_FIELDS } from '../field-ownership'

const APOLLO_GUESS = { email: 'a@b.com', last_name: 'ApolloGuess' }

describe('UNKNOWN current value blocks the fill', () => {
  it('refuses when the record is an empty object — the failed-SELECT case', () => {
    // adapter-apollo-enrichment passes `currentProspect || {}`. This is the exact shape
    // a failed SELECT produces, and it is how a real surname got overwritten.
    expect(applyFillIfNullLogic(APOLLO_GUESS, {})).not.toHaveProperty('last_name')
  })

  it('refuses when the record is null', () => {
    expect(applyFillIfNullLogic(APOLLO_GUESS, null)).not.toHaveProperty('last_name')
  })

  it('refuses when the record is undefined', () => {
    expect(applyFillIfNullLogic(APOLLO_GUESS, undefined)).not.toHaveProperty('last_name')
  })

  it('refuses when the record exists but the column was not selected', () => {
    // A partial SELECT is indistinguishable from an empty column unless we check for the
    // KEY, not just the value.
    expect(applyFillIfNullLogic(APOLLO_GUESS, { id: 'p1', email: 'x@y.com' }))
      .not.toHaveProperty('last_name')
  })

  it('refuses when the key is present but explicitly undefined', () => {
    expect(applyFillIfNullLogic(APOLLO_GUESS, { last_name: undefined }))
      .not.toHaveProperty('last_name')
  })

  it('leaves enrichment-owned fields untouched while refusing the sourced one', () => {
    // The refusal must be surgical. Blocking the whole payload would throw away the
    // email and firmographics we just paid Apollo for.
    const out = applyFillIfNullLogic({ ...APOLLO_GUESS, company_headcount: 42 }, {})
    expect(out).not.toHaveProperty('last_name')
    expect(out.email).toBe('a@b.com')
    expect(out.company_headcount).toBe(42)
  })
})

describe('KNOWN current value behaves as designed', () => {
  it('ALLOWS the fill when the current value is exactly null', () => {
    // The one permitted case: we can see the field and it is genuinely empty.
    expect(applyFillIfNullLogic(APOLLO_GUESS, { last_name: null }).last_name).toBe('ApolloGuess')
  })

  it('refuses when a real surname already exists', () => {
    expect(applyFillIfNullLogic(APOLLO_GUESS, { last_name: 'Pettit' }))
      .not.toHaveProperty('last_name')
  })

  it('refuses when the existing value is an empty string, not null', () => {
    // '' is a value someone wrote. It is not the absence of one.
    expect(applyFillIfNullLogic(APOLLO_GUESS, { last_name: '' }))
      .not.toHaveProperty('last_name')
  })
})

describe('nothing offered means nothing to decide', () => {
  it('is a no-op when the payload has no fill-if-null field', () => {
    const payload = { email: 'a@b.com' }
    expect(applyFillIfNullLogic(payload, {})).toEqual(payload)
  })

  it('is a no-op when the payload value is null', () => {
    const out = applyFillIfNullLogic({ email: 'a@b.com', last_name: null }, { last_name: null })
    expect(out.last_name).toBeNull()
  })
})

describe('the guard covers every fill-if-null field, not just last_name', () => {
  it.each(FILL_IF_NULL_FIELDS)('%s is refused when the current value is unknown', field => {
    // Parameterised so a field added to FILL_IF_NULL_FIELDS later is covered automatically
    // rather than silently inheriting the old behaviour.
    expect(applyFillIfNullLogic({ [field]: 'ApolloGuess' }, {})).not.toHaveProperty(field)
  })
})

describe('the two functions compose the way the write path uses them', () => {
  it('a refused fill cannot be reinstated by stripNonOwnedFields', () => {
    // The real call order in adapter-apollo-enrichment is applyFillIfNullLogic then
    // stripNonOwnedFields. stripNonOwnedFields lets a non-null last_name through by
    // design, so the refusal has to have already removed it.
    const afterFill = applyFillIfNullLogic(APOLLO_GUESS, {})
    expect(stripNonOwnedFields(afterFill)).not.toHaveProperty('last_name')
  })

  it('an ALLOWED fill still survives stripNonOwnedFields', () => {
    const afterFill = applyFillIfNullLogic(APOLLO_GUESS, { last_name: null })
    expect(stripNonOwnedFields(afterFill).last_name).toBe('ApolloGuess')
  })
})
