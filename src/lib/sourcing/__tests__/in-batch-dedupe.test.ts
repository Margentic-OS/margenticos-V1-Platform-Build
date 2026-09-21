// removeInBatchDuplicates: collapsing one batch onto one candidate per person.
//
// The three identities here are the same three getDedupeVerdict matches on. A narrower set
// would let a pair through that the database check would have caught, which is the same
// failure one step later, so each is covered on its own.

import { describe, it, expect } from 'vitest'
import { removeInBatchDuplicates } from '@/lib/sourcing/in-batch-dedupe'

describe('removeInBatchDuplicates', () => {
  it('keeps one copy of a person repeated on two pages', () => {
    const { unique, duplicates } = removeInBatchDuplicates([
      { source_person_key: 'apollo:a' },
      { source_person_key: 'apollo:b' },
      { source_person_key: 'apollo:a' },
    ])

    expect(unique.map(c => c.source_person_key)).toEqual(['apollo:a', 'apollo:b'])
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0].reason).toBe('duplicate_in_batch_person_key')
  })

  it('keeps the FIRST copy, deterministically', () => {
    // The copies are identical by construction, so which one survives does not matter.
    // That it is always the same one does: a non-deterministic pick makes a failing run
    // impossible to reproduce.
    const first = { source_person_key: 'apollo:a', first_name: 'first' }
    const second = { source_person_key: 'apollo:a', first_name: 'second' }
    const { unique } = removeInBatchDuplicates([first, second])

    expect(unique).toHaveLength(1)
    expect(unique[0]).toBe(first)
  })

  it('collapses on LinkedIn URL even when the person keys differ', () => {
    const { unique, duplicates } = removeInBatchDuplicates([
      { source_person_key: 'apollo:a', linkedin_url: 'https://www.linkedin.com/in/someone/' },
      { source_person_key: 'apollo:b', linkedin_url: 'http://linkedin.com/in/someone' },
    ])

    // Normalised through the same function the dedupe and the write path use, so a
    // scheme, a www, a trailing slash and a query string are not three different people.
    expect(unique).toHaveLength(1)
    expect(duplicates[0].reason).toBe('duplicate_in_batch_linkedin')
  })

  it('collapses on email, case-insensitively', () => {
    const { unique, duplicates } = removeInBatchDuplicates([
      { source_person_key: 'apollo:a', email: 'Someone@Example.com' },
      { source_person_key: 'apollo:b', email: 'someone@example.com' },
    ])

    expect(unique).toHaveLength(1)
    expect(duplicates[0].reason).toBe('duplicate_in_batch_email')
  })

  it('registers every identity a kept candidate carries, not just the one checked first', () => {
    // The second candidate shares only the LinkedIn URL. If the collapse registered the
    // person key alone, it would be let through and the pair would reach the write.
    const { unique, duplicates } = removeInBatchDuplicates([
      { source_person_key: 'apollo:a', linkedin_url: 'linkedin.com/in/x', email: 'x@e.com' },
      { source_person_key: 'apollo:b', linkedin_url: 'linkedin.com/in/x' },
      { source_person_key: 'apollo:c', email: 'X@E.com' },
    ])

    expect(unique.map(c => c.source_person_key)).toEqual(['apollo:a'])
    expect(duplicates.map(d => d.reason)).toEqual([
      'duplicate_in_batch_linkedin',
      'duplicate_in_batch_email',
    ])
  })

  it('does not treat a missing identity as a shared one', () => {
    // Two people with no email must not collide on "no email". Registering an empty
    // identity would silently drop real people, which is worse than the defect this
    // function exists to fix.
    const { unique, duplicates } = removeInBatchDuplicates([
      { source_person_key: 'apollo:a', email: null, linkedin_url: null },
      { source_person_key: 'apollo:b', email: null, linkedin_url: null },
      { source_person_key: 'apollo:c', email: '', linkedin_url: '' },
    ])

    expect(unique).toHaveLength(3)
    expect(duplicates).toHaveLength(0)
  })

  it('returns an empty result for an empty batch', () => {
    const { unique, duplicates } = removeInBatchDuplicates([])
    expect(unique).toEqual([])
    expect(duplicates).toEqual([])
  })

  it('leaves a batch with no repeats untouched, in order', () => {
    const input = [
      { source_person_key: 'apollo:a' },
      { source_person_key: 'apollo:b' },
      { source_person_key: 'apollo:c' },
    ]
    const { unique, duplicates } = removeInBatchDuplicates(input)

    expect(unique).toEqual(input)
    expect(duplicates).toEqual([])
  })
})
