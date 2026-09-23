// A client changing an answer tells the operator. A client ANSWERING ONE DOES NOT.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY THE FIRST-SAVE HALF IS THE HALF WORTH TESTING
//
// The intake form saves ON BLUR, whether or not anything was typed. So a client filling the
// form in for the first time walks through every question and produces a save for each one.
// If a first answer counted as an edit, finishing intake would email the operator once per
// question and flag documents that nothing had invalidated, and an operator who is sent to
// look at documents that are fine learns to stop looking.
//
// Both paths already decided this for the staleness flagging, and the notification rides the
// SAME decision rather than making a second one: isIntakeAnswerEdit returns false for a null
// previous, and changedBuyerProfileFields returns nothing for a null previous ROW. These
// tests pin that the notification is inside that gate and not beside it.
//
// MUTATION: move either notify call outside its `if`, or hand saveBuyerProfile
// readBuyerProfile instead of readBuyerProfileRow, and the "first save" tests go red.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EMPTY_BUYER_PROFILE } from '@/lib/intake/buyer-profile'

const notify = vi.hoisted(() => vi.fn())
const flag = vi.hoisted(() => vi.fn())
const getUser = vi.hoisted(() => vi.fn())
const state = vi.hoisted(() => ({
  existingIntakeValue: null as string | null,
  buyerProfileRow: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/intake/notify-intake-edit', () => ({
  notifyOperatorOfIntakeEditSafely: notify,
}))
vi.mock('@/lib/intake/flag-stale-documents', () => ({
  flagDocumentsStaleForIntakeEditSafely: flag,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser },
    from(table: string) {
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        single: async () => {
          if (table === 'users') return { data: { organisation_id: 'org-1' }, error: null }
          throw new Error(`fake does not implement single() on ${table}`)
        },
        maybeSingle: async () => {
          if (table === 'intake_responses') {
            return state.existingIntakeValue === null
              ? { data: null }
              : { data: { response_value: state.existingIntakeValue } }
          }
          if (table === 'intake_buyer_profile') {
            return { data: state.buyerProfileRow }
          }
          throw new Error(`fake does not implement maybeSingle() on ${table}`)
        },
        upsert: async () => ({ error: null }),
      })
      return chain
    },
  }),
}))

const ORG = 'org-1'

beforeEach(() => {
  notify.mockReset()
  notify.mockResolvedValue(undefined)
  flag.mockReset()
  flag.mockResolvedValue([])
  getUser.mockReset()
  getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  state.existingIntakeValue = null
  state.buyerProfileRow = null
})

describe('saveIntakeResponse', () => {
  async function save(value: string) {
    const { saveIntakeResponse } = await import('../actions')
    return saveIntakeResponse('company_what_you_do', 'What does your company do?', value, true, 'company')
  }

  it('does NOT notify on a first answer', async () => {
    state.existingIntakeValue = null
    await save('The first answer.')
    expect(notify).not.toHaveBeenCalled()
    expect(flag).not.toHaveBeenCalled()
  })

  it('does NOT notify when the answer is re-saved unchanged', async () => {
    // The blur case. Visiting a field and leaving it is not an edit.
    state.existingIntakeValue = 'The answer.'
    await save('The answer.')
    expect(notify).not.toHaveBeenCalled()
  })

  it('does NOT notify when only whitespace changed', async () => {
    state.existingIntakeValue = 'The answer.'
    await save('  The answer.  ')
    expect(notify).not.toHaveBeenCalled()
  })

  it('DOES notify when the answer changed', async () => {
    state.existingIntakeValue = 'The old answer.'
    await save('The new answer.')

    expect(notify).toHaveBeenCalledTimes(1)
    const params = notify.mock.calls[0][0]
    expect(params.organisationId).toBe(ORG)
    expect(params.changes).toEqual([{
      fieldKey: 'company_what_you_do',
      fieldLabel: 'What does your company do?',
      previous: 'The old answer.',
      next: 'The new answer.',
    }])
  })

  it('reports what the flagging ACTUALLY flagged, not a guess', async () => {
    state.existingIntakeValue = 'The old answer.'
    flag.mockResolvedValue(['icp'])
    await save('The new answer.')
    expect(notify.mock.calls[0][0].flaggedDocumentTypes).toEqual(['icp'])
  })

  it('reports nothing flagged when nothing was, rather than inventing a document', async () => {
    state.existingIntakeValue = 'The old answer.'
    flag.mockResolvedValue([])
    await save('The new answer.')
    expect(notify.mock.calls[0][0].flaggedDocumentTypes).toEqual([])
  })

  it('names a previously empty answer rather than sending an empty quote', async () => {
    // An empty string IS a previous value: the row existed and held "". That is an edit.
    state.existingIntakeValue = ''
    await save('The new answer.')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0].changes[0].previous).toBe('(blank)')
  })
})

describe('saveBuyerProfile', () => {
  async function save(profile: Record<string, unknown>) {
    const { saveBuyerProfile } = await import('../buyer-profile-actions')
    return saveBuyerProfile({ ...EMPTY_BUYER_PROFILE, ...profile } as never)
  }

  it('does NOT notify on a first save, even when every answer is filled in', async () => {
    // THE BUG THIS PINS: comparing against EMPTY_BUYER_PROFILE instead of a null row makes
    // an absent row indistinguishable from a row of blank answers, so a client's first save
    // reports every answer they filled in as changed.
    state.buyerProfileRow = null
    await save({ buyer_job_titles: ['A title'], buyer_headcount_min: 5, buyer_headcount_max: 20 })

    expect(notify).not.toHaveBeenCalled()
  })

  it('does NOT notify when the saved answers are identical to the stored ones', async () => {
    state.buyerProfileRow = { ...EMPTY_BUYER_PROFILE, buyer_headcount_min: 5, buyer_headcount_max: 20 }
    await save({ buyer_headcount_min: 5, buyer_headcount_max: 20 })

    expect(notify).not.toHaveBeenCalled()
  })

  it('DOES notify when an answer changed, naming it from what to what', async () => {
    state.buyerProfileRow = { ...EMPTY_BUYER_PROFILE, buyer_headcount_min: 5, buyer_headcount_max: 20 }
    await save({ buyer_headcount_min: 21, buyer_headcount_max: 50 })

    expect(notify).toHaveBeenCalledTimes(1)
    const { changes } = notify.mock.calls[0][0]
    const byKey = Object.fromEntries(changes.map((c: { fieldKey: string }) => [c.fieldKey, c]))
    expect(byKey.buyer_headcount_min).toMatchObject({ previous: '5', next: '21' })
    expect(byKey.buyer_headcount_max).toMatchObject({ previous: '20', next: '50' })
  })

  it('never renders a real null as the word "null"', async () => {
    // signoff_required is boolean | null, and null means "not answered", which is a
    // different state from false. The validator refuses an email containing the word.
    state.buyerProfileRow = { ...EMPTY_BUYER_PROFILE, signoff_required: null }
    await save({ signoff_required: true })

    const { changes } = notify.mock.calls[0][0]
    expect(JSON.stringify(changes)).not.toMatch(/\bnull\b/i)
    expect(changes[0].previous).toBe('(not answered)')
    expect(changes[0].next).toBe('Yes')
  })

  it('the flagging and the notification agree on which answers moved', async () => {
    // One comparison, two consumers. Calling changedBuyerProfileFields twice would be two
    // derivations of one fact, free to disagree.
    state.buyerProfileRow = { ...EMPTY_BUYER_PROFILE, buyer_job_titles: ['Old title'] }
    await save({ buyer_job_titles: ['New title'] })

    const flaggedKeys = flag.mock.calls[0][1]
    const notifiedKeys = notify.mock.calls[0][0].changes.map((c: { fieldKey: string }) => c.fieldKey)
    expect([...notifiedKeys].sort()).toEqual([...flaggedKeys].sort())
  })
})
