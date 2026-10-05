// The research loader reads each trigger's DEFINITION from the client's ICP and hands it to
// synthesis (2026-10-03). The other half of this rule, the check before the writer, is in
// trigger-definition.test.ts.
//
// END TO END FROM THE DOCUMENT: the ICP row a fake database returns, through
// loadClientContext, into the system prompt synthesis is sent. A test on the loader alone
// and a test on the renderer alone would each pass with the hop between them missing.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildSynthesisPrompt } from '../prompts/synthesis-prompt'

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

// Honours from/select/eq/in/order/single and THROWS on anything else, so a filter this fake
// does not model cannot be passed over silently.
let fakeDocs: Array<{ document_type: string; content: unknown; segment_id: string | null }> = []

function makeChain(table: string) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => {
      if (table !== 'strategy_documents') throw new Error(`fake: unexpected order() on ${table}`)
      return Promise.resolve({ data: fakeDocs, error: null })
    },
    single: () => {
      if (table === 'organisations') return Promise.resolve({ data: { name: 'ACME' }, error: null })
      if (table === 'segments') return Promise.resolve({ data: null, error: null })
      throw new Error(`fake: unexpected single() on ${table}`)
    },
    limit: () => { throw new Error('fake does not implement limit()') },
    filter: () => { throw new Error('fake does not implement filter()') },
    not: () => { throw new Error('fake does not implement not()') },
  }
  return chain
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: (table: string) => makeChain(table) }),
}))

const { loadClientContext } = await import('../synthesize')

const DEFINITION = 'Counts: a second site that serves customers. Does not count: a storage unit or a registered address.'

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://fake'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'
  fakeDocs = [{
    document_type: 'icp', segment_id: null,
    content: { tier_1: {
      buyer_profile: { title: 'BUYER_TITLE' },
      triggers: [
        { trigger: 'A new site is opened.', reason: 'A new site means reaching a new area.', definition: DEFINITION },
        { trigger: 'An award is won.', reason: 'An award opens doors for a short while.' },
      ],
    } },
  }]
})

describe('the definition reaches synthesis from the client\'s document', () => {
  it('PLANTED: loadClientContext carries the definition on its trigger, and adds no key where there is none', async () => {
    const ctx = await loadClientContext('org-1', null)
    expect(ctx.triggers[0]).toEqual({ trigger: 'A new site is opened.', reason: 'A new site means reaching a new area.', definition: DEFINITION })
    expect(ctx.triggers[1]).not.toHaveProperty('definition')
  })

  it('PLANTED: the definition is in the system prompt synthesis is sent, under its own trigger', async () => {
    const prompt = buildSynthesisPrompt(await loadClientContext('org-1', null))
    const at = prompt.indexOf('A new site is opened.')
    expect(at).toBeGreaterThan(-1)
    expect(prompt.indexOf(DEFINITION)).toBeGreaterThan(at)
    expect(prompt.indexOf(DEFINITION)).toBeLessThan(prompt.indexOf('An award is won.'))
  })
})
