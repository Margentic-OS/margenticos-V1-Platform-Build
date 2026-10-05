// The comparison Doug approves from. These pin the definitions the report states, so the approval
// and the report cannot describe different things.

import { describe, it, expect } from 'vitest'
import { buildArmReport, type ArmReportRow } from '../research-arm-report'

const row = (over: Partial<ArmReportRow>): ArmReportRow => ({
  research_arm: 'standard',
  signal_relevance: 'no_signal',
  icp_fit: 'strong',
  sourced_tier: '1',
  usd: 0.2,
  ...over,
})

describe('research arm report: the comparison', () => {
  it('counts personalised as the Email 1 opening on the research (use_as_hook), per arm', () => {
    const report = buildArmReport([
      row({ research_arm: 'standard', signal_relevance: 'use_as_hook' }),
      row({ research_arm: 'standard', signal_relevance: 'no_signal' }),
      row({ research_arm: 'short_reasoning', signal_relevance: 'use_as_hook' }),
      row({ research_arm: 'short_reasoning', signal_relevance: 'use_as_hook' }),
    ])
    expect(report.standard.personalised).toBe(1)
    expect(report.standard.personalisedShare).toBe(0.5)
    expect(report.short_reasoning.personalised).toBe(2)
    expect(report.short_reasoning.personalisedShare).toBe(1)
  })

  it('shows the tier split and the fit-grade distribution for each arm', () => {
    const report = buildArmReport([
      row({ research_arm: 'short_reasoning', sourced_tier: '1', icp_fit: 'strong' }),
      row({ research_arm: 'short_reasoning', sourced_tier: '2', icp_fit: 'cannot_tell' }),
      row({ research_arm: 'short_reasoning', sourced_tier: '2', icp_fit: 'cannot_tell' }),
      row({ research_arm: 'standard', sourced_tier: null, icp_fit: null }),
    ])
    expect(report.short_reasoning.tiers).toEqual({ '1': 1, '2': 2 })
    expect(report.short_reasoning.fitGrades).toEqual({ strong: 1, cannot_tell: 2 })
    expect(report.standard.tiers).toEqual({ untiered: 1 })
    expect(report.standard.fitGrades).toEqual({ none: 1 })
  })

  it('reports cost per research, per 100 and per personalised email from the priced rows only', () => {
    const report = buildArmReport([
      row({ research_arm: 'short_reasoning', signal_relevance: 'use_as_hook', usd: 0.1 }),
      row({ research_arm: 'short_reasoning', signal_relevance: 'no_signal', usd: 0.2 }),
      row({ research_arm: 'short_reasoning', signal_relevance: 'no_signal', usd: null }),
    ])
    const line = report.short_reasoning
    expect(line.costed).toBe(2)
    expect(line.unpriced).toBe(1)
    expect(line.usdPerResearch).toBeCloseTo(0.15, 10)
    expect(line.usdPer100).toBeCloseTo(15, 10)
    expect(line.usdPerPersonalised).toBeCloseTo(0.3, 10)
  })

  it('an arm with no rows reports nulls, never zeros that read as a measurement', () => {
    const report = buildArmReport([row({ research_arm: 'standard' })])
    expect(report.short_reasoning.researches).toBe(0)
    expect(report.short_reasoning.personalisedShare).toBeNull()
    expect(report.short_reasoning.usdPer100).toBeNull()
    expect(report.short_reasoning.usdPerPersonalised).toBeNull()
  })
})
