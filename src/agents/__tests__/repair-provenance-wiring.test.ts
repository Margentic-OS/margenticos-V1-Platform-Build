// The guard exists AND the repair actually calls it.
//
// A pure guard with passing tests proves nothing about whether the code path that needs it
// runs it. That gap is its own failure class in this codebase: a check that is correct,
// tested, and never reached reports exactly the same green as one that is working.
//
// verifyRepairContext is the single point where the repair builds its context and decides
// whether to proceed. These tests drive it directly with a controlled context, so removing
// the assertSourceVersionsUnchanged call from it turns them red.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// Only buildVariantGenerationContext is replaced. importOriginal keeps every other export
// real, because a whole-module mock silently drops exports the module gains later.
vi.mock('@/agents/messaging-generation-agent', async importOriginal => {
  const actual = await importOriginal<typeof import('@/agents/messaging-generation-agent')>()
  return { ...actual, buildVariantGenerationContext: vi.fn() }
})

import { buildVariantGenerationContext } from '@/agents/messaging-generation-agent'
import { verifyRepairContext, type RepairTarget } from '../messaging-variant-repair-agent'
import { SourceProvenanceError } from '@/lib/messaging/source-provenance'

const REASON_V5 = 'Variants passed: A, C, D. Source documents: ICP v5, Positioning v2, TOV v3.'

function contextWith(icp: string, positioning: string, tov: string) {
  return {
    intake: [], patterns: [], completeness: 100, existingDocument: null,
    upstreamAssumptions: [], regeneration_notes: undefined,
    preflight: { org_name: 'Northpoint', sender_first_name: 'Alex', company_name: 'Northpoint' },
    requiredDocs: {
      icp: { id: 'i', document_type: 'icp', version: icp, plain_text: null, content: {}, status: 'active' },
      positioning: { id: 'p', document_type: 'positioning', version: positioning, plain_text: null, content: {}, status: 'active' },
      tov: { id: 't', document_type: 'tov', version: tov, plain_text: null, content: {}, status: 'active' },
    },
  }
}

const TARGET: RepairTarget = {
  organisation_id: 'org-1',
  before: JSON.stringify({ variants: { A: { emails: [] } } }),
  suggestion_reason: REASON_V5,
  survivors: {},
  fingerprintsBefore: new Map(),
}

// Throws on any use. verifyRepairContext must not touch the database itself: everything it
// reads comes through buildVariantGenerationContext, and a fake that silently accepted
// stray calls would hide it doing otherwise.
// Symbols and the handful of keys assertion libraries probe pass through as undefined, so
// this object can be inspected and compared. Everything else throws, so a real client call
// (`.from`, `.rpc`, `.schema`) fails loudly instead of being silently swallowed.
const INTROSPECTION = new Set(['constructor', 'then', 'catch', 'finally', 'toJSON', 'nodeType', '$$typeof', 'asymmetricMatch', 'hasAttribute', 'tagName'])
const supabase = new Proxy({}, {
  get(_t, prop) {
    if (typeof prop === 'symbol' || INTROSPECTION.has(prop)) return undefined
    throw new Error(`verifyRepairContext used supabase.${String(prop)} directly`)
  },
}) as unknown as SupabaseClient

describe('verifyRepairContext runs the provenance guard', () => {
  beforeEach(() => vi.mocked(buildVariantGenerationContext).mockReset())

  // LOAD BEARING. Remove the assertSourceVersionsUnchanged call and this goes green-to-red.
  it('REFUSES when the live ICP is newer than the one the survivors were written against', async () => {
    vi.mocked(buildVariantGenerationContext).mockResolvedValue(contextWith('6', '2', '3') as never)

    await expect(verifyRepairContext(supabase, TARGET, 'B'))
      .rejects.toThrow(SourceProvenanceError)
  })

  it('names the ICP and both versions when it refuses', async () => {
    vi.mocked(buildVariantGenerationContext).mockResolvedValue(contextWith('6', '2', '3') as never)

    await expect(verifyRepairContext(supabase, TARGET, 'B'))
      .rejects.toThrow(/ICP\s+recorded v5, now v6\s+CHANGED/)
  })

  it('REFUSES when Positioning moved, not only when the ICP did', async () => {
    vi.mocked(buildVariantGenerationContext).mockResolvedValue(contextWith('5', '3', '3') as never)

    await expect(verifyRepairContext(supabase, TARGET, 'B')).rejects.toThrow(/Positioning/)
  })

  it('REFUSES a target whose suggestion recorded no provenance', async () => {
    vi.mocked(buildVariantGenerationContext).mockResolvedValue(contextWith('5', '2', '3') as never)

    await expect(verifyRepairContext(supabase, { ...TARGET, suggestion_reason: 'no record here' }, 'B'))
      .rejects.toThrow(/does not record which strategy documents/)
  })

  // THE INVERSE CONTROL. A guard that refuses every repair is an outage, not a control.
  it('PROCEEDS and returns the verified versions when nothing moved', async () => {
    vi.mocked(buildVariantGenerationContext).mockResolvedValue(contextWith('5', '2', '3') as never)

    const { sourceVersions, context } = await verifyRepairContext(supabase, TARGET, 'B')
    expect(sourceVersions).toEqual({ icp: '5', positioning: '2', tov: '3' })
    expect(context.preflight.sender_first_name).toBe('Alex')
  })

  // ADR-038: a repair replaces no rejected suggestion, so no rejection note applies to it.
  it('builds context with no regeneration notes', async () => {
    vi.mocked(buildVariantGenerationContext).mockResolvedValue(contextWith('5', '2', '3') as never)

    await verifyRepairContext(supabase, TARGET, 'B')
    expect(vi.mocked(buildVariantGenerationContext)).toHaveBeenCalledWith(supabase, 'org-1', undefined)
  })
})
