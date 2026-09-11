// The fit judge's four outcomes.
//
// "moderate" used to mean both a genuine partial fit and "I cannot tell". The prompt sent thin
// evidence, sparse profiles and uncertain criteria there, and the code stored a failed or
// unreadable answer there too. 17 of 20 re-graded prospects landed on it. Not knowing is now
// its own outcome, cannot_tell, which is never a grade and never a fit.
//
// Each case names what would break: a failed answer recording a grade, an unreadable one doing
// the same, the outcome disappearing from the code, the prompt or the database, or an
// instruction that sends uncertainty to the middle value coming back.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import type { Message } from '@anthropic-ai/sdk/resources/messages'
import { synthesisFromMessage, synthesisFallback, type ClientDocContext, type DetectedSignal } from '../synthesize'
import { buildSynthesisPrompt } from '../prompts/synthesis-prompt'
import { ICP_FIT_GRADES, ICP_FIT_OUTCOMES, type ProspectContext } from '../types'

const CLIENT_CTX: ClientDocContext = {
  clientName:         'Placeholder Client',
  buyerTitle:         'Placeholder Buyer',
  icpSummary:         'Placeholder summary of who the client sells to.',
  positioningSummary: 'Placeholder positioning.',
  valuePropContext:   'Placeholder value proposition.',
  tovRules:           'Placeholder tone rules.',
}

const SIGNAL: DetectedSignal = { has_dateable_signal: false, signal_observation: 'Placeholder dated item' }

function prospect(): ProspectContext {
  return {
    id: 'p-1', organisation_id: 'org-1', segment_id: 'seg-1',
    first_name: 'Placeholder', last_name: 'Person', company_name: 'Placeholder Company',
    role: null, job_title: 'Placeholder Title', email: null,
    linkedin_url: null, website_url: null, company: null,
  }
}

function message(text: string, overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...overrides,
  } as unknown as Message
}

function answer(fields: Record<string, unknown>): string {
  return `<reasoning>\nPlaceholder reasoning.\n</reasoning>\n${JSON.stringify({
    qualification_status: 'qualified', confidence: 'medium', relevance_reason: 'Placeholder.',
    trigger_text: null, selected_candidate_id: null, candidates: [], ...fields,
  }, null, 2)}`
}

// No sources: this client context carries no fit dimensions, so no quotation is checked.
const NO_SOURCES = {
  linkedin: { available: false, profile_data: null, recent_posts: null, formatted: null },
  apollo: { available: false, formatted: null, raw: null },
  website: { available: false, url: null, content: null, fetch_method: null },
  web_search: { available: false, person_search: null, company_search: null, combined: null },
} as never
const judge = (text: string, overrides: Partial<Message> = {}) =>
  synthesisFromMessage(message(text, overrides), prospect(), CLIENT_CTX, SIGNAL, NO_SOURCES)

describe('not knowing is its own outcome, and never a grade', () => {
  it('cannot_tell is one of the four outcomes and not one of the three grades', () => {
    expect([...ICP_FIT_OUTCOMES].sort()).toEqual(['cannot_tell', 'moderate', 'strong', 'weak'])
    expect(ICP_FIT_GRADES).not.toContain('cannot_tell')
  })

  it('a judge that says it cannot tell is recorded as cannot_tell, with what it was missing', () => {
    const out = judge(answer({ icp_fit: 'cannot_tell', icp_fit_missing: 'Placeholder dimension could not be checked.' }))
    expect(out.icp_fit).toBe('cannot_tell')
    expect(out.icp_fit_missing).toBe('Placeholder dimension could not be checked.')
  })

  it.each(ICP_FIT_GRADES)('a judge that grades %s is recorded as that grade, with nothing missing', grade => {
    const out = judge(answer({ icp_fit: grade }))
    expect(out.icp_fit).toBe(grade)
    expect(out.icp_fit_missing).toBeNull()
  })
})

describe('an answer that reached no grade records cannot_tell, never a grade', () => {
  it('a failed call', () => {
    const out = synthesisFallback(prospect(), CLIENT_CTX, SIGNAL, 'Placeholder: the call failed')
    expect(out.icp_fit).toBe('cannot_tell')
    expect(out.icp_fit_missing).toContain('the call failed')
  })

  it('an answer with no text in it', () => {
    const out = judge('', { content: [] } as Partial<Message>)
    expect(out.icp_fit).toBe('cannot_tell')
    expect(out.icp_fit_missing).toContain('No text block')
  })

  it('an answer that is not JSON', () => {
    const out = judge('<reasoning>\nPlaceholder.\n</reasoning>\nthis is not json')
    expect(out.icp_fit).toBe('cannot_tell')
    expect(out.icp_fit_missing).toContain('non-JSON')
  })

  it('an answer whose icp_fit is not one of the four outcomes', () => {
    const out = judge(answer({ icp_fit: 'placeholder-not-an-outcome' }))
    expect(out.icp_fit).toBe('cannot_tell')
    expect(out.icp_fit_missing).toContain('not one of the four outcomes')
  })

  it('an answer with no icp_fit at all', () => {
    const out = judge(answer({}))
    expect(out.icp_fit).toBe('cannot_tell')
  })
})

describe('the prompt defines the four outcomes and sends no uncertainty to the middle value', () => {
  const prompt = buildSynthesisPrompt(CLIENT_CTX)
  const fitSection = prompt.slice(prompt.indexOf('ICP FIT ASSESSMENT'), prompt.indexOf('SIGNAL DIMENSION'))
  const sentences = (text: string) => text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)
  const UNCERTAIN = /\b(thin|sparse|guess\w*|uncertain|unsure|cautious\w*|reaching)\b/i

  it('the fit section was found, so the checks below read something', () => {
    expect(fitSection.length).toBeGreaterThan(500)
  })

  it('defines CANNOT_TELL and says it is never a fit', () => {
    expect(fitSection).toContain('CANNOT_TELL —')
    expect(fitSection).toMatch(/never counted as a fit/)
  })

  it('asks for every outcome the code accepts, and for what was missing', () => {
    const schemaLine = prompt.split('\n').find(l => l.trim().startsWith('"icp_fit":'))
    expect(schemaLine).toBeDefined()
    for (const outcome of ICP_FIT_OUTCOMES) expect(schemaLine).toContain(`"${outcome}"`)
    expect(prompt).toMatch(/"icp_fit_missing":/)
  })

  it('has no sentence that sends thin or uncertain evidence to MODERATE', () => {
    const offenders = sentences(fitSection).filter(s => /MODERATE/.test(s) && UNCERTAIN.test(s) && !/\bnever\b/i.test(s))
    expect(offenders).toEqual([])
  })

  it('defines MODERATE by what the prospect is, not by how thin the research was', () => {
    const moderate = fitSection.split(/\n\s*\n/).find(p => p.trimStart().startsWith('MODERATE —'))
    expect(moderate).toBeDefined()
    const offenders = sentences(moderate!).filter(s => UNCERTAIN.test(s) && !/\bnever\b/i.test(s))
    expect(offenders).toEqual([])
  })
})

describe('the database accepts every outcome the judge can record', () => {
  // Reads the migration files, so it proves the newest CHECK was WRITTEN with every outcome,
  // not that it is live. The live check is a read of pg_constraint after the migration is
  // applied. This test exists to catch the seam: an outcome added in code without the CHECK
  // being widened, which would fail every research write that records it.
  it('the newest migration that defines the icp_fit CHECK names every outcome', () => {
    // Comments are stripped before anything is matched. The migration's own explanation quotes
    // the new value, so a check that could see comments would pass with the value missing from
    // the CHECK itself.
    const dir = path.join(process.cwd(), 'supabase', 'migrations')
    const sqlOf = (f: string) => readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, '')
    const allowedLists = (sql: string) => [...sql.matchAll(/icp_fit\s*=\s*ANY\s*\(\s*ARRAY\[([^\]]*)\]/gi)].map(m => m[1])
    const defining = readdirSync(dir).filter(f => f.endsWith('.sql')).sort().filter(f => allowedLists(sqlOf(f)).length > 0)
    expect(defining.length).toBeGreaterThan(0)
    const lists = allowedLists(sqlOf(defining[defining.length - 1]))
    // Two tables carry the column, and each CHECK must name every outcome.
    expect(lists.length).toBe(2)
    for (const list of lists) for (const outcome of ICP_FIT_OUTCOMES) expect(list).toContain(`'${outcome}'`)
  })
})
