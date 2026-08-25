// Runs the REAL shipped predicate against live prospect rows and prints the split.
// Read-only: it SELECTs and reports. Opt-in because it needs live credentials.
//
//   RUN_ELIGIBILITY_REPORT=1 npx vitest run src/lib/sourcing/__tests__/eligibility-against-live-data.test.ts
//
// This exists because a re-implementation of the rule in SQL would prove nothing: it would
// only show that two copies of the logic agree, which is the exact failure mode the policy
// module was created to avoid. Importing checkResearchEligibility means the numbers below
// are produced by the code that actually runs.

import { describe, it, expect } from 'vitest'
import path from 'path'
import dotenv from 'dotenv'
import {
  checkResearchEligibility,
  summariseIneligible,
  CATCH_ALL_IS_RESEARCH_WORTHY,
  type IneligibleReason,
} from '../send-eligibility-policy'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

interface Row {
  id: string
  organisation_id: string
  suppressed: boolean
  independent_verified_at: string | null
  independent_email_status: string | null
  email_send_ineligible_reason: string | null
  organisations: { name: string; archived_at: string | null } | null
}

describe.runIf(process.env.RUN_ELIGIBILITY_REPORT)('eligibility predicate against live data', () => {
  it('reports the split for every organisation', async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
    const res = await fetch(
      `${url}/rest/v1/prospects?select=id,organisation_id,suppressed,independent_verified_at,` +
      `independent_email_status,email_send_ineligible_reason,organisations(name,archived_at)`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    )
    const rows = await res.json() as Row[]

    const byOrg = new Map<string, Row[]>()
    for (const r of rows) {
      const label = `${r.organisations?.name ?? '?'}${r.organisations?.archived_at ? ' [ARCHIVED]' : ''}`
      byOrg.set(label, [...(byOrg.get(label) ?? []), r])
    }

    console.log(`\nCATCH_ALL_IS_RESEARCH_WORTHY = ${CATCH_ALL_IS_RESEARCH_WORTHY}`)
    console.log(`${rows.length} prospects total\n`)
    console.log(`${'organisation'.padEnd(30)}${'considered'.padStart(11)}${'ELIGIBLE'.padStart(10)}  skipped`)

    let totalEligible = 0
    for (const [label, orgRows] of [...byOrg.entries()].sort((a, b) => b[1].length - a[1].length)) {
      // Mirror what enqueue actually does: archived orgs are refused before the predicate,
      // and suppressed prospects never reach it.
      const archived = label.includes('[ARCHIVED]')
      const considered = orgRows.filter(r => !r.suppressed)
      const reasons: IneligibleReason[] = []
      let eligible = 0
      for (const r of considered) {
        const v = checkResearchEligibility(r)
        if (v.eligible) eligible++
        else reasons.push(v.reason)
      }
      if (!archived) totalEligible += eligible
      console.log(
        `${label.padEnd(30)}${String(considered.length).padStart(11)}${String(archived ? 0 : eligible).padStart(10)}  ` +
        `${reasons.length ? summariseIneligible(reasons) : '-'}${archived ? '  (org refused before predicate)' : ''}`,
      )
    }
    console.log(`\nreachable eligible across live organisations: ${totalEligible}\n`)

    expect(rows.length).toBeGreaterThan(0)
  }, 60_000)
})
