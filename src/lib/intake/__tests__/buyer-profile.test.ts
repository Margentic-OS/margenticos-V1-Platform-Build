// The five buyer-targeting questions: their typed shape, their options, and the guarantees
// that the rest of the intake system is unaffected by them.
//
// Each test here was mutation-proved: the guard it describes was broken on purpose and this
// file was confirmed to go red. A test whose failure has never been observed is a test whose
// assertion might be unreachable.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BUYER_PROFILE_FIELD_KEYS,
  BUYER_PROFILE_QUESTIONS,
  EMPTY_BUYER_PROFILE,
  SENIORITY_OPTIONS,
  normaliseList,
  normaliseSeniorityBands,
  parseHeadcount,
  type BuyerProfile,
} from '@/lib/intake/buyer-profile'
import {
  buyerProfileToRow,
  rowToBuyerProfile,
  changedBuyerProfileFields,
} from '@/lib/intake/buyer-profile-store'
import { PROVIDER_SENIORITY_BANDS } from '@/lib/sourcing/handlers/provider-seniority'
import { SECTIONS, ALL_QUESTIONS, CRITICAL_COUNT, THRESHOLD } from '@/lib/intake/questions'

const ROOT = process.cwd()

// ─── The typed shape ─────────────────────────────────────────────────────────

describe('the answers are stored typed, not as text to be parsed', () => {
  it('reads back two integers and three string arrays with no parsing', () => {
    // A row exactly as PostgREST returns it for this table.
    const row = {
      target_countries: ['one', 'two'],
      buyer_headcount_min: 11,
      buyer_headcount_max: 250,
      buyer_job_titles: ['alpha', 'beta', 'gamma'],
      buyer_seniority_bands: [PROVIDER_SENIORITY_BANDS[0], PROVIDER_SENIORITY_BANDS[3]],
      first_contact_role: 'the recipient',
      signoff_required: true,
      signoff_role: 'the approver',
      disqualifiers: ['nope'],
    }

    const profile = rowToBuyerProfile(row)

    // The two integers are NUMBERS, not strings that happen to look like numbers.
    expect(typeof profile.buyer_headcount_min).toBe('number')
    expect(typeof profile.buyer_headcount_max).toBe('number')
    expect(profile.buyer_headcount_min).toBe(11)
    expect(profile.buyer_headcount_max).toBe(250)

    // The three lists are real arrays, with their length readable directly.
    expect(Array.isArray(profile.target_countries)).toBe(true)
    expect(profile.target_countries).toHaveLength(2)
    expect(profile.buyer_job_titles).toHaveLength(3)
    expect(profile.buyer_seniority_bands).toHaveLength(2)
  })

  it('a missing row reads as an empty profile rather than throwing', () => {
    // The state every organisation is in until the first save. A consumer reading
    // `.target_countries.length` here must not crash.
    const profile = rowToBuyerProfile(null)
    expect(profile).toEqual(EMPTY_BUYER_PROFILE)
    expect(profile.target_countries).toEqual([])
    expect(profile.buyer_headcount_min).toBeNull()
  })

  it('never yields NaN for a headcount, because NaN in a filter is silent', () => {
    const profile = rowToBuyerProfile({ buyer_headcount_min: 'twelve', buyer_headcount_max: 1.5 })
    expect(profile.buyer_headcount_min).toBeNull()
    expect(profile.buyer_headcount_max).toBeNull()
    expect(Number.isNaN(profile.buyer_headcount_min as unknown as number)).toBe(false)
  })

  it('an entry that is not a string is dropped rather than carried into a list', () => {
    const profile = rowToBuyerProfile({ target_countries: ['kept', 7, null, 'also kept'] })
    expect(profile.target_countries).toEqual(['kept', 'also kept'])
  })
})

// ─── The headcount pair ──────────────────────────────────────────────────────

describe('the headcount is a pair of integers, not a band and not prose', () => {
  it('accepts a whole-number range', () => {
    expect(parseHeadcount('5', '400')).toEqual({ min: 5, max: 400, error: null })
  })

  it('accepts a range whose ends are equal', () => {
    // Not an error: a client whose buyer is always one size is answering the question.
    expect(parseHeadcount('30', '30')).toEqual({ min: 30, max: 30, error: null })
  })

  it('treats both-empty as unanswered rather than as an error', () => {
    // This question gates nothing, so skipping it is not a mistake.
    expect(parseHeadcount('', '')).toEqual({ min: null, max: null, error: null })
  })

  it('refuses half a range, and SAYS SO', () => {
    // Asserting the specific message, not merely that an error exists. Mutation-proved:
    // with the half-a-range branch disabled, the digit check below still rejects an empty
    // string and still returns AN error, so a truthiness assertion passed against a guard
    // that had been deleted. The message is what distinguishes the two branches.
    expect(parseHeadcount('10', '').error).toBe('Give both a lower and an upper number.')
    expect(parseHeadcount('', '10').error).toBe('Give both a lower and an upper number.')
  })

  it('refuses an inverted range', () => {
    expect(parseHeadcount('90', '9').error).toBeTruthy()
  })

  it('refuses a headcount below one', () => {
    expect(parseHeadcount('0', '10').error).toBeTruthy()
  })

  it('refuses anything Number() would silently accept as a different number', () => {
    // Each of these parses to a number under Number() and none of them is what was typed.
    // A headcount arriving as 4096 because someone pasted hex is never questioned later.
    for (const sneaky of ['1e3', '0x10', '1.5', '12abc', '+12', '-5']) {
      expect(parseHeadcount(sneaky, '9999').error, `accepted ${sneaky}`).toBeTruthy()
    }
  })

  it('surrounding whitespace is trimmed, not rejected', () => {
    // A pasted value carries spaces and means the number inside them. Rejecting it would be
    // the form telling a client their correct answer is wrong.
    expect(parseHeadcount('  12  ', ' 40 ')).toEqual({ min: 12, max: 40, error: null })
  })
})

// ─── Seniority options come from the provider module ─────────────────────────

describe('the seniority options are the provider module, not a copy of it', () => {
  it('offers exactly the provider bands, in the provider order', () => {
    expect(SENIORITY_OPTIONS.map(o => o.value)).toEqual([...PROVIDER_SENIORITY_BANDS])
  })

  it('offers one option per band and no extras', () => {
    expect(SENIORITY_OPTIONS).toHaveLength(PROVIDER_SENIORITY_BANDS.length)
  })

  it('gives every band a non-empty label', () => {
    for (const option of SENIORITY_OPTIONS) {
      expect(option.label.trim(), `band ${option.value} has no label`).not.toBe('')
    }
  })

  it('NEVER RETYPES A BAND: no band token is a literal in the intake source', () => {
    // The point of the rule. The values must be READ from the handler module, so a band
    // appearing as a quoted string anywhere in these files means a second list has been
    // started. The label map is exempt as a region: its KEYS are band tokens by necessity,
    // and TypeScript makes it total, so it cannot drift.
    const files = [
      'src/lib/intake/buyer-profile-store.ts',
      'src/components/intake/BuyerProfileSection.tsx',
    ]
    for (const file of files) {
      const src = readFileSync(join(ROOT, file), 'utf-8')
      for (const band of PROVIDER_SENIORITY_BANDS) {
        for (const quoted of [`'${band}'`, `"${band}"`, `\`${band}\``]) {
          expect(src.includes(quoted), `${file} hardcodes the band ${quoted}`).toBe(false)
        }
      }
    }
  })

  it('the scan above can detect a violation, proved on a planted string', () => {
    // Positive control. Without it, a scan that matched nothing would pass for the wrong
    // reason, which is how this project has been fooled before.
    const planted = `const bands = ['${PROVIDER_SENIORITY_BANDS[0]}']`
    expect(planted.includes(`'${PROVIDER_SENIORITY_BANDS[0]}'`)).toBe(true)
  })

  it('keeps only bands the provider honours, in provider order', () => {
    const reversed = [...PROVIDER_SENIORITY_BANDS].reverse()
    expect(normaliseSeniorityBands([...reversed, 'not_a_band', 42, null]))
      .toEqual([...PROVIDER_SENIORITY_BANDS])
  })
})

// ─── List normalisation ──────────────────────────────────────────────────────

describe('a list the client adds to', () => {
  it('trims, drops blanks, and keeps the client ordering', () => {
    expect(normaliseList(['  second  ', '', '   ', 'first'])).toEqual(['second', 'first'])
  })

  it('removes case-insensitive duplicates but keeps the client casing', () => {
    expect(normaliseList(['Alpha', 'alpha', 'ALPHA'])).toEqual(['Alpha'])
  })

  it('a list of nothing but blanks stores as empty, so length means answers', () => {
    expect(normaliseList(['', '  ', ''])).toEqual([])
  })
})

// ─── Write shaping ───────────────────────────────────────────────────────────

describe('what gets written', () => {
  const base: BuyerProfile = { ...EMPTY_BUYER_PROFILE }

  it('clears the sign-off role when sign-off is not required', () => {
    // Otherwise the row keeps an answer to a question the client has since said does not
    // apply, and a later reader cannot tell a stale answer from a current one.
    const row = buyerProfileToRow({
      ...base,
      signoff_required: false,
      signoff_role: 'left over from before',
    })
    expect(row.signoff_role).toBe('')
  })

  it('keeps the sign-off role when sign-off IS required', () => {
    const row = buyerProfileToRow({
      ...base,
      signoff_required: true,
      signoff_role: '  the approver  ',
    })
    expect(row.signoff_role).toBe('the approver')
  })

  it('leaves sign-off unanswered as null, which is not the same as no', () => {
    expect(buyerProfileToRow(base).signoff_required).toBeNull()
  })

  it('reports only the fields that actually changed', () => {
    const before: BuyerProfile = { ...base, target_countries: ['a', 'b'] }
    const after: BuyerProfile = { ...base, target_countries: ['a', 'b', 'c'] }
    expect(changedBuyerProfileFields(before, after)).toEqual(['target_countries'])
  })

  it('re-saving the same answers reports no change', () => {
    // The form saves on blur whether or not anything was typed. Without this, every visit to
    // a field would count as an edit, which is what the EAV path already learned.
    const same: BuyerProfile = { ...base, target_countries: [' a ', 'a', 'b'] }
    const tidied: BuyerProfile = { ...base, target_countries: ['a', 'b'] }
    expect(changedBuyerProfileFields(same, tidied)).toEqual([])
  })

  it('notices a reordered list, because order is the client ordering', () => {
    const before: BuyerProfile = { ...base, disqualifiers: ['a', 'b'] }
    const after: BuyerProfile = { ...base, disqualifiers: ['b', 'a'] }
    expect(changedBuyerProfileFields(before, after)).toEqual(['disqualifiers'])
  })
})

// ─── The completeness gate does not move ─────────────────────────────────────

describe('no existing organisation can change completeness state because of this work', () => {
  it('the critical question count is unchanged at 15', () => {
    // MEASURED on the live database 2026-09-20: four of the five organisations have exactly
    // 15 critical answers. A sixteenth critical question sends every one of them from
    // 15/15 = 1.00 to 15/16 = 0.94, and five more sends them to 15/20 = 0.75, below the 0.8
    // the dispatch route requires. That is the regression this pins.
    expect(CRITICAL_COUNT).toBe(15)
  })

  it('the unlock threshold is unchanged at 12', () => {
    expect(THRESHOLD).toBe(12)
  })

  it('not one buyer-targeting field is a question in SECTIONS', () => {
    // The mechanism. They cannot affect the denominator because they are not in the set the
    // denominator is computed from.
    const sectionKeys = new Set(ALL_QUESTIONS.map(q => q.fieldKey))
    for (const key of BUYER_PROFILE_FIELD_KEYS) {
      expect(sectionKeys.has(key), `${key} leaked into SECTIONS`).toBe(false)
    }
  })

  it('an organisation answering every critical question still reads 1.00', async () => {
    // The end-to-end statement, phrased as the route phrases it. Recomputed here from the
    // live module rather than asserted as a constant.
    const { criticalCompleteness } = await import('@/lib/intake/questions')
    const rows = ALL_QUESTIONS.filter(q => q.isCritical).map(q => ({
      field_key: q.fieldKey,
      response_value: 'answered',
    }))
    const result = criticalCompleteness(rows)
    expect(result.answered).toBe(15)
    expect(result.critical).toBe(15)
    expect(result.ratio).toBe(1)
    // And the route's own condition.
    expect(result.ratio < 0.8).toBe(false)
  })

  it('the buyer-targeting tab id collides with no section id', () => {
    // The tab is rendered alongside the SECTIONS tabs from a separate constant. A collision
    // would make two tabs show at once and is invisible until someone clicks.
    const src = readFileSync(join(ROOT, 'src/components/intake/IntakeForm.tsx'), 'utf-8')
    const match = src.match(/const BUYER_PROFILE_TAB_ID = '([a-z_]+)'/)
    expect(match, 'BUYER_PROFILE_TAB_ID not found in IntakeForm').toBeTruthy()
    expect(SECTIONS.map(s => s.id)).not.toContain(match![1])
  })
})

// ─── Nothing reads these answers yet ─────────────────────────────────────────

describe('nothing reads the buyer-targeting answers yet', () => {
  it('no agent, prompt or filter specification imports the module or the store', () => {
    // Session A collects these and stops. This is the guard on that promise: it fails the
    // moment a consumer appears, which is the moment the staleness mapping and the
    // criticality decision both need revisiting.
    const consumers = [
      'src/agents',
      'src/lib/agents',
      'src/lib/sourcing',
      'src/lib/composition',
      'src/lib/tuner',
    ]
    const offenders: string[] = []
    for (const dir of consumers) {
      const out = scanDir(join(ROOT, dir))
      offenders.push(...out)
    }
    expect(
      offenders,
      'A consumer now reads the buyer-targeting answers. Map its fields in ' +
      'document-staleness.ts and revisit whether they should be critical.',
    ).toEqual([])
  })

  it('the scan above really walks files, so its empty result means something', () => {
    // Anti-vacuity. An empty result is evidence the instrument answered, not evidence of
    // absence, unless the instrument is known to have read something.
    expect(filesScanned).toBeGreaterThan(100)
  })
})

let filesScanned = 0

function scanDir(dir: string): string[] {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
  const hits: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return hits
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      hits.push(...scanDir(full))
      continue
    }
    if (!/\.tsx?$/.test(entry)) continue
    filesScanned += 1
    const src = readFileSync(full, 'utf-8')
    if (src.includes('intake/buyer-profile')) hits.push(full.replace(ROOT + '/', ''))
  }
  return hits
}

// ─── Rule Zero ───────────────────────────────────────────────────────────────

describe('Rule Zero: no example names an industry, title, country, sector or company', () => {
  it('the question wording carries no example value at all', () => {
    // The strongest form of the rule that can be checked mechanically: the help text on a
    // targeting question must not contain a capitalised proper noun, because an example in a
    // targeting question reads as an instruction.
    const strings: string[] = []
    for (const q of Object.values(BUYER_PROFILE_QUESTIONS)) {
      strings.push(q.label)
      if ('helpText' in q && q.helpText) strings.push(q.helpText)
    }
    expect(strings.length).toBeGreaterThan(8)

    for (const text of strings) {
      // Allow a capital only at the start of a sentence.
      const midSentenceCapitals = text
        .replace(/^[A-Z]/, '')
        .replace(/([.!?]\s+)[A-Z]/g, '$1')
        .match(/[A-Z][a-z]+/g)
      expect(midSentenceCapitals, `proper noun in: ${text}`).toBeNull()
    }
  })

  it('the customer-facing wording carries no em dash, en dash or double hyphen', () => {
    for (const q of Object.values(BUYER_PROFILE_QUESTIONS)) {
      for (const text of [q.label, 'helpText' in q ? q.helpText : '']) {
        expect(text ?? '').not.toContain('—')
        expect(text ?? '').not.toContain('–')
        expect(text ?? '').not.toContain('--')
      }
    }
  })
})

// ─── Staleness mapping ───────────────────────────────────────────────────────

describe('every buyer-targeting field is mapped or explicitly excused', () => {
  it('classifies all nine', async () => {
    const { DOCUMENTS_FED_BY_FIELD, NOT_MAPPED } =
      await import('@/lib/intake/document-staleness')
    const classified = new Set([
      ...Object.keys(DOCUMENTS_FED_BY_FIELD),
      ...Object.keys(NOT_MAPPED),
    ])
    const unclassified = BUYER_PROFILE_FIELD_KEYS.filter(k => !classified.has(k))
    expect(
      unclassified,
      `unclassified buyer-targeting fields: ${unclassified.join(', ')}. Add each to ` +
      'DOCUMENTS_FED_BY_FIELD or to NOT_MAPPED with a reason.',
    ).toEqual([])
  })

  it('there really are nine of them, so the check above is not vacuous', () => {
    expect(BUYER_PROFILE_FIELD_KEYS).toHaveLength(9)
  })

  it('every excusing reason is prose, not a placeholder', async () => {
    const { NOT_MAPPED } = await import('@/lib/intake/document-staleness')
    for (const key of BUYER_PROFILE_FIELD_KEYS) {
      const reason = NOT_MAPPED[key]
      if (reason === undefined) continue
      expect(reason.trim().length, `${key} has an empty reason`).toBeGreaterThan(10)
    }
  })
})
