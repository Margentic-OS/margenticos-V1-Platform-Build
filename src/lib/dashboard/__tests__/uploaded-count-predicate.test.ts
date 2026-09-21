// "UPLOADED" MUST MEAN uploaded.
//
// Both callers counted `.neq('outbound_upload_status', 'pending')`. The column is NOT NULL
// with default 'pending' (read from the live catalog 2026-09-21) and carries pending,
// uploading, uploaded and failed, so neq('pending') also counted the claimed and the
// FAILED as uploaded. A failed upload is precisely the row that must not read as done:
// on the operator page it is the "already uploaded" figure, and on the client overview it
// decides deriveCampaignsStatus, so a failed upload read as a campaign that had been set up.
//
// THE LIMIT, STATED SO THIS IS NOT OVER-TRUSTED: these are server components that build
// their queries inline, so there is no seam to inject a recording client into without
// restructuring the pages. This reads the SOURCE. It proves the predicate written in the
// file, not the SQL a running page emits. It would not notice the query moving to a helper.
//
// It is here rather than nowhere because the alternative was no guard at all: mutating
// eq('uploaded') back to neq('pending') left the entire suite green.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CALLERS = [
  'src/app/dashboard/operator/clients/[id]/page.tsx',
  'src/app/dashboard/(client)/page.tsx',
] as const

const read = (relPath: string) => readFileSync(join(process.cwd(), relPath), 'utf8')

describe('the uploaded-prospect count', () => {
  // CONTROL. Both assertions below are about a string being present or absent, and both
  // would pass against an empty read. This proves the files are found and are the ones
  // that build this query.
  it('reads both caller files, and both really do count prospects', () => {
    for (const file of CALLERS) {
      const source = read(file)
      expect(source.length, `${file} read back empty`).toBeGreaterThan(500)
      expect(source, `${file} no longer queries prospects`).toContain("from('prospects')")
      expect(source).toContain('outbound_upload_status')
    }
  })

  it('asks for uploaded, and never for "anything that is not pending"', () => {
    for (const file of CALLERS) {
      const source = read(file)
      expect(source, `${file} counts uploaded by eq`).toContain("eq('outbound_upload_status', 'uploaded')")
      // The specific regression. 'uploading' and 'failed' are not uploaded.
      expect(source, `${file} reintroduced the neq predicate`)
        .not.toContain("neq('outbound_upload_status', 'pending')")
    }
  })
})
