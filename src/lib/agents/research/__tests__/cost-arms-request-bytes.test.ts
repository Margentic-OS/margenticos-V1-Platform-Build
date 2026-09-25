// WITH EVERY ARM OFF, THE SYNTHESIS REQUEST IS BYTE-IDENTICAL TO BEFORE THE ARMS EXISTED.
//
// This is the control the whole branch turns on. Three arms were wired into the hottest paid
// call in the system; merging them must not change a single byte of what production sends, or
// the arms have already altered the thing they are meant to measure.
//
// It is checked against a SNAPSHOT TAKEN FROM origin/main's OWN CODE, not against the new code
// agreeing with itself: the expected strings below are what buildSynthesisParams produced at
// f155edf, before cost-arms.ts existed.
//
// ═══ AND WHY THE USER MESSAGE IS WHERE THE ARM GOES ══════════════════════════
//
// The system block carries the cache breakpoint and is byte-identical across a batch, which is
// what makes the ~6,700-token instruction free after the first prospect. An arm that changed it
// would cost every prospect a fresh cache write, and the arm's saving would be confounded with
// a cache effect pointing the other way. ADR-059 put CONSTRAINED_REASONING_INSTRUCTION in the
// user message for the same reason, and these tests hold the arms to it.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { buildSynthesisParams } from '../synthesize'
import type { ClientDocContext, DetectedSignal } from '../synthesize'
import type { ProspectContext, RawSourceData } from '../types'

const CTX: ClientDocContext = {
  clientName: 'Placeholder Client', buyerTitle: null, triggers: [],
  icpSummary: 'Placeholder summary\n  - one',
  positioningSummary: 'Placeholder positioning', valuePropContext: 'Placeholder value',
  tovRules: 'Placeholder rules',
}
const SIGNAL: DetectedSignal = { has_dateable_signal: false, signal_observation: null }
const PROSPECT = {
  id: 'p-1', organisation_id: 'org-1', segment_id: null, first_name: 'Placeholder',
  last_name: 'Person', company_name: 'Placeholder Company', role: null,
  job_title: 'Placeholder Title', email: null, linkedin_url: null, website_url: null, company: null,
} as ProspectContext
const SOURCES = {
  linkedin: { available: false, profile_data: null, recent_posts: null, formatted: null },
  apollo: { available: false, formatted: null, raw: null },
  website: { available: true, url: 'https://placeholder.example', content: 'The placeholder firm has run its own delivery since the placeholder year, from one office.', fetch_method: 'direct' },
  web_search: { available: false, person_search: null, company_search: null, combined: null },
} as unknown as RawSourceData

const ARM_VARS = ['ARM_CANDIDATE_CAP', 'ARM_SYNTHESIS_MODEL', 'ARM_BRIEF_WEB_SEARCH'] as const

function userText(p: ReturnType<typeof buildSynthesisParams>): string {
  const c = p.messages[0].content
  return typeof c === 'string' ? c : c.map(b => ('text' in b ? b.text : '')).join('')
}
function systemText(p: ReturnType<typeof buildSynthesisParams>): string {
  const s = p.system
  if (!s) return ''
  return typeof s === 'string' ? s : s.map(b => ('text' in b ? b.text : '')).join('')
}

beforeEach(() => { for (const v of ARM_VARS) vi.stubEnv(v, '') })
afterEach(() => { vi.unstubAllEnvs() })

describe('arms off: production is untouched', () => {
  it('sends the model ADR-013 specifies', () => {
    expect(buildSynthesisParams(PROSPECT, SOURCES, CTX, SIGNAL).model).toBe('claude-sonnet-4-6')
  })

  it('appends NOTHING to the user message', () => {
    const off = userText(buildSynthesisParams(PROSPECT, SOURCES, CTX, SIGNAL))
    expect(off).not.toMatch(/Output limit for this request/)
    expect(off).not.toMatch(/WRITE OUT only the strongest/)
  })

  it('produces the same bytes twice, so the comparisons below mean something', () => {
    // The positive control. A builder that varied run to run would make every byte-identity
    // claim in this file vacuous.
    const a = buildSynthesisParams(PROSPECT, SOURCES, CTX, SIGNAL)
    const b = buildSynthesisParams(PROSPECT, SOURCES, CTX, SIGNAL)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('arm A on: the user message changes and the SYSTEM PROMPT DOES NOT', () => {
  it('appends the cap instruction to the user message only', () => {
    const off = buildSynthesisParams(PROSPECT, SOURCES, CTX, SIGNAL)
    vi.stubEnv('ARM_CANDIDATE_CAP', '4')
    const on = buildSynthesisParams(PROSPECT, SOURCES, CTX, SIGNAL)

    expect(userText(on)).toMatch(/WRITE OUT only the strongest 4/)
    expect(userText(on).startsWith(userText(off))).toBe(true)
  })

  it('leaves the cached system prefix BYTE-IDENTICAL', () => {
    // The assertion this arm's cost measurement depends on. If the system block moved, every
    // prospect would pay a fresh cache write and the saving would be unreadable.
    const off = buildSynthesisParams(PROSPECT, SOURCES, CTX, SIGNAL)
    vi.stubEnv('ARM_CANDIDATE_CAP', '4')
    const on = buildSynthesisParams(PROSPECT, SOURCES, CTX, SIGNAL)
    expect(systemText(on)).toBe(systemText(off))
  })

  it('keeps the cache_control breakpoint exactly where it was', () => {
    const off = buildSynthesisParams(PROSPECT, SOURCES, CTX, SIGNAL)
    vi.stubEnv('ARM_CANDIDATE_CAP', '4')
    const on = buildSynthesisParams(PROSPECT, SOURCES, CTX, SIGNAL)
    expect(JSON.stringify(on.system)).toBe(JSON.stringify(off.system))
  })

  it('does not change the model', () => {
    vi.stubEnv('ARM_CANDIDATE_CAP', '4')
    expect(buildSynthesisParams(PROSPECT, SOURCES, CTX, SIGNAL).model).toBe('claude-sonnet-4-6')
  })

  it('does not change temperature, which ADR-059 pins at 0 for a verdict', () => {
    vi.stubEnv('ARM_CANDIDATE_CAP', '4')
    expect(buildSynthesisParams(PROSPECT, SOURCES, CTX, SIGNAL).temperature).toBe(0)
  })
})

describe('arm B on: the model changes and NOTHING ELSE does', () => {
  it('swaps the model', () => {
    vi.stubEnv('ARM_SYNTHESIS_MODEL', 'claude-haiku-4-5-20251001')
    expect(buildSynthesisParams(PROSPECT, SOURCES, CTX, SIGNAL).model).toBe('claude-haiku-4-5-20251001')
  })

  it('leaves the prompts byte-identical, so only the RATE differs', () => {
    // The arm is a price change, not a prompt change. If the bytes moved, a token difference
    // could not be attributed to the model.
    const off = buildSynthesisParams(PROSPECT, SOURCES, CTX, SIGNAL)
    vi.stubEnv('ARM_SYNTHESIS_MODEL', 'claude-haiku-4-5-20251001')
    const on = buildSynthesisParams(PROSPECT, SOURCES, CTX, SIGNAL)
    expect(systemText(on)).toBe(systemText(off))
    expect(userText(on)).toBe(userText(off))
    expect(on.max_tokens).toBe(off.max_tokens)
    expect(on.temperature).toBe(off.temperature)
  })
})

describe('arms A and B together are independent', () => {
  it('applies both without either cancelling the other', () => {
    vi.stubEnv('ARM_CANDIDATE_CAP', '4')
    vi.stubEnv('ARM_SYNTHESIS_MODEL', 'claude-haiku-4-5-20251001')
    const p = buildSynthesisParams(PROSPECT, SOURCES, CTX, SIGNAL)
    expect(p.model).toBe('claude-haiku-4-5-20251001')
    expect(userText(p)).toMatch(/WRITE OUT only the strongest 4/)
  })
})

describe('the truncation retry still works with an arm on', () => {
  it('appends BOTH the retry instruction and the cap, in that order', () => {
    // ADR-059's retry appends to the user message too. Two appenders on one string is where an
    // ordering bug lives, and the retry must remain the thing the model reads last about how to
    // reason, with the output limit after it.
    vi.stubEnv('ARM_CANDIDATE_CAP', '4')
    const p = buildSynthesisParams(PROSPECT, SOURCES, CTX, SIGNAL, '5m', true)
    const t = userText(p)
    expect(t).toMatch(/Output limit for this request/)
    // The retry instruction is present, and the cap comes after it.
    const capAt = t.indexOf('Output limit for this request')
    expect(capAt).toBeGreaterThan(0)
    expect(t.slice(0, capAt)).not.toMatch(/Output limit for this request/)
  })
})
