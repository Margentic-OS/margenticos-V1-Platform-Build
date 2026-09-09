// @vitest-environment jsdom
//
// The spend notice tells the truth about what the button is about to do.
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE TWO DEFECTS THIS LOCKS OUT, both measured 2026-09-09
//
// 1. THE ALARM WAS WHERE IT COULD NOT BE ACTED ON. EnrichmentModeBanner rendered on every
//    operator screen from the layout, and `enrichment_live` is true in production, so it
//    was a permanent red banner describing the normal working state. Always-on red is not
//    a warning, it is a background colour, and it costs the operator the ability to notice
//    a real one.
//
// 2. THE FALSE REASSURANCE WAS WHERE THE ACTION HAPPENS. Both point-of-spend warnings
//    carried this as a HARDCODED string, conditional on nothing:
//
//        "Currently in test mode. No live API calls will be made."
//          — Gate1ApproveBatch.tsx:324, PipelineOverview.tsx:424
//
//    while `integrations_registry.config.enrichment_live` was `true`. So at the moment an
//    operator was about to spend real Apollo credits, the interface said the opposite of
//    the truth, in a calm colour.
//
// Defect 2 is the dangerous one, and it is the reason "just delete the noisy banner" was
// the wrong fix: deleting it would have removed the only thing on screen contradicting the
// lie, and left the lie exactly where it does damage.
//
// The notice is now driven by the SAME flag that shouldUseMockEnrichment reads to decide
// whether enrichment really calls Apollo. The strings it replaced could not drift from
// behaviour because they were never connected to it.

import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { EnrichmentSpendNotice } from '../enrichment-spend-notice'

afterEach(cleanup)

describe('EnrichmentSpendNotice', () => {
  it('says credits WILL be spent when enrichment is live', () => {
    render(<EnrichmentSpendNotice mode="live" action="Enrichment" />)

    expect(screen.getByText(/will spend real enrichment credits/i)).toBeInTheDocument()
    expect(screen.getByText(/Live enrichment is ON/i)).toBeInTheDocument()
  })

  it('NEVER claims test mode when enrichment is live — the exact defect', () => {
    // The replaced string was "Currently in test mode. No live API calls will be made."
    // If that sentence can appear while mode is 'live' again, this is back.
    render(<EnrichmentSpendNotice mode="live" action="Enrichment" />)

    expect(screen.queryByText(/test mode/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/no live API calls/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/consume no credits/i)).not.toBeInTheDocument()
  })

  it('says no credits are spent when enrichment is off', () => {
    render(<EnrichmentSpendNotice mode="test" action="Enrichment" />)

    expect(screen.getByText(/Live enrichment is currently OFF/i)).toBeInTheDocument()
    expect(screen.getByText(/consume no credits/i)).toBeInTheDocument()
  })

  it('refuses to reassure when the flag could not be read', () => {
    // 'unknown' must not read like 'test'. Saying "no credits" when nobody knows is the
    // failure the amber state was invented for.
    render(<EnrichmentSpendNotice mode="unknown" action="Enrichment" />)

    expect(screen.getByText(/Cannot tell whether/i)).toBeInTheDocument()
    expect(screen.getByText(/may be live and consuming/i)).toBeInTheDocument()
    expect(screen.queryByText(/consume no credits/i)).not.toBeInTheDocument()
  })

  it('names the action, so the notice matches the button beside it', () => {
    render(<EnrichmentSpendNotice mode="live" action="Enrich and tier" />)
    expect(screen.getByText(/Enrich and tier will spend/i)).toBeInTheDocument()
  })

  it('POSITIVE CONTROL: the three modes render three different messages', () => {
    // If the component ever collapses to one branch, every assertion above could pass on
    // whichever branch survived. This checks the branches are actually distinct.
    const texts = (['live', 'test', 'unknown'] as const).map((mode) => {
      cleanup()
      const { container } = render(<EnrichmentSpendNotice mode={mode} action="Enrichment" />)
      return container.textContent ?? ''
    })
    expect(new Set(texts).size).toBe(3)
  })
})

// ─── The global banner fires ONLY when the setting cannot be determined ──────
//
// The rule lives in shouldShowGlobalEnrichmentBanner rather than as a condition inside the
// operator layout, because the layout is an async server component that does auth and two
// database reads before it renders anything. Testing the rule where it is decided means
// this can be asserted directly instead of through a mock of the whole page.

import { shouldShowGlobalEnrichmentBanner } from '../enrichment-mode-banner'

describe('when the enrichment banner is allowed to take the whole screen', () => {
  it('does NOT render when the setting is known and live', () => {
    // The defect: enrichment_live is true in production, so this rendered a red banner on
    // every operator screen, permanently, about the system working normally.
    expect(shouldShowGlobalEnrichmentBanner('live')).toBe(false)
  })

  it('does NOT render when the setting is known and off', () => {
    expect(shouldShowGlobalEnrichmentBanner('test')).toBe(false)
  })

  it('DOES render when the setting cannot be determined', () => {
    // Not a description of the system, but the absence of one: nobody can say whether
    // enrichment is spending, so the correct action is to stop.
    expect(shouldShowGlobalEnrichmentBanner('unknown')).toBe(true)
  })

  it('is loud for exactly one of the three states, and it is not a known one', () => {
    // Guards the whole rule rather than three cases separately. If a future edit makes two
    // states loud, or moves loudness onto a known state, this fails even if the individual
    // assertions above were updated to match.
    const loud = (['live', 'test', 'unknown'] as const).filter(shouldShowGlobalEnrichmentBanner)
    expect(loud).toEqual(['unknown'])
  })
})
