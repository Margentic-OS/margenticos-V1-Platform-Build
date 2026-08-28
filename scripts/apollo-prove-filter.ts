/**
 * Apollo filter proof harness.
 *
 * WHY THIS EXISTS. Apollo SILENTLY IGNORES a parameter it does not recognise. It does
 * not error, it does not warn: it returns the count for the filter minus that parameter.
 * So a mapping that does nothing looks exactly like one that works, and the only
 * difference is a number nobody measured.
 *
 * Counting alone is not enough either, which is the finding this harness is built around.
 * Measured 2026-08-28: `organization_locations: ['munster, ireland']` returns 948, and so
 * does `['ireland']`. All three Irish provinces do. Apollo matched the country inside the
 * string and dropped the province. That is WORSE than an ignored parameter, because an
 * ignored parameter returns the obviously-unfiltered count while this returns a
 * plausible, narrower-looking number that is actually the whole country.
 *
 * So every mapping gets FOUR assertions, not one:
 *
 *   1. POSITIVE          applying it moves the count away from the unfiltered baseline
 *   2. PARAMETER CONTROL the same value under a deliberately misspelled parameter name
 *                        returns the baseline. If the real call matches this, the
 *                        parameter is being ignored.
 *   3. VALUE CONTROL     a nonsense value under the REAL name. This measures the
 *                        PARAMETER'S STRICTNESS, not this value's correctness, and the
 *                        distinction only became clear by running it:
 *                          strict  -> returns 0 or 4xx (person_seniorities,
 *                                     organization_naics_codes, organization_locations)
 *                          lenient -> returns the BASELINE, silently dropping the value
 *                                     (organization_num_employees_ranges, measured
 *                                     2026-08-28: a nonsense range returned 157,146,
 *                                     exactly the count with the parameter absent)
 *                        A lenient parameter is not a failure. It is a warning that
 *                        assertion 1 is the ONLY thing protecting that mapping, so it
 *                        can never be skipped there. It fails only when the nonsense
 *                        count equals the applied count, because then nothing
 *                        distinguishes our value from garbage.
 *   4. GRANULARITY       (locations only, and mandatory) the value's count must differ
 *                        from its parent country's. This is the only one that catches
 *                        Munster.
 *
 * COST: none. mixed_people/api_search consumes NO Apollo credits, and every call here
 * uses per_page=1 and reads only total_entries. Organisation search DOES consume credits
 * and is deliberately not used. The only real budget is the 600 calls/hour rate limit.
 *
 * The numbers are printed as a table rather than pasted into a comment, so they can be
 * regenerated rather than trusted. A number in a comment is a claim about a day.
 *
 * Usage:  npx tsx scripts/apollo-prove-filter.ts
 */

const ENDPOINT = 'https://api.apollo.io/api/v1/mixed_people/api_search'
const THROTTLE_MS = 400

// The base every probe is measured against. Deliberately NOT imported from the handler:
// this harness must be able to measure a filter the handler does not yet send, and
// importing would make it describe only what already ships.
const BASE: Record<string, unknown> = {
  organization_naics_codes: ['5416'],
  q_organization_keyword_tags: [
    'management consulting',
    'business consulting',
    'strategy consulting',
  ],
  organization_num_employees_ranges: ['5,20'],
  organization_locations: ['united states', 'united kingdom', 'ireland'],
  person_locations: ['united states', 'united kingdom', 'ireland'],
  person_seniorities: ['owner', 'founder', 'c_suite', 'partner'],
  contact_email_status: ['verified'],
}

type CountResult = { count: number | null; error?: string }

async function count(apiKey: string, body: Record<string, unknown>): Promise<CountResult> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ ...body, page: 1, per_page: 1 }),
  })
  await new Promise(r => setTimeout(r, THROTTLE_MS))
  if (!res.ok) return { count: null, error: `HTTP ${res.status}` }
  const json = (await res.json()) as { total_entries?: number }
  return { count: json.total_entries ?? 0 }
}

/** Baseline with `param` removed entirely: what an ignored parameter looks like. */
function withoutParam(param: string): Record<string, unknown> {
  const b = { ...BASE }
  delete b[param]
  return b
}

interface Probe {
  /** Real Apollo parameter name. */
  param: string
  /** The value being proved. */
  value: unknown
  /** For a location probe, the containing country, to run assertion 4. */
  parent?: unknown
}

interface Verdict {
  label: string
  baseline: number | null
  applied: number | null
  misspelled: number | null
  nonsense: number | null
  parent: number | null
  /** Whether the PARAMETER rejects a nonsense value, or silently drops it. */
  strictness: 'strict' | 'lenient' | 'unknown'
  pass: boolean
  reason: string
}

async function prove(apiKey: string, probe: Probe): Promise<Verdict> {
  const label = `${probe.param}=${JSON.stringify(probe.value)}`

  // Baseline: the filter WITHOUT this parameter.
  const baseline = await count(apiKey, withoutParam(probe.param))

  // 1. Positive.
  const applied = await count(apiKey, { ...withoutParam(probe.param), [probe.param]: probe.value })

  // 2. Parameter control: same value, misspelled parameter name.
  const misspelled = await count(apiKey, {
    ...withoutParam(probe.param),
    [`${probe.param}_zzq`]: probe.value,
  })

  // 3. Value control: real parameter, nonsense value.
  const nonsense = await count(apiKey, {
    ...withoutParam(probe.param),
    [probe.param]: ['zzqq-not-a-real-value'],
  })

  // 4. Granularity, locations only.
  const parent = probe.parent
    ? await count(apiKey, { ...withoutParam(probe.param), [probe.param]: probe.parent })
    : { count: null as number | null }

  const v: Verdict = {
    label,
    baseline: baseline.count,
    applied: applied.count,
    misspelled: misspelled.count,
    nonsense: nonsense.count,
    parent: parent.count,
    strictness: 'unknown',
    pass: false,
    reason: '',
  }

  // Assertion 3, read as a property of the parameter.
  if (nonsense.count === null) v.strictness = 'strict'          // rejected outright
  else if (nonsense.count === 0) v.strictness = 'strict'
  else if (nonsense.count === baseline.count) v.strictness = 'lenient'

  if (applied.count === null || baseline.count === null) {
    v.reason = 'request failed'
  } else if (applied.count === baseline.count) {
    v.reason = 'IGNORED: applying it did not move the count'
  } else if (misspelled.count !== null && applied.count === misspelled.count) {
    v.reason = 'IGNORED: matches the misspelled-parameter count'
  } else if (nonsense.count !== null && nonsense.count === applied.count) {
    v.reason = 'NOT READ: our value is indistinguishable from a nonsense one'
  } else if (probe.parent && parent.count !== null && applied.count === parent.count) {
    v.reason = 'WIDENED: identical to its parent country, the narrower level was dropped'
  } else {
    v.pass = true
    v.reason = v.strictness === 'lenient'
      ? 'proved (LENIENT parameter: it drops a bad value silently, so assertion 1 is the only guard here)'
      : 'proved'
  }
  return v
}

// The probes. Extend this list as canonical-to-Apollo mappings are added.
const PROBES: Probe[] = [
  { param: 'organization_naics_codes', value: ['6116'] },
  { param: 'person_seniorities', value: ['owner', 'founder'] },
  { param: 'organization_num_employees_ranges', value: ['21,50'] },
  { param: 'organization_locations', value: ['ireland'] },
  // The two that made this harness necessary. Dublin is a city and nests correctly.
  { param: 'organization_locations', value: ['dublin, ireland'], parent: ['ireland'] },
  // DELIBERATELY FAILING, AND IT MUST STAY THAT WAY. Munster is a province, and Apollo
  // returns the whole-country count for it. This row is the harness proving it can still
  // catch the thing it was built for, so the exit code is non-zero on a normal run. Do
  // not remove it to make the script "pass": a proof harness with no known-bad case is
  // one that has never been shown to fail. If it ever reports PASS, Apollo's behaviour
  // changed and the granularity rule needs re-deriving, not deleting.
  { param: 'organization_locations', value: ['munster, ireland'], parent: ['ireland'] },
]

function pad(v: number | null, w: number): string {
  return (v === null ? '-' : v.toLocaleString('en-GB')).padStart(w)
}

async function main() {
  const apiKey = process.env.APOLLO_API_KEY
  if (!apiKey) {
    process.stderr.write('APOLLO_API_KEY not set\n')
    process.exit(1)
  }

  const rows: Verdict[] = []
  for (const probe of PROBES) rows.push(await prove(apiKey, probe))

  const out: string[] = []
  out.push('')
  out.push('Apollo filter proof — people search, no credits consumed')
  out.push(`Run: ${new Date().toISOString()}`)
  out.push('')
  out.push(
    'parameter=value'.padEnd(52) +
    'base'.padStart(9) + 'applied'.padStart(9) + 'misspelt'.padStart(9) +
    'nonsense'.padStart(9) + 'parent'.padStart(9) + '  strict?'.padEnd(10) + 'verdict',
  )
  out.push('-'.repeat(52 + 45 + 10))
  for (const r of rows) {
    out.push(
      r.label.slice(0, 51).padEnd(52) +
      pad(r.baseline, 9) + pad(r.applied, 9) + pad(r.misspelled, 9) +
      pad(r.nonsense, 9) + pad(r.parent, 9) +
      `  ${r.strictness.padEnd(8)}${r.pass ? 'PASS' : 'FAIL'} ${r.reason}`,
    )
  }
  out.push('')

  const failed = rows.filter(r => !r.pass)
  out.push(`${rows.length - failed.length}/${rows.length} proved.`)
  if (failed.length > 0) {
    out.push('')
    out.push('FAILING — these mappings must not be shipped as filters:')
    for (const r of failed) out.push(`  ${r.label}  ${r.reason}`)
  }
  out.push('')

  process.stdout.write(out.join('\n'))
  process.exit(failed.length > 0 ? 1 : 0)
}

void main()

export {}
