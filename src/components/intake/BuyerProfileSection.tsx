'use client'

// The buyer-targeting section of the intake questionnaire.
//
// A component of its own rather than five more entries in SECTIONS, because SECTIONS feeds
// four document-generation agents automatically and these answers are collected ahead of the
// work that reads them. src/lib/intake/buyer-profile.ts carries the full reasoning.
//
// It also needs five controls the generic renderer does not have: a list the client adds to,
// a pair of integer inputs, a fixed-set multi-select, a searchable multi-select over a closed
// list, and a field shown only when another answer takes one value. Adding five members to
// FieldType to express controls that appear in one section each would put that complexity in
// the shared renderer for every question to carry.
//
// SAVING. The whole row is written whenever one answer commits: on blur for text, immediately
// for a toggle or a list edit. The store is a single row keyed by organisation, so there is no
// per-field write to batch and a whole-row upsert is the simple thing rather than the clever
// one.
//
// RULE ZERO: no label, help text or placeholder here names an industry, job title, country,
// sector or company.

import { useState, useCallback } from 'react'
import { saveBuyerProfile } from '@/app/intake/buyer-profile-actions'
import {
  BUYER_PROFILE_QUESTIONS,
  COUNTRY_OPTIONS,
  LIST_INPUT_HINT,
  SENIORITY_OPTIONS,
  SIGNOFF_ANSWERS,
  parseHeadcount,
  type BuyerProfile,
} from '@/lib/intake/buyer-profile'
import type { ProviderSeniorityBand } from '@/lib/sourcing/handlers/provider-seniority'

const inputBase =
  'w-full px-3 py-3 text-[16px] sm:text-xs text-text-primary bg-surface-content border border-border-card rounded-[6px] focus:outline-none focus:border-brand-green-accent transition-colors'

const cardBase = 'bg-surface-card border border-border-card rounded-[10px] p-4 sm:p-5'

const pill = (selected: boolean): string =>
  [
    'px-3 py-2 text-[11px] rounded-[20px] border transition-colors min-h-[44px] touch-manipulation',
    selected
      ? 'bg-brand-green text-[#F5F0E8] border-brand-green'
      : 'bg-surface-content text-text-secondary border-border-card',
  ].join(' ')

function Label({ text, help }: { text: string; help?: string }) {
  return (
    <>
      <label className="block text-xs font-medium text-text-primary mb-1 leading-relaxed">
        {text}
      </label>
      {help && (
        <p className="text-[11px] text-text-muted mb-2 leading-relaxed">{help}</p>
      )}
    </>
  )
}

/**
 * A list the client adds to, one entry at a time.
 *
 * Entries are held as a plain array including blanks while the client is typing, and cleaned
 * on the way to the database. A row that is empty is still a row on screen, because removing
 * it as soon as it is cleared would delete the input under the cursor.
 *
 * ─── THE SHAPE OF A LIST IS STATED, NOT IMPLIED ──────────────────────────────
 *
 * This control rendered as one empty text box with "Add another" underneath, which is what a
 * paragraph question looks like in this same form, and it was read that way: the first client
 * to meet it put three answers in the first box. Three things now say list before anything is
 * typed, and the reasoning for all three is on LIST_INPUT_HINT.
 *
 * The number is rendered as its own element beside the input rather than as placeholder text
 * inside it, because placeholder text disappears the moment the client starts typing, which is
 * the exact moment they are deciding how much to put in the box.
 */
function ListInput({
  id,
  entries,
  onChange,
  onCommit,
}: {
  id: string
  entries: string[]
  onChange: (next: string[]) => void
  onCommit: () => void
}) {
  const rows = entries.length > 0 ? entries : ['']

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-text-muted leading-relaxed">{LIST_INPUT_HINT}</p>
      {rows.map((entry, index) => (
        <div key={index} className="flex gap-2 items-center">
          <span
            aria-hidden="true"
            className="w-5 shrink-0 text-[11px] text-text-muted tabular-nums text-right"
          >
            {index + 1}.
          </span>
          <input
            type="text"
            aria-label={`${id} entry ${index + 1}`}
            value={entry}
            onChange={e => {
              const next = [...rows]
              next[index] = e.target.value
              onChange(next)
            }}
            onBlur={onCommit}
            className={inputBase}
          />
          {rows.length > 1 && (
            <button
              type="button"
              aria-label={`Remove ${id} entry ${index + 1}`}
              onClick={() => {
                const next = rows.filter((_, i) => i !== index)
                onChange(next.length > 0 ? next : [''])
                onCommit()
              }}
              className="px-3 text-[11px] text-text-secondary border border-border-card rounded-[6px] min-h-[44px] touch-manipulation"
            >
              Remove
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, ''])}
        className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-brand-green border border-brand-green rounded-[6px] hover:opacity-80 transition-opacity min-h-[44px] touch-manipulation"
      >
        <span aria-hidden="true">+</span>
        Add another row
      </button>
    </div>
  )
}

/**
 * The countries this client sells into, picked from a closed list.
 *
 * ─── WHY A SEARCH BOX THAT STORES NOTHING ────────────────────────────────────
 *
 * The text in the search box is never an answer and never reaches the database. It filters the
 * options underneath it and is cleared as soon as one is picked. That is what makes the
 * failure this replaces unrepresentable rather than merely discouraged: a client who types
 * three country names separated by commas matches no option, so there is no control state in
 * which that string becomes an entry. COUNTRY_OPTIONS carries the rest of the reasoning.
 *
 * ─── WHY NOT A NATIVE <select multiple> ──────────────────────────────────────
 *
 * Forty-nine options is more than a native multiple-select shows without scrolling, it offers
 * no way to search, and selecting a second option on a desktop browser requires knowing to
 * hold a modifier key. The control that already exists in this section for a fixed set is the
 * seniority pill row, and this is the same idea with a filter in front of it because the set is
 * an order of magnitude bigger.
 */
function CountryMultiSelect({
  selected,
  onChange,
}: {
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const [query, setQuery] = useState('')

  const alreadyChosen = new Set(selected.map(name => name.toLowerCase()))
  const needle = query.trim().toLowerCase()
  const matches = COUNTRY_OPTIONS.filter(
    option =>
      !alreadyChosen.has(option.name.toLowerCase()) &&
      option.name.toLowerCase().includes(needle),
  )

  return (
    <div className="space-y-3">
      {selected.length > 0 && (
        <ul aria-label="Countries you have chosen" className="flex gap-2 flex-wrap">
          {selected.map(name => (
            <li key={name}>
              <span className="inline-flex items-center gap-1.5 px-3 py-2 text-[11px] rounded-[20px] bg-brand-green text-[#F5F0E8]">
                {name}
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  onClick={() => onChange(selected.filter(chosen => chosen !== name))}
                  className="text-[13px] leading-none touch-manipulation"
                >
                  &times;
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <input
        type="search"
        aria-label="Search for a country to add"
        placeholder="Search for a country, then pick it"
        value={query}
        onChange={e => setQuery(e.target.value)}
        className={inputBase}
      />

      {matches.length > 0 ? (
        <ul
          aria-label="Countries you can add"
          className="max-h-48 overflow-y-auto flex gap-2 flex-wrap"
        >
          {matches.map(option => (
            <li key={option.code}>
              <button
                type="button"
                onClick={() => {
                  onChange([...selected, option.name])
                  setQuery('')
                }}
                className={pill(false)}
              >
                {option.name}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-text-muted leading-relaxed">
          Nothing matches that. Countries are added one at a time: search for one and pick
          it, then search again for the next.
        </p>
      )}
    </div>
  )
}

interface BuyerProfileSectionProps {
  initialProfile: BuyerProfile
  onBack: () => void
}

export default function BuyerProfileSection({
  initialProfile,
  onBack,
}: BuyerProfileSectionProps) {
  const [profile, setProfile] = useState<BuyerProfile>(initialProfile)
  // Held as strings so a half-typed number is not coerced to 0 while the client types.
  const [minRaw, setMinRaw] = useState(
    initialProfile.buyer_headcount_min?.toString() ?? '',
  )
  const [maxRaw, setMaxRaw] = useState(
    initialProfile.buyer_headcount_max?.toString() ?? '',
  )
  const [headcountError, setHeadcountError] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)

  const persist = useCallback(async (next: BuyerProfile) => {
    const result = await saveBuyerProfile(next)
    setSaveFailed('error' in result)
  }, [])

  // Commit the current state. Taking the next profile explicitly rather than reading state
  // avoids saving the value from before the render that is still in flight.
  const commit = useCallback(
    (next: BuyerProfile) => {
      setProfile(next)
      void persist(next)
    },
    [persist],
  )

  const commitHeadcount = useCallback(
    (nextMin: string, nextMax: string) => {
      const parsed = parseHeadcount(nextMin, nextMax)
      setHeadcountError(parsed.error)
      if (parsed.error) return
      commit({
        ...profile,
        buyer_headcount_min: parsed.min,
        buyer_headcount_max: parsed.max,
      })
    },
    [commit, profile],
  )

  const toggleBand = (band: ProviderSeniorityBand) => {
    const has = profile.buyer_seniority_bands.includes(band)
    commit({
      ...profile,
      buyer_seniority_bands: has
        ? profile.buyer_seniority_bands.filter(b => b !== band)
        : [...profile.buyer_seniority_bands, band],
    })
  }

  const q = BUYER_PROFILE_QUESTIONS

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Q1 — countries, picked from a closed list rather than typed */}
      <div className={cardBase}>
        <Label text={q.countries.label} help={q.countries.helpText} />
        <CountryMultiSelect
          selected={profile.target_countries}
          onChange={next => commit({ ...profile, target_countries: next })}
        />
      </div>

      {/* Q2 — buyer headcount, two integers */}
      <div className={cardBase}>
        <Label text={q.headcount.label} help={q.headcount.helpText} />
        <div className="flex items-center gap-2">
          <input
            type="number"
            inputMode="numeric"
            min={1}
            aria-label="Buyer headcount from"
            value={minRaw}
            onChange={e => setMinRaw(e.target.value)}
            onBlur={() => commitHeadcount(minRaw, maxRaw)}
            className={inputBase}
          />
          <span className="text-[11px] text-text-muted">to</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            aria-label="Buyer headcount to"
            value={maxRaw}
            onChange={e => setMaxRaw(e.target.value)}
            onBlur={() => commitHeadcount(minRaw, maxRaw)}
            className={inputBase}
          />
        </div>
        {headcountError && (
          <p className="mt-2 text-[11px] text-[#C0392B]">{headcountError}</p>
        )}
      </div>

      {/* Q3 — job titles, then seniority */}
      <div className={cardBase}>
        <Label text={q.jobTitles.label} />
        <ListInput
          id={q.jobTitles.id}
          entries={profile.buyer_job_titles}
          onChange={next => setProfile({ ...profile, buyer_job_titles: next })}
          onCommit={() => commit(profile)}
        />

        <div className="mt-5">
          <Label text={q.seniority.label} />
          <div className="flex gap-2 flex-wrap">
            {SENIORITY_OPTIONS.map(option => (
              <button
                key={option.value}
                type="button"
                aria-pressed={profile.buyer_seniority_bands.includes(option.value)}
                onClick={() => toggleBand(option.value)}
                className={pill(profile.buyer_seniority_bands.includes(option.value))}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Q4 — whether the buyer described above can act alone.
          THE "WHO SHOULD WE EMAIL FIRST?" INPUT THAT STOOD HERE IS DELETED, not hidden. It
          collected the same answer as the job titles question and was not understood. The
          column it wrote is untouched and its stored value rides through this form unchanged,
          so nothing a client does here blanks an answer they gave before.
          THE ANSWERS ARE INVERTED relative to the question this replaces, and the pairing is
          read from SIGNOFF_ANSWERS rather than written out here. "Yes" means the buyer can
          approve alone, which is signoff_required = false. */}
      <div className={cardBase}>
        <Label text={q.signoffRequired.label} />
        <div className="flex gap-2 flex-wrap">
          {SIGNOFF_ANSWERS.map(answer => (
            <button
              key={answer.label}
              type="button"
              aria-pressed={profile.signoff_required === answer.signoffRequired}
              onClick={() =>
                commit({ ...profile, signoff_required: answer.signoffRequired })
              }
              className={pill(profile.signoff_required === answer.signoffRequired)}
            >
              {answer.label}
            </button>
          ))}
        </div>

        {/* Shown only when the client says someone else has to sign off. */}
        {profile.signoff_required === true && (
          <div className="mt-5">
            <Label text={q.signoffRole.label} help={q.signoffRole.helpText} />
            <input
              type="text"
              aria-label={q.signoffRole.label}
              value={profile.signoff_role}
              onChange={e => setProfile({ ...profile, signoff_role: e.target.value })}
              onBlur={() => commit(profile)}
              className={inputBase}
            />
          </div>
        )}
      </div>

      {/* Q5 — disqualifiers */}
      <div className={cardBase}>
        <Label text={q.disqualifiers.label} help={q.disqualifiers.helpText} />
        <ListInput
          id={q.disqualifiers.id}
          entries={profile.disqualifiers}
          onChange={next => setProfile({ ...profile, disqualifiers: next })}
          onCommit={() => commit(profile)}
        />
      </div>

      {saveFailed && (
        <p className="text-[11px] text-[#C0392B]">
          Could not save your last answer. Check your connection and try again.
        </p>
      )}

      <div className="flex justify-between mt-6 sm:mt-8">
        <button
          onClick={onBack}
          className="px-5 py-2.5 text-xs text-text-secondary border border-border-card rounded-[20px] min-h-[44px] touch-manipulation"
        >
          Back
        </button>
      </div>
    </div>
  )
}
