// THE WEAK GRADE READS THE CLIENT'S OWN DISQUALIFIERS. IT NAMES NONE OF ITS OWN.
//
// ─── WHY ─────────────────────────────────────────────────────────────────────
//
// The WEAK grade used to read: "Disqualifying evidence per the buyer profile (e.g. company
// too large, sales-led, prospect actively job-seeking)". The middle example is a way of
// operating, and no client document supplies it. It was one client's assumption promoted to
// a universal, and it graded against a client whose own ICP names the opposite as a
// REQUIREMENT: an organisation with existing distribution infrastructure and a sales team.
// Their best prospects were being marked WEAK by a rule nobody wrote for them.
//
// Every ICP tier already carries a `disqualifiers: string[]` (src/types/index.ts), populated
// for all five live organisations. The rule now reads that.
//
// ─── WHAT THIS FILE HOLDS ────────────────────────────────────────────────────
//
// 1. The loader surfaces the field, WHOLE. Truncation on a scoring input is a silent gate
//    removal, and this is exactly the shape CLAUDE.md warns about: the client with the most
//    disqualifiers keeps the load-bearing one LAST.
// 2. Absence is stated, not left silent, because silence reads as "none apply".
// 3. The regression guard: appending the disqualifier line must not switch off the honest
//    "this ICP is thin" fallback. That fallback fires on an ICP with no buyer, no stage and
//    no push forces, and the "none named" branch is a NON-EMPTY string, so folding it into
//    icpLines would have made that array length >= 1 forever and the gap would have gone
//    invisible behind a sentence about disqualifiers.
// 4. Rule Zero over the rendered prompt: the WEAK block names no market, sector, buyer type,
//    way of operating or problem domain.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildSynthesisPrompt } from '../prompts/synthesis-prompt'

// ─── The fake ────────────────────────────────────────────────────────────────
//
// It HONOURS from/select/eq/in/order/single and THROWS on anything else. A fake that
// silently returns its chain for an unimplemented filter cannot test that filter, and this
// codebase has paid for that three times over.

interface FakeRow { document_type: string; content: unknown; segment_id: string | null }

let fakeDocs: FakeRow[] = []
let fakeOrgName: string | null = 'ACME'

function makeChain(table: string) {
  const state: Record<string, unknown> = {}
  const chain: Record<string, unknown> = {
    select: (_cols: string) => chain,
    eq: (col: string, val: unknown) => { state[col] = val; return chain },
    in: (_col: string, _vals: unknown[]) => chain,
    order: () => {
      if (table !== 'strategy_documents') throw new Error(`fake: unexpected order() on ${table}`)
      return Promise.resolve({ data: fakeDocs, error: null })
    },
    single: () => {
      if (table === 'organisations') return Promise.resolve({ data: { name: fakeOrgName }, error: null })
      if (table === 'segments')      return Promise.resolve({ data: null, error: null })
      throw new Error(`fake: unexpected single() on ${table}`)
    },
    // Anything the code starts using that this fake does not model must fail loudly rather
    // than return an empty chain and let a test pass over a filter that stopped running.
    limit:  () => { throw new Error('fake does not implement limit()') },
    filter: () => { throw new Error('fake does not implement filter()') },
    not:    () => { throw new Error('fake does not implement not()') },
  }
  return chain
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: (table: string) => makeChain(table) }),
}))

const { loadClientContext } = await import('../synthesize')

const icp = (tier1: Record<string, unknown>): FakeRow =>
  ({ document_type: 'icp', content: { tier_1: tier1 }, segment_id: null })

const FULL_TIER1 = {
  buyer_profile:  { title: 'BUYER_TITLE' },
  company_profile: { stage: 'COMPANY_STAGE' },
  four_forces:    { push: ['PUSH_ONE', 'PUSH_TWO', 'PUSH_THREE'] },
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://fake'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'
  fakeOrgName = 'ACME'
  fakeDocs = []
})

describe('the client\'s disqualifiers reach the prompt', () => {
  it('surfaces every disqualifier the ICP names', async () => {
    fakeDocs = [icp({ ...FULL_TIER1, disqualifiers: ['DQ_ONE', 'DQ_TWO', 'DQ_THREE'] })]
    const ctx = await loadClientContext('org-1', null)
    expect(ctx.icpSummary).toContain('DQ_ONE')
    expect(ctx.icpSummary).toContain('DQ_TWO')
    expect(ctx.icpSummary).toContain('DQ_THREE')
  })

  // THE MUTATION THIS FILE EXISTS FOR. Push forces are sliced to 3, so a slice here would
  // have looked idiomatic. MargenticOS names SEVEN disqualifiers and the seventh is the one
  // that reproduces the removed example, so slice(0, 3) or slice(0, 5) would have dropped
  // precisely the criterion that keeps that client's grading stable. Any truncation fails.
  it('does NOT truncate, even past the length push forces are cut to', async () => {
    const seven = Array.from({ length: 7 }, (_, i) => `DQ_${i + 1}_UNIQUE`)
    fakeDocs = [icp({ ...FULL_TIER1, disqualifiers: seven })]
    const ctx = await loadClientContext('org-1', null)
    for (const d of seven) expect(ctx.icpSummary).toContain(d)
    // And the control: push IS still capped at three, so this test is really about the
    // difference between the two fields rather than about slicing in general.
    expect(ctx.icpSummary).not.toContain('PUSH_FOUR')
  })

  it('drops empty and non-string entries rather than emitting blank bullets', async () => {
    fakeDocs = [icp({ ...FULL_TIER1, disqualifiers: ['DQ_REAL', '', '   ', null, 42] })]
    const ctx = await loadClientContext('org-1', null)
    expect(ctx.icpSummary).toContain('DQ_REAL')
    expect(ctx.icpSummary).not.toMatch(/- \s*\n/)
  })

  it('states absence out loud, and tells the model not to supply its own', async () => {
    fakeDocs = [icp(FULL_TIER1)]
    const ctx = await loadClientContext('org-1', null)
    expect(ctx.icpSummary).toContain('named no disqualifying criteria')
    expect(ctx.icpSummary).toMatch(/do not supply criteria of your own/i)
  })
})

describe('appending the disqualifier line does not mask a thin ICP', () => {
  // The regression guard. The "none named" branch is a non-empty string, so if it were
  // folded into icpLines the emptiness check below would never fire again and a document
  // naming nothing at all would present as a document naming something.
  it('still reports a document with no buyer, stage or push forces as thin', async () => {
    fakeDocs = [icp({ disqualifiers: [] })]
    const ctx = await loadClientContext('org-1', null)
    expect(ctx.icpSummary).toContain('names no buyer title, company stage or push forces')
  })

  it('reports thinness even when disqualifiers ARE present, since those are not a profile', async () => {
    fakeDocs = [icp({ disqualifiers: ['DQ_ONE'] })]
    const ctx = await loadClientContext('org-1', null)
    expect(ctx.icpSummary).toContain('names no buyer title, company stage or push forces')
    expect(ctx.icpSummary).toContain('DQ_ONE')
  })

  it('leaves the no-ICP-document case alone', async () => {
    fakeDocs = []
    const ctx = await loadClientContext('org-1', null)
    expect(ctx.icpSummary).toBe('No ICP document available yet.')
  })
})

describe('RULE ZERO: the WEAK grade names no market of its own', () => {
  const rendered = buildSynthesisPrompt({
    clientName: 'CLIENT_NAME',
    icpSummary: 'ICP_SUMMARY',
    positioningSummary: 'POSITIONING_SUMMARY',
    valuePropContext: 'VALUE_PROP',
    tovRules: 'TOV_RULES',
  })
  const weakBlock = rendered.slice(rendered.indexOf('WEAK — '), rendered.indexOf('Grade cautiously'))

  it('no longer carries the removed way-of-operating example', () => {
    expect(weakBlock).not.toMatch(/sales-led/i)
    expect(rendered).not.toMatch(/sales-led/i)
  })

  it('names no market, sector, buyer type, business model or problem domain', () => {
    // Each of these would be one client's assumption standing in for every client's.
    for (const banned of [
      'sales-led', 'founder-led', 'owner-led', 'product-led',
      'consulting', 'consultant', 'coaching', 'agency', 'SaaS', 'e-commerce',
      'B2C', 'freelancer', 'pipeline', 'marketing', 'client acquisition',
    ]) {
      expect(weakBlock.toLowerCase()).not.toContain(banned.toLowerCase())
    }
  })

  it('points at the client context as the only source of disqualifying criteria', () => {
    expect(weakBlock).toMatch(/disqualifying criteria named in the\s+client context above/)
    expect(weakBlock).toMatch(/the only\s+disqualifying criteria that exist here/)
  })

  it('handles the no-criteria case explicitly, rather than leaving it open', () => {
    expect(weakBlock).toMatch(/not an invitation to supply your own/)
  })
})
