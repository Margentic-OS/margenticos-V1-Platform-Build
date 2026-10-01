import type { FilterSpecField, OmittableAxis } from '@/lib/agents/icp-filter-spec'
import { exclusionKey } from '@/lib/sourcing/approve-icp-filter-spec'
import type {
  CriterionStatus,
  ExclusionSource,
  RemovedExclusion,
  SettingsDiff,
} from '@/lib/sourcing/settings-diff'

// A change to a client's search settings, in plain words. ADR-061 step 6.
//
// Pure. It turns the diff the approval is judged on into the sentences the operator reads,
// so what is on the screen is a description of the same object the floors are checked
// against, and not a second reading of the settings.
//
// ─── RULE ZERO ───────────────────────────────────────────────────────────────
//
// Every string in this file is fixed copy about the KIND of setting. Nothing here names an
// industry, a job title, a seniority band or a country. Those appear on screen only as
// values taken from the client's own settings. Country codes are turned into names by the
// runtime's own locale data, so no country is written down here either.
//
// ─── ONE LABEL PER FIELD, AND THE COMPILER COUNTS THEM ───────────────────────
//
// FIELD_LABELS is checked against the list of filter fields. A field added to the
// settings without a label is a compile error here, where the alternative is a change the
// operator approves without being shown it.

const FIELD_LABELS = {
  job_titles: 'Job titles searched',
  job_titles_excluded: 'Job titles excluded',
  seniority_levels: 'Seniority levels searched',
  person_countries: 'Countries people are in',
  company_countries: 'Countries companies are in',
  company_headcount_min: 'Smallest company size',
  company_headcount_max: 'Largest company size',
  industries: 'Industries searched',
  industries_excluded: 'Industries excluded',
  keywords: 'Company keywords searched',
  keywords_excluded: 'Company keywords excluded',
  company_revenue_min: 'Lowest company revenue',
  company_revenue_max: 'Highest company revenue',
} as const satisfies Record<FilterSpecField, string>

const AXIS_LABELS = {
  seniority_levels: 'Seniority filter',
  keywords: 'Company keyword filter',
  industries_excluded: 'Excluded industries filter',
  keywords_excluded: 'Excluded company keywords filter',
  company_revenue: 'Revenue band',
} as const satisfies Record<OmittableAxis, string>

const COUNTRY_FIELDS: ReadonlySet<FilterSpecField> = new Set(['person_countries', 'company_countries'])
const PEOPLE_FIELDS: ReadonlySet<FilterSpecField> = new Set(['company_headcount_min', 'company_headcount_max'])

const CRITERION_LABEL = 'Who we email'

export interface DescribedChange {
  /** Which setting. Fixed copy. */
  label: string
  /** What happens to it. Fixed verbs around the client's own values. */
  detail: string
}

let regionNames: Intl.DisplayNames | null | undefined
function countryName(code: string): string {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en'], { type: 'region' })
    } catch {
      regionNames = null
    }
  }
  try {
    return regionNames?.of(code) ?? code
  } catch {
    // Not a region code the runtime knows. Show what is stored rather than nothing.
    return code
  }
}

function listed(field: FilterSpecField, values: readonly string[]): string {
  const shown = COUNTRY_FIELDS.has(field)
    ? values.map(countryName)
    // Seniority bands are stored in the provider's spelling, with underscores.
    : values.map(value => value.replace(/_/g, ' '))
  return shown.join(', ')
}

function amount(field: FilterSpecField, value: number | null): string {
  if (value === null) return 'not set'
  const figure = value.toLocaleString('en-GB')
  return PEOPLE_FIELDS.has(field) ? `${figure} people` : figure
}

/** "adds a, b; removes c". Either half is left out when there is nothing in it. */
function addsAndRemoves(added: string, removed: string): string {
  return [added && `adds ${added}`, removed && `removes ${removed}`].filter(Boolean).join('; ')
}

const STATUS_WORDS = {
  derived: 'settled',
  unsettled: 'not settled by the documents',
  out_of_band: 'matching almost everyone or almost no one',
  absent: 'missing',
} as const satisfies Record<CriterionStatus, string>

/**
 * Every change in the diff, one line each, in the order the settings are listed.
 *
 * An empty result means the proposal changes nothing the settings DO.
 */
export function describeSettingsDiff(diff: SettingsDiff): DescribedChange[] {
  const lines: DescribedChange[] = []

  for (const change of diff.field_changes) {
    const label = FIELD_LABELS[change.field]
    if (change.kind === 'list') {
      lines.push({
        label,
        detail: addsAndRemoves(listed(change.field, change.added), listed(change.field, change.removed)),
      })
    } else {
      lines.push({
        label,
        detail: `changes from ${amount(change.field, change.before)} to ${amount(change.field, change.after)}`,
      })
    }
  }

  for (const axis of diff.axes_switched_off) {
    lines.push({ label: AXIS_LABELS[axis], detail: 'switched off, so it no longer narrows the search' })
  }
  for (const axis of diff.axes_switched_on) {
    lines.push({ label: AXIS_LABELS[axis], detail: 'switched on, so it narrows the search again' })
  }

  const criterion = diff.criterion
  if (criterion.changed) {
    const parts: string[] = []
    if (criterion.accept_added.length > 0) parts.push(`now also accepts ${criterion.accept_added.join(', ')}`)
    if (criterion.accept_removed.length > 0) parts.push(`no longer accepts ${criterion.accept_removed.join(', ')}`)
    if (criterion.rank_changed.length > 0) parts.push(`changes how strongly it prefers ${criterion.rank_changed.join(', ')}`)
    if (criterion.reject_added.length > 0) parts.push(`now also rejects ${criterion.reject_added.join(', ')}`)
    if (criterion.reject_removed.length > 0) parts.push(`no longer rejects ${criterion.reject_removed.join(', ')}`)
    if (criterion.status_before !== criterion.status_after) {
      parts.push(
        `goes from ${STATUS_WORDS[criterion.status_before]} to ${STATUS_WORDS[criterion.status_after]}`,
      )
    }
    if (criterion.gates_before && !criterion.gates_after) parts.push('would stop being applied to anyone')
    if (!criterion.gates_before && criterion.gates_after) parts.push('starts being applied')
    lines.push({ label: CRITERION_LABEL, detail: parts.join('; ') })
  }

  if (diff.fit_dimensions_changed) {
    lines.push({
      label: 'Research fit conditions',
      detail: 'changed. This affects how research grades fit, and never who is sourced',
    })
  }

  return lines
}

// ─── The exclusions a proposal stops applying ────────────────────────────────

export interface ExclusionTick {
  /** Every exclusionKey this one tick confirms. Sent to the approve route as they are. */
  keys: string[]
  /** What the operator is confirming. */
  label: string
}

// What each place an exclusion can live is called, to a person. A new exclusion field has
// to be named here before this compiles, so it cannot reach the screen under another
// field's wording.
const EXCLUSION_WORDING = {
  job_titles_excluded: (value: string) => `Stop excluding the job title “${value}”`,
  'buyer_criterion.reject': (value: string) => `Stop excluding the job title “${value}”`,
  industries_excluded: (value: string) => `Stop excluding the industry “${value}”`,
  keywords_excluded: (value: string) => `Stop excluding companies described as “${value}”`,
} as const satisfies Record<ExclusionSource, (value: string) => string>

const TITLE_SOURCES: ReadonlySet<ExclusionSource> = new Set(['job_titles_excluded', 'buyer_criterion.reject'])

/**
 * One tick per thing the operator would recognise as one exclusion.
 *
 * An excluded job title lives in two places: the list applied to search results, and the
 * buyer criterion's reject list. They are enforced separately and the approval requires
 * both removals to be confirmed, but to a person they are one decision, "stop excluding
 * this title". So the two are folded into one tick that confirms both keys.
 *
 * Nothing is dropped by the folding: every removed exclusion's key ends up in exactly one
 * tick. The test beside this file checks that for every shape of removal.
 */
export function describeRemovedExclusions(removed: readonly RemovedExclusion[]): ExclusionTick[] {
  const ticks: ExclusionTick[] = []
  const titleTicks = new Map<string, ExclusionTick>()

  for (const exclusion of removed) {
    const key = exclusionKey(exclusion)
    const suffix = exclusion.how === 'axis_switched_off' ? ' (the whole filter is being switched off)' : ''

    const tick = { keys: [key], label: `${EXCLUSION_WORDING[exclusion.source](exclusion.value)}${suffix}` }

    if (TITLE_SOURCES.has(exclusion.source)) {
      const existing = titleTicks.get(exclusion.value)
      if (existing) {
        existing.keys.push(key)
        continue
      }
      titleTicks.set(exclusion.value, tick)
    }
    ticks.push(tick)
  }

  return ticks
}
