import { describe, it, expect } from 'vitest'
import { findEvidenceFaults } from '@/agents/trigger-evidence-gate'
import { CARRIED_FAULT_KINDS } from '../derive-trigger-reasons'

/**
 * derive-trigger-reasons rewrites the trigger SENTENCE and the REASON, and carries
 * evidence_to_find through untouched. It therefore gates only on faults it can repair,
 * and CARRIED_FAULT_KINDS names the rest.
 *
 * The danger is drift: a new fault kind raised from an evidence line, not added to the
 * set, silently makes the loop unwinnable again. So these tests ask the GATE what it
 * produces rather than restating the set, which is the only version that survives the
 * gate growing.
 */
describe('CARRIED_FAULT_KINDS matches what the gate raises from evidence', () => {
  const cleanReason = 'A new site needs stock the local buyers can not get now.'

  it('every fault raised from an evidence line is carried, not blocking', () => {
    const faults = findEvidenceFaults([
      {
        trigger: 'The company opened a second site.',
        reason: cleanReason,
        evidence_to_find: [
          'Company-data signal: a recent headcount increase at the new site',
          'Website signal: the site no longer lists a partner',
          'Company-data signal: revenue of 5M reported for the year',
        ],
      },
    ])
    expect(faults.length).toBeGreaterThan(0)
    for (const f of faults) {
      expect(CARRIED_FAULT_KINDS.has(f.kind), `${f.kind} came from evidence but is not carried`).toBe(true)
    }
  })

  it('no fault raised from a reason or a trigger sentence is carried', () => {
    const faults = findEvidenceFaults([
      { trigger: 'The company opened a second site.', reason: '', evidence_to_find: [] },
      {
        trigger: 'The company opened a second site, signalling they intend to grow.',
        reason: 'Organisational expansion necessitates differentiated procurement infrastructure across territories.',
        evidence_to_find: [],
      },
    ])
    expect(faults.length).toBeGreaterThan(0)
    for (const f of faults) {
      expect(CARRIED_FAULT_KINDS.has(f.kind), `${f.kind} came from a reason or sentence but is carried`).toBe(false)
    }
  })

  it('a document whose only fault is on evidence leaves nothing blocking', () => {
    const all = findEvidenceFaults([
      {
        trigger: 'The company opened a second site.',
        reason: cleanReason,
        evidence_to_find: ['Website signal: the site no longer lists a partner'],
      },
    ])
    expect(all.length).toBeGreaterThan(0)
    expect(all.filter(f => !CARRIED_FAULT_KINDS.has(f.kind))).toEqual([])
  })
})
