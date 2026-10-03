// The follow-up backfill reaches every personalised prospect whose follow-ups do not carry
// its Email 1, including the ones whose stored follow-ups went stale (operator note 4,
// 2026-10-01).
//
// Before this the cohort was selected on either follow-up column being EMPTY. A prospect
// holding two follow-ups written against an Email 1 that has since changed could not be
// selected, and approving a new messaging document puts every personalised prospect in
// exactly that state at once. The upload now holds such a prospect, so without this the
// hold would have no way out.

import { describe, it, expect, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { followupsAreCurrent } from '../../../../scripts/backfill-followups'

describe('followupsAreCurrent', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    followup_email2: 'Two.', followup_email3: 'Three.', followup_email1_fingerprint: 'abc', ...over,
  })

  it('both stored, written against this Email 1: nothing to do', () => {
    expect(followupsAreCurrent(row(), 'abc')).toBe(true)
  })

  it('PLANTED: both stored, written against a DIFFERENT Email 1: not current, so the backfill rewrites them', () => {
    expect(followupsAreCurrent(row(), 'a-new-email-1')).toBe(false)
  })

  it('PLANTED: one position empty is a gap to fill, even when the fingerprint matches', () => {
    expect(followupsAreCurrent(row({ followup_email3: null }), 'abc')).toBe(false)
    expect(followupsAreCurrent(row({ followup_email2: null }), 'abc')).toBe(false)
    expect(followupsAreCurrent(row({ followup_email2: '   ' }), 'abc')).toBe(false)
  })

  it('no fingerprint on record is never current', () => {
    expect(followupsAreCurrent(row({ followup_email1_fingerprint: null }), 'abc')).toBe(false)
  })
})

// A SOURCE PIN, with the limit the other script tests in this repo state: it proves the line
// is there, not that the path runs. The script has no harness, and what matters here is that
// three specific things cannot be deleted quietly.
describe('scripts/backfill-followups.ts', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'scripts/backfill-followups.ts'), 'utf8')
  // Code only: the header explains the filter that was removed, in words that would
  // otherwise match the assertion below.
  const code = source.split('\n').filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n')

  it('can find lines it is certain about, so a miss below is the code and not the search', () => {
    expect(code).toContain("async function loadCohort(")
    expect(code).toContain(".not('personalisation_trigger', 'is', null)")
    expect(code).toContain(".eq('outbound_upload_status', 'pending')")
  })

  it('PLANTED: the cohort is not filtered on the follow-up columns, so stale copy is reachable', () => {
    expect(code).not.toMatch(/followup_email2\.is\.null/)
    expect(code).not.toMatch(/followup_email3\.is\.null/)
  })

  it('PLANTED: decides "already carried" before the model call, by fingerprint', () => {
    const current = code.indexOf('if (followupsAreCurrent(p, fingerprint))')
    const call = code.indexOf('await writeFollowups({')
    expect(current).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(current)
  })

  it('PLANTED: writes from the finding Email 1 opened on, through the same function research uses', () => {
    expect(code).toMatch(/candidatesForThread\(writerInput\.candidates, writerInput\.selectedCandidateId, writerInput\.supportingCandidateId\)/)
  })

  it('PLANTED: importing it does not start a backfill', () => {
    expect(code).toMatch(/if \(process\.argv\[1\] && process\.argv\[1\]\.includes\('backfill-followups'\)\) \{\s*main\(\)/)
  })

  // THE WRITE, cut out of the file: the store function main() hands the run loop. Asserting
  // over the whole file let these pass with the thing they guard deleted, because the
  // upload-status filter also appears in the cohort read.
  const writeStart = code.indexOf('store: async (id, update) => {')
  const writeEnd = code.indexOf('return error ? error.message : null', writeStart)
  const write = code.slice(writeStart, writeEnd)

  it('can find the write, so the two checks below read something', () => {
    expect(writeStart).toBeGreaterThan(-1)
    expect(writeEnd).toBeGreaterThan(writeStart)
    expect(write).toContain('.update(update)')
  })

  it('PLANTED: the write re-checks that the prospect is still not uploaded, and filters on the organisation', () => {
    expect(write).toContain(".eq('outbound_upload_status', 'pending')")
    expect(write).toContain(".eq('organisation_id', orgId)")
  })

  it('PLANTED: the write takes its payload from followupUpdateFor and names no column itself', () => {
    expect(write).not.toMatch(/personalisation_|trigger_data|followup_email/)
    expect(code).toContain('const { update, email1Moved } = followupUpdateFor(p, { email2: result.email2.prose, email3: result.email3.prose }, fingerprint)')
  })

  it('PLANTED: the cohort is read whole and in id order; the limit and --after are applied to it', () => {
    const cohort = code.slice(code.indexOf('async function loadCohort('), code.indexOf('export type StoredEmail1Row'))
    expect(cohort).toContain(".order('id')")
    expect(cohort).not.toMatch(/\.limit\(/)
    expect(cohort).toContain("if (after) q = q.gt('id', after)")
  })

  it('PLANTED: the reason check is the upload\'s own verdict, made before the "already carried" skip', () => {
    const verdict = code.indexOf("const openingReason = openingReasonVerdict({ tier: 'research', judge: p.opening_judge ?? null, triggers })")
    const carried = code.indexOf('if (followupsAreCurrent(p, fingerprint))')
    expect(verdict).toBeGreaterThan(-1)
    expect(carried).toBeGreaterThan(verdict)
    // And no paid reason check is left in this script.
    expect(code).not.toContain('checkBridgeStatesReason')
  })

  it('PLANTED: a failed trigger read stops the run in main() as well', () => {
    expect(code).toContain('if (!read.ok) throw new Error(`backfill-followups: ${read.error}. Nothing further was written.`)')
  })

  it('PLANTED: the closing list prints each held prospect and that reason\'s own remedy', () => {
    expect(code).toContain('STILL HELD AT UPLOAD after this run, with what each one needs:')
    expect(code).toContain('console.log(`  ${STILL_HELD_REMEDY[reason]}`)')
    expect(code).toContain('for (const one of list) console.log(`    ${one}`)')
  })
})
