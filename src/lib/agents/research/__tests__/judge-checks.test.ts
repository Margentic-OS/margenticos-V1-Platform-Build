// What the fit judge is asked to establish.
//
// A client's profile can name facts that no research source can establish, and the judge
// returned cannot_tell for them: 11 of 17 former moderates, every one naming the same
// unobtainable fact. It now lists such facts as unestablished and grades on what it can
// establish, so the gap stays visible without deciding the outcome.
//
// It is also asked to establish three things that define the customer and that nothing had
// ever measured, all from evidence research already gathers: whether the role is the person's
// main occupation, whether they run the business, and whether the people the business sells
// to are reachable by the client's channel. Removing any one of them fails a test below.

import { describe, it, expect } from 'vitest'
import type { Message } from '@anthropic-ai/sdk/resources/messages'
import { synthesisFromMessage, synthesisFallback, type ClientDocContext, type DetectedSignal } from '../synthesize'
import { buildSynthesisPrompt } from '../prompts/synthesis-prompt'
import { FIT_CHECKS, FIT_CHECK_RESULTS, type FitCheckName, type ProspectContext } from '../types'

const CLIENT_CTX: ClientDocContext = {
  clientName:         'Placeholder Client',
  buyerTitle:         'Placeholder Buyer',
  icpSummary:         'Placeholder summary of who the client sells to.',
  positioningSummary: 'Placeholder positioning, naming the placeholder channel the client sells through.',
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

function message(text: string): Message {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as Message
}

function answer(fields: Record<string, unknown>): string {
  return `<reasoning>\nPlaceholder reasoning.\n</reasoning>\n${JSON.stringify({
    icp_fit: 'moderate', qualification_status: 'qualified', confidence: 'medium', relevance_reason: 'Placeholder.',
    trigger_text: null, selected_candidate_id: null, candidates: [], ...fields,
  }, null, 2)}`
}

const judge = (text: string) => synthesisFromMessage(message(text), prospect(), CLIENT_CTX, SIGNAL)

const ANSWERED: Record<FitCheckName, { result: string; evidence: string }> = {
  primary_occupation:   { result: 'no',             evidence: 'Placeholder: a concurrent full-time role elsewhere.' },
  runs_the_business:    { result: 'yes',            evidence: 'Placeholder: runs the business day to day.' },
  reachable_by_channel: { result: 'not_applicable', evidence: 'Placeholder: the client context names no channel.' },
}

describe('the three checks', () => {
  it('are exactly these three', () => {
    expect([...FIT_CHECKS]).toEqual(['primary_occupation', 'runs_the_business', 'reachable_by_channel'])
  })

  it.each(FIT_CHECKS)('%s is carried from the answer, with its evidence', name => {
    const out = judge(answer({ fit_checks: ANSWERED }))
    expect(out.fit_checks[name]).toEqual(ANSWERED[name])
  })

  it.each(FIT_CHECKS)('%s is unknown, never yes or no, when the judge does not answer it', name => {
    const rest = Object.fromEntries(Object.entries(ANSWERED).filter(([k]) => k !== name))
    const out = judge(answer({ fit_checks: rest }))
    expect(out.fit_checks[name].result).toBe('unknown')
  })

  it('an answer outside the accepted results is unknown', () => {
    const out = judge(answer({ fit_checks: { ...ANSWERED, runs_the_business: { result: 'placeholder-not-a-result', evidence: 'x' } } }))
    expect(out.fit_checks.runs_the_business.result).toBe('unknown')
  })

  it('a failed answer records every check as unknown, with the reason', () => {
    const out = synthesisFallback(prospect(), CLIENT_CTX, SIGNAL, 'Placeholder: the call failed')
    for (const name of FIT_CHECKS) {
      expect(out.fit_checks[name].result).toBe('unknown')
      expect(out.fit_checks[name].evidence).toContain('the call failed')
    }
  })
})

describe('facts no source can establish are listed, not graded on', () => {
  it('carries the facts the judge could not establish, so the gap stays visible', () => {
    const out = judge(answer({ icp_fit_unestablished: ['Placeholder fact A', '  ', 'Placeholder fact B'] }))
    expect(out.icp_fit_unestablished).toEqual(['Placeholder fact A', 'Placeholder fact B'])
  })

  it('records none, not a guess, when the answer gives no list', () => {
    expect(judge(answer({})).icp_fit_unestablished).toEqual([])
  })
})

describe('the prompt asks for each check and for the unestablished facts', () => {
  const prompt = buildSynthesisPrompt(CLIENT_CTX)
  const fitSection = prompt.slice(prompt.indexOf('ICP FIT ASSESSMENT'), prompt.indexOf('SIGNAL DIMENSION'))
  const schema = prompt.slice(prompt.indexOf('"fit_checks"'))

  it('the fit section and the output format were both found', () => {
    expect(fitSection.length).toBeGreaterThan(500)
    expect(prompt.indexOf('"fit_checks"')).toBeGreaterThan(-1)
  })

  it.each(FIT_CHECKS)('defines %s in the fit section', name => {
    expect(fitSection).toMatch(new RegExp(`•\\s*${name} —`))
  })

  it.each(FIT_CHECKS)('asks for %s in the output, with a result', name => {
    expect(schema).toMatch(new RegExp(`"${name}":\\s*\\{\\s*"result"`))
  })

  it('offers only results the code accepts', () => {
    const offered = [...schema.slice(0, schema.indexOf('}\n  },') + 1).matchAll(/"result":\s*([^,]+(?:\s+or\s+"[a-z_]+")*)/g)]
      .flatMap(m => [...m[1].matchAll(/"([a-z_]+)"/g)].map(v => v[1]))
    expect(offered.length).toBeGreaterThan(0)
    for (const value of offered) expect(FIT_CHECK_RESULTS as readonly string[]).toContain(value)
  })

  it('never lets an unestablished fact decide cannot_tell or weak', () => {
    expect(fitSection).toMatch(/never the reason for CANNOT_TELL\s+and never the reason for WEAK/)
    expect(fitSection).toMatch(/An unestablished fact never makes it so/)
    expect(prompt).toMatch(/"icp_fit_unestablished":/)
  })

  it('names no market, buyer type or money figure in the fit section', () => {
    const lower = fitSection.toLowerCase()
    for (const word of ['revenue', 'turnover', 'founder', 'consult', 'coach', 'agency', 'saas', 'b2b', 'b2c', 'b2g', 'e-commerce', 'freelanc', 'pipeline', 'marketing']) {
      expect(lower).not.toContain(word)
    }
    expect(fitSection).not.toMatch(/[$£€]\s?\d|\d\s?(k|m|bn)\b/i)
  })
})
