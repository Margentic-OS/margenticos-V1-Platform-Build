// The research pipeline's hook. In its resting states it must touch NOTHING: the database
// stand-in throws on any access, so a branch that reached for it would fail this test.

import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { maybeRunFirmFactAfterResearch } from '../firm-fact'
import { buildMessagingContent } from '@/agents/outbound-template-agent'
import { INVENTED_OPENER_FRAMES, INVENTED_SIGNOFF, inventedBrief, inventedVariants } from '@/lib/outbound-templates/__tests__/fixtures/invented-client'

function untouchable() {
  const touched: string[] = []
  const db = new Proxy({}, {
    get(_t, prop) {
      touched.push(String(prop))
      throw new Error(`database touched: ${String(prop)}`)
    },
  }) as unknown as SupabaseClient
  return { db, touched }
}

function content(enabled: boolean) {
  return buildMessagingContent({
    base: {}, brief: inventedBrief(),
    result: { opener_frames: INVENTED_OPENER_FRAMES, variants: inventedVariants() },
    signoff: INVENTED_SIGNOFF, firmFactTierEnabled: enabled,
  })
}

describe('maybeRunFirmFactAfterResearch', () => {
  it.each([
    ['the opening was written', content(true), true],
    ['the tier is off', content(false), false],
    ['the document has no brief', { variants: {}, firm_fact_tier: { enabled: true } }, false],
  ])('does nothing when %s', async (_name, messagingContent, openingWritten) => {
    const { db, touched } = untouchable()
    await maybeRunFirmFactAfterResearch({
      supabase: db, apiKey: 'x', organisationId: 'o', prospectId: 'p',
      messagingContent, openingWritten, usagePath: 'inline',
    })
    expect(touched).toEqual([])
  })

  it('reaches for the database when the tier is on and the prospect is template-bound (control)', async () => {
    const { db, touched } = untouchable()
    await maybeRunFirmFactAfterResearch({
      supabase: db, apiKey: 'x', organisationId: 'o', prospectId: 'p',
      messagingContent: content(true), openingWritten: false, usagePath: 'inline',
    })
    expect(touched.length).toBeGreaterThan(0)   // and the throw was swallowed: never throws
  })
})
