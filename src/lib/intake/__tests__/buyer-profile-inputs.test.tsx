// @vitest-environment jsdom
//
// THE FOUR CONTROLS THAT PRODUCED UNUSABLE DATA ON FIRST CONTACT WITH A REAL CLIENT.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT WAS MEASURED, AND WHY EACH TEST BELOW IS SHAPED THE WAY IT IS
//
// Read from production on 2026-09-20, one organisation, the only one to have answered these
// questions. Three of the five answers were unusable, and none of the three failed in a way
// anything would have reported:
//
//   target_countries   one entry holding three country names in one string. Resolves to no
//                      country, and the geography derivation REFUSES a name it cannot
//                      resolve, so the failure would have surfaced days later attached to a
//                      sourcing run.
//   buyer_job_titles   one entry holding five titles in one string, one misspelled.
//   signoff_required   true, with both role fields empty.
//
// The countries and the titles are the SAME defect in two places: a control whose shape was
// not legible, met by a person who reasonably read one empty box as taking the whole answer.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THESE TESTS ASSERT ON STRUCTURE RATHER THAN ON WORDING WHERE THEY CAN
//
// "The copy is present" is a weak assertion: it passes over a control that renders the right
// sentence above the wrong behaviour. So the wording tests below are deliberately the SMALL
// half, and they assert on the exported constant rather than on a copy of the string, so a
// reworded question fails in one place rather than in two.
//
// The load-bearing tests are the structural ones: what ends up in the array, and what cannot
// be made to end up in it by any sequence of interactions the control permits.
//
// EVERY TEST HERE WAS MUTATION-PROVED. Each one names the mutation it survives.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import {
  BUYER_PROFILE_QUESTIONS,
  COUNTRY_OPTIONS,
  EMPTY_BUYER_PROFILE,
  LIST_INPUT_HINT,
  SIGNOFF_ANSWERS,
  normaliseCountries,
  type BuyerProfile,
} from '@/lib/intake/buyer-profile'
import { buyerProfileToRow } from '@/lib/intake/buyer-profile-store'
import { toIso2CountryCode, knownIso2CountryCodes } from '@/lib/sourcing/country-code'

// The server action is the only thing this component reaches for. Intercepted so each save
// is inspectable: the assertions below are about WHAT GETS SAVED, which is the question the
// production row failed, and reading component state instead would not answer it.
const saved: BuyerProfile[] = []
vi.mock('@/app/intake/buyer-profile-actions', () => ({
  saveBuyerProfile: async (profile: BuyerProfile) => {
    saved.push(profile)
    return { success: true as const }
  },
}))

// Imported after the mock is registered.
const { default: BuyerProfileSection } = await import(
  '@/components/intake/BuyerProfileSection'
)

afterEach(() => {
  cleanup()
  saved.length = 0
})

function renderSection(profile: Partial<BuyerProfile> = {}) {
  return render(
    <BuyerProfileSection
      initialProfile={{ ...EMPTY_BUYER_PROFILE, ...profile }}
      onBack={() => {}}
    />,
  )
}

/** The most recent save, which is what the database would hold. */
function lastSavedRow(): Record<string, unknown> {
  expect(saved.length, 'nothing was saved').toBeGreaterThan(0)
  return buyerProfileToRow(saved[saved.length - 1])
}

// Two real countries, read from the platform's own list rather than named here, so this file
// states no country of its own and cannot drift from the table. Rule Zero: the list is the
// platform's jurisdiction vocabulary, and picking two arbitrary members of it asserts nothing
// about any client.
const FIRST = COUNTRY_OPTIONS[0]
const SECOND = COUNTRY_OPTIONS[1]

// ─── 1. The multi-select stores one country per entry ────────────────────────

describe('the countries control stores one country per entry', () => {
  it('two picks become two entries, not one', () => {
    // THE HEADLINE. The production row held one entry naming three countries; this is the
    // same interaction done through the new control, and the array length is the answer.
    //
    // MUTATION-PROVED: changing the pick handler to
    //   onChange([...selected.slice(0, -1), `${selected.at(-1)}, ${option.name}`])
    // (a control that joins picks into one entry, which is the shape of the live defect)
    // makes this fail on the length assertion.
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: FIRST.name }))
    fireEvent.click(screen.getByRole('button', { name: SECOND.name }))

    expect(lastSavedRow().target_countries).toEqual([FIRST.name, SECOND.name])
    expect(lastSavedRow().target_countries).toHaveLength(2)
  })

  it('every stored entry resolves to exactly one country code', () => {
    // The property that actually matters downstream, asserted on the stored value rather than
    // on the number of entries: the geography derivation throws on a name it cannot resolve.
    //
    // MUTATION-PROVED: same mutation as above. The joined entry resolves to null and this
    // fails on the first assertion.
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: FIRST.name }))
    fireEvent.click(screen.getByRole('button', { name: SECOND.name }))

    const stored = lastSavedRow().target_countries as string[]
    for (const entry of stored) {
      expect(toIso2CountryCode(entry), `"${entry}" resolves to no country`).toMatch(
        /^[A-Z]{2}$/,
      )
    }
    // Distinct countries, not one country twice.
    expect(new Set(stored.map(e => toIso2CountryCode(e))).size).toBe(stored.length)
  })

  it('a chosen country can be removed again', () => {
    // Because the live row has to be fixable from the form after it is repaired in the
    // database, and because an un-removable chip is a control a client cannot correct.
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: FIRST.name }))
    fireEvent.click(screen.getByRole('button', { name: `Remove ${FIRST.name}` }))

    expect(lastSavedRow().target_countries).toEqual([])
  })

  it('offers every country the platform recognises and no others', () => {
    // Anti-vacuity for the tests above: they pick from COUNTRY_OPTIONS, so a COUNTRY_OPTIONS
    // that had quietly become a two-entry list would leave them passing over a broken control.
    expect(COUNTRY_OPTIONS.length).toBe(knownIso2CountryCodes().size)
    expect(COUNTRY_OPTIONS.length).toBeGreaterThan(40)
    expect(new Set(COUNTRY_OPTIONS.map(o => o.code)).size).toBe(COUNTRY_OPTIONS.length)
  })

  it('every offered option round-trips to its own code', () => {
    // The seam between the two modules, tested as a PAIR rather than each side alone. An
    // option offered here and unresolvable by the geography derivation is a filter-spec
    // failure days later, and both sides would pass their own tests.
    //
    // MUTATION-PROVED: dropping titleCase from selectableCountries (so options come back
    // upper case) still passes, correctly, because the lookup uppercases. Removing the
    // isAbbreviation guard does NOT fail this either, for the same reason. What does fail it
    // is appending any name the alias table has no entry for, which is the real risk.
    for (const option of COUNTRY_OPTIONS) {
      expect(toIso2CountryCode(option.name), `${option.name} does not resolve`).toBe(
        option.code,
      )
    }
  })
})

// ─── 2. A comma-separated string cannot become one entry ─────────────────────

describe('a comma-separated string cannot be stored as one entry', () => {
  it('typing one into the search box matches no country and stores nothing', () => {
    // The exact string from production, reconstructed from the platform's own list so this
    // file names no country. Typing it is permitted, because it is a search box; what is
    // being asserted is that no option appears to pick, so there is no way to commit it.
    //
    // MUTATION-PROVED: giving the search box an onKeyDown that pushes the raw query as an
    // entry on Enter (a "free text fallback", the obvious well-meaning addition) makes the
    // combined string storable and this test fails on the saved value.
    renderSection()

    const combined = `${FIRST.name}, ${SECOND.name}`
    const search = screen.getByLabelText('Search for a country to add')
    fireEvent.change(search, { target: { value: combined } })

    // No option matches, so the only thing on screen is the sentence explaining why.
    expect(screen.queryByRole('button', { name: combined })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Countries you can add')).not.toBeInTheDocument()
    expect(screen.getByText(/added one at a time/i)).toBeInTheDocument()

    // And nothing was saved by typing it.
    expect(saved).toHaveLength(0)
  })

  it('the write path refuses a combined string even when the control is bypassed', () => {
    // A server action is a public entry point. The control is one layer and this is the other,
    // so a request that never went through a browser cannot store what the browser cannot.
    //
    // MUTATION-PROVED: reverting buyerProfileToRow's countries line to normaliseList (what it
    // was before this change) makes the combined string survive and this fails.
    const row = buyerProfileToRow({
      ...EMPTY_BUYER_PROFILE,
      target_countries: [`${FIRST.name}, ${SECOND.name}`],
    })
    expect(row.target_countries).toEqual([])
  })

  it('splits nothing and invents nothing: it keeps only what already names one country', () => {
    // Stating the boundary deliberately. This function does NOT parse a combined string into
    // its parts. Guessing a delimiter is how the EAV store got a parser on the read side, and
    // a value that was three answers in one box is a question to re-ask, not one to infer.
    expect(normaliseCountries([`${FIRST.name}, ${SECOND.name}`])).toEqual([])
    expect(normaliseCountries([FIRST.name, SECOND.name])).toEqual([FIRST.name, SECOND.name])
  })

  it('canonicalises an alias and deduplicates by country, not by spelling', () => {
    // Two spellings of one country are one answer. Deduplicating on the string would store
    // both and give a list whose length is not the number of countries.
    //
    // MUTATION-PROVED: keying the map on the trimmed string instead of the code returns two
    // entries and this fails.
    expect(normaliseCountries([FIRST.name.toLowerCase(), FIRST.code])).toEqual([FIRST.name])
  })

  it('the positive control: normaliseCountries does accept a real country', () => {
    // Without this, every assertion above passes against a function that returns [] for
    // everything. A check that returns nothing has told you it answered, not that the world
    // is empty.
    expect(normaliseCountries([FIRST.name])).toEqual([FIRST.name])
  })
})

// ─── 3. The sign-off field shows only when it is needed ──────────────────────

describe('the sign-off follow-up appears only when someone else has to sign off', () => {
  const canApproveAlone = SIGNOFF_ANSWERS.find(a => !a.signoffRequired)!
  const needsSignoff = SIGNOFF_ANSWERS.find(a => a.signoffRequired)!

  it('is absent before the question is answered', () => {
    renderSection()
    expect(screen.queryByLabelText(BUYER_PROFILE_QUESTIONS.signoffRole.label))
      .not.toBeInTheDocument()
  })

  it('is absent when the buyer can approve alone', () => {
    // MUTATION-PROVED: changing the render condition from `=== true` to `!== null` shows the
    // field here and this fails.
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: canApproveAlone.label }))
    expect(screen.queryByLabelText(BUYER_PROFILE_QUESTIONS.signoffRole.label))
      .not.toBeInTheDocument()
  })

  it('appears when the client says someone else has to sign off', () => {
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: needsSignoff.label }))
    expect(screen.getByLabelText(BUYER_PROFILE_QUESTIONS.signoffRole.label))
      .toBeInTheDocument()
  })

  it('THE POLARITY: answering yes stores that sign-off is NOT required', () => {
    // The question was inverted by this change and the storage was not. Getting this backwards
    // is invisible on screen and tells the ICP prompt the opposite of what the client said.
    //
    // MUTATION-PROVED: swapping the two booleans in SIGNOFF_ANSWERS fails this and the next
    // test, and fails nothing else in the suite, which is exactly why both directions are
    // asserted here rather than one.
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: canApproveAlone.label }))
    expect(lastSavedRow().signoff_required).toBe(false)
  })

  it('THE POLARITY, the other way: needing sign-off stores true', () => {
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: needsSignoff.label }))
    expect(lastSavedRow().signoff_required).toBe(true)
  })

  it('the two answers are a yes and a no, so the pair above is not one answer twice', () => {
    // Anti-vacuity: both tests above use `.find()`, and a SIGNOFF_ANSWERS holding two entries
    // with the same boolean would make one of them silently assert on undefined.
    expect(SIGNOFF_ANSWERS).toHaveLength(2)
    expect(SIGNOFF_ANSWERS.map(a => a.signoffRequired).sort()).toEqual([false, true])
  })
})

// ─── 4. The question that asked the same thing twice is gone ─────────────────

describe('the first-contact question is deleted, and its column is untouched', () => {
  it('no control collects it', () => {
    // MUTATION-PROVED: restoring the input fails this.
    renderSection({ first_contact_role: 'a value stored before this change' })
    expect(screen.queryByLabelText(/email first/i)).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('a value stored before this change'))
      .not.toBeInTheDocument()
  })

  it('is not a question any more', () => {
    const ids = Object.values(BUYER_PROFILE_QUESTIONS).map(q => q.id)
    expect(ids).not.toContain('first_contact_role')
  })

  it('a save does not blank a value the column already holds', () => {
    // The conservative half, and the one a hidden field gets wrong. Deleting the control must
    // not turn every subsequent save into an erase of an answer given before the change.
    //
    // MUTATION-PROVED: dropping first_contact_role from the component's state round-trip
    // (initialising it to '') makes the saved value empty and this fails.
    renderSection({ first_contact_role: 'a value stored before this change' })
    fireEvent.click(screen.getByRole('button', { name: FIRST.name }))
    expect(lastSavedRow().first_contact_role).toBe('a value stored before this change')
  })
})

// ─── 5. The reworded copy is present, read from the constants ────────────────

describe('the reworded questions say what was asked for', () => {
  it('the sign-off question hangs off the buyer already described', () => {
    renderSection()
    expect(
      screen.getByText(BUYER_PROFILE_QUESTIONS.signoffRequired.label),
    ).toBeInTheDocument()
    expect(BUYER_PROFILE_QUESTIONS.signoffRequired.label)
      .toBe('Can the person you just described approve this spend on their own?')
  })

  it('the sign-off follow-up asks whose, and says it will not be emailed', () => {
    renderSection({ signoff_required: true })
    expect(BUYER_PROFILE_QUESTIONS.signoffRole.label).toBe('Whose?')
    expect(screen.getByText(BUYER_PROFILE_QUESTIONS.signoffRole.helpText!))
      .toBeInTheDocument()
    expect(BUYER_PROFILE_QUESTIONS.signoffRole.helpText)
      .toContain('We will not email that person')
    expect(BUYER_PROFILE_QUESTIONS.signoffRole.helpText)
      .toContain('has to make the case internally')
  })

  it('the disqualifier question is asked as the wasted meeting', () => {
    renderSection()
    expect(BUYER_PROFILE_QUESTIONS.disqualifiers.label).toBe(
      'What would make you sit in a booked meeting and think, this was a waste of my time?',
    )
    expect(BUYER_PROFILE_QUESTIONS.disqualifiers.helpText).toBe(
      'Whatever you put here becomes a rule we apply before a name ever reaches you.',
    )
    expect(screen.getByText(BUYER_PROFILE_QUESTIONS.disqualifiers.label)).toBeInTheDocument()
    expect(screen.getByText(BUYER_PROFILE_QUESTIONS.disqualifiers.helpText!))
      .toBeInTheDocument()
  })

  it('the old disqualifier help, which led with examples, is gone', () => {
    // It opened "For example:" and then named a sector and a competitor, which is the thing
    // Rule Zero exists to stop and which the rewrite removes.
    renderSection()
    expect(screen.queryByText(/for example/i)).not.toBeInTheDocument()
  })
})

// ─── 6. A list looks like a list before anything is typed ────────────────────

describe('the shape of a list is visible without interacting with it', () => {
  it('says so above the first row', () => {
    // MUTATION-PROVED: removing the hint paragraph from ListInput fails this.
    renderSection()
    expect(screen.getAllByText(LIST_INPUT_HINT).length).toBeGreaterThan(0)
  })

  it('numbers the rows, so one row visibly means one answer', () => {
    // MUTATION-PROVED: removing the number span fails this.
    const { container } = renderSection({ disqualifiers: ['one', 'two', 'three'] })
    const numbers = Array.from(container.querySelectorAll('span[aria-hidden="true"]'))
      .map(n => n.textContent)
    expect(numbers).toEqual(expect.arrayContaining(['1.', '2.', '3.']))
  })

  it('the add button names what it produces', () => {
    // "Add another" did not say another WHAT, and was read as an afterthought.
    renderSection()
    expect(screen.getAllByRole('button', { name: /add another row/i }).length)
      .toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /^Add another$/ })).not.toBeInTheDocument()
  })

  it('applies to every list still rendered as one, not just to one of them', () => {
    // The instruction was "wherever one is used". Counted rather than assumed: the hint is
    // rendered once per ListInput, and the job titles and disqualifier questions are both
    // still ListInputs. Countries is no longer one, which is why this is 2 and not 3.
    renderSection()
    expect(screen.getAllByText(LIST_INPUT_HINT)).toHaveLength(2)
  })

  it('the countries question is no longer a free-text list at all', () => {
    // The strongest statement available about the original defect: the control that produced
    // it is not on the page any more.
    renderSection()
    expect(screen.queryByLabelText('target_countries entry 1')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Search for a country to add')).toBeInTheDocument()
  })
})
