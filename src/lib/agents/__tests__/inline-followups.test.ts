// The full-price research route can write the personalised follow-ups (operator note 4,
// 2026-10-01). Until now only the second phase of the batch route did, so a prospect
// researched from the command line arrived at upload with a personalised Email 1 and
// nothing carrying its thread, which the upload now holds.
//
// THREE JOINS, each one a place the option could be dropped without an error:
//
//   command line  ->  runResearchBatchForOrg        (source pin, see the limit below)
//   entry point   ->  runProspectResearchAgentV2Batch   (behavioural, in
//                     competitor-screen-entry.test.ts, which already stands that call in)
//   inline agent  ->  produceOpening and updateProspect (source pin)
//   updateProspect -> the three columns             (behavioural, here)
//
// THE LIMIT OF A SOURCE PIN, stated: it proves the line is there, not that the path runs.
// It is used where a behavioural test would need the whole research agent stood in, and it
// catches the regression that matters, which is the argument being deleted. The same
// trade-off, with the same wording, is made in research-usage-path.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const updates: Array<{ table: string; payload: Record<string, unknown> }> = []

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => ({
      update: (payload: Record<string, unknown>) => {
        const chain = {
          eq: () => chain,
          then: (resolve: (v: { error: null }) => void) => { updates.push({ table, payload }); resolve({ error: null }) },
        }
        return chain
      },
      select: () => { throw new Error('fake does not implement select') },
      insert: () => { throw new Error('fake does not implement insert') },
    }),
  }),
}))

import { updateProspect } from '../prospect-research-agent-v2'

const CTX = { id: 'p-1', organisation_id: 'org-1' } as unknown as Parameters<typeof updateProspect>[0]
const SYNTHESIS = {
  icp_fit: 'strong', has_dateable_signal: false, signal_observation: null,
  qualification_status: 'qualified', qualification_reason: null, confidence: 'high',
} as unknown as Parameters<typeof updateProspect>[1]
const WON = { written_won: true, opening: 'An opening.', question: 'A question?', subject: null } as unknown as Parameters<typeof updateProspect>[3]
const HELD = { written_won: false, opening: null, question: null, subject: null } as unknown as Parameters<typeof updateProspect>[3]

beforeEach(() => {
  updates.length = 0
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
})

describe('updateProspect and the follow-ups', () => {
  it('writes the follow-ups and the fingerprint beside the opening they were written for', async () => {
    await updateProspect(CTX, SYNTHESIS, 'rr-1', WON, null, { email2: 'Two.', email3: 'Three.', email1Fingerprint: 'abc' })
    expect(updates[0].payload).toMatchObject({
      personalisation_trigger: 'An opening.', followup_email2: 'Two.', followup_email3: 'Three.', followup_email1_fingerprint: 'abc',
    })
  })

  it('PLANTED: a caller that passes none writes the three columns NULL, so nothing from an earlier run is left behind', async () => {
    await updateProspect(CTX, SYNTHESIS, 'rr-1', WON, null, null)
    expect(updates[0].payload).toMatchObject({ followup_email2: null, followup_email3: null, followup_email1_fingerprint: null })
  })

  it('PLANTED: an opening that did not win takes its follow-ups with it', async () => {
    await updateProspect(CTX, SYNTHESIS, 'rr-1', HELD, null, { email2: 'Two.', email3: 'Three.', email1Fingerprint: 'abc' })
    expect(updates[0].payload).toMatchObject({
      personalisation_trigger: null, followup_email2: null, followup_email3: null, followup_email1_fingerprint: null,
    })
  })
})

describe('the option reaches the writer and the row, on the inline route', () => {
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8')
  const agent = read('src/lib/agents/prospect-research-agent-v2.ts')
  const cli = read('scripts/run-research.ts')

  it('can find lines it is certain about, so a miss below is the code and not the search', () => {
    expect(agent).toContain('export async function runProspectResearchAgentV2(')
    expect(agent).toContain('await produceOpening({')
    expect(cli).toContain('runResearchBatchForOrg')
  })

  it('PLANTED: a caller that REQUIRED stored findings gets a throw, never a fetch', () => {
    // Source pin, with the limit stated at the top of this file. The throw sits between
    // "no stored findings" and the warning that announces the fetching fallback.
    const none = agent.indexOf('if (use_stored_findings && !stored) {')
    const guard = agent.indexOf('if (stored_findings_required) {', none)
    const fallback = agent.indexOf("'prospect-research-v2: no usable stored findings, falling back to a fetching run'", none)
    expect(none).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(none)
    expect(fallback).toBeGreaterThan(guard)
    expect(agent.slice(guard, fallback)).toContain('throw new Error(')
    // And it is off unless asked for.
    expect(agent).toMatch(/stored_findings_required = false,/)
  })

  it('the inline agent defaults the option OFF', () => {
    expect(agent).toMatch(/write_followups = false,\s*\n\s*frameRegistry,/)
  })

  it('PLANTED: the inline agent asks the writer for follow-ups only when the option is on, through the same arm test the batch route uses', () => {
    expect(agent).toMatch(/writeFollowupEmails:\s*write_followups\s*&&\s*assignFollowupArm\(ctx\.id\)\s*===\s*'generated'/)
  })

  it('PLANTED: and stores what the writer returned, or NULL when it was not asked', () => {
    expect(agent).toMatch(
      /write_followups\s*\?\s*\{\s*email2:\s*opening\.email2\?\.prose \?\? null,\s*email3:\s*opening\.email3\?\.prose \?\? null,\s*email1Fingerprint:\s*opening\.followup_email1_fingerprint \?\? null,\s*\}\s*:\s*null/,
    )
  })

  it('the batch wrapper passes the option to each prospect', () => {
    expect(agent).toMatch(/prospect_id, client_id, frameRegistry, uniqueness, use_stored_findings, research_path,\s*\n\s*write_followups,/)
  })

  it('PLANTED: the command line asks for follow-ups unless told not to', () => {
    expect(cli).toMatch(/write_followups:\s*!noFollowups/)
    expect(cli).toMatch(/const noFollowups = flag\('no-followups'\)/)
  })

  it('the dashboard route does not, because the calls do not fit its time budget', () => {
    const route = read('src/app/api/operator/organisations/[id]/research-prospects/route.ts')
    expect(route).toContain('runResearchBatchForOrg')
    expect(route).not.toContain('write_followups')
  })
})
