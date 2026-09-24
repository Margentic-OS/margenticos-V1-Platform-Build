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

/**
 * The second axis: --only. Positions outside the selection are carried through untouched,
 * so a fault on one of them is not something the run can repair either.
 *
 * This is the partition the script applies, restated against the gate's real output, so
 * that the rule "gate only on what this run rewrote" is checked rather than assumed.
 */
describe('a fault outside the --only selection is not this run\'s to fix', () => {
  const list = [
    { trigger: 'The company opened a second site.', reason: 'A new site needs stock the local buyers can not get now.', evidence_to_find: [] },
    { trigger: 'The company named a new head of sales.', reason: '', evidence_to_find: [] },
  ]

  it('gates on a selected position', () => {
    const only = new Set([2])
    const faults = findEvidenceFaults(list)
      .filter(f => only.has(f.trigger_index) && !CARRIED_FAULT_KINDS.has(f.kind))
    expect(faults.map(f => f.kind)).toContain('reason_missing')
  })

  it('does not gate on an unselected position, and still reports it', () => {
    const only = new Set([1])
    const all = findEvidenceFaults(list)
    const blocking = all.filter(f => only.has(f.trigger_index) && !CARRIED_FAULT_KINDS.has(f.kind))
    const carried = all.filter(f => !only.has(f.trigger_index) || CARRIED_FAULT_KINDS.has(f.kind))
    expect(blocking).toEqual([])
    expect(carried.map(f => f.kind)).toContain('reason_missing')
  })

  it('with no --only every position is this run\'s to fix', () => {
    const only = null as Set<number> | null
    const blocking = findEvidenceFaults(list)
      .filter(f => (!only || only.has(f.trigger_index)) && !CARRIED_FAULT_KINDS.has(f.kind))
    expect(blocking.map(f => f.kind)).toContain('reason_missing')
  })
})
