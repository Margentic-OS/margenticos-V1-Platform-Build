// @vitest-environment jsdom
//
// S2 fix-pass: renderer verification against REAL schemas pulled from DRY RUN org.
// Exit criteria: PASS on every top-level field for every doc type, zero MISS/PARTIAL/CRASH.
// Fixtures: src/components/approvals/__tests__/fixtures/*.json

import React from 'react'
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import ApprovalCard, { type PendingSuggestion } from '../ApprovalCard'

import icpFixture from './fixtures/icp-real.json'
import tovFixture from './fixtures/tov-real.json'
import positioningFixture from './fixtures/positioning-real.json'
import messagingFixture from './fixtures/messaging-real.json'

// ─── Error boundary ───────────────────────────────────────────────────────────

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { crashed: boolean }
> {
  state = { crashed: false }
  static getDerivedStateFromError() { return { crashed: true } }
  render() {
    if (this.state.crashed) return <div data-testid="render-crash" />
    return this.props.children
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// React 18 dev mode re-throws caught errors as window ErrorEvents even when an
// ErrorBoundary handles them. Suppress so vitest doesn't treat them as uncaught failures.
const suppressWindowError = (e: ErrorEvent) => e.preventDefault()

beforeAll(() => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
})
beforeEach(() => {
  window.addEventListener('error', suppressWindowError)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  window.removeEventListener('error', suppressWindowError)
  vi.restoreAllMocks()
})

function makeSuggestion(docType: string, payload: unknown): PendingSuggestion {
  return {
    id: 'test-id',
    organisation_id: 'a2b621fc-4c9d-43d9-9af4-1253ff49d12d',
    document_type: docType,
    field_path: 'full_document',
    current_value: null,
    suggested_value: JSON.stringify(payload),
    suggestion_reason: 'S2 fix-pass renderer verification',
    created_at: '2026-06-06T00:00:00Z',
    organisations: { name: 'DRY RUN Org' },
  }
}

function renderCard(docType: string, payload: unknown) {
  return render(
    <ErrorBoundary>
      <ApprovalCard suggestion={makeSuggestion(docType, payload)} onResolved={vi.fn()} />
    </ErrorBoundary>
  )
}

function didCrash() {
  return screen.queryByTestId('render-crash') !== null
}

// ─── Messaging — 1 payload field ─────────────────────────────────────────────
// Field: variants

describe('Messaging — 1 payload field', () => {
  it('PASS: variants renders A/B tab buttons without crash', () => {
    renderCard('messaging', messagingFixture)
    expect(didCrash()).toBe(false)
    expect(screen.getByText('Variant A')).toBeInTheDocument()
    expect(screen.getByText('Variant B')).toBeInTheDocument()
  })

  it('PASS: active variant shows email 1 header', () => {
    renderCard('messaging', messagingFixture)
    const emailOnes = screen.getAllByText('Email 1')
    expect(emailOnes.length).toBeGreaterThanOrEqual(1)
  })
})

// ─── ICP — 5 payload fields ───────────────────────────────────────────────────
// Fields: summary, jtbd_statement, tier_1, tier_2, tier_3

describe('ICP — 5 payload fields', () => {
  it('PASS: summary renders as readable text', () => {
    renderCard('icp', icpFixture)
    expect(didCrash()).toBe(false)
    expect(screen.getByText(icpFixture.summary)).toBeInTheDocument()
  })

  it('PASS: jtbd_statement renders as readable text', () => {
    renderCard('icp', icpFixture)
    expect(screen.getByText(icpFixture.jtbd_statement)).toBeInTheDocument()
  })

  it('PASS: tier_1 label "Ideal Client" renders as distinct text node', () => {
    renderCard('icp', icpFixture)
    expect(screen.getByText('Ideal Client')).toBeInTheDocument()
  })

  it('PASS: tier_2 label "Good Client" renders as distinct text node', () => {
    renderCard('icp', icpFixture)
    expect(screen.getByText('Good Client')).toBeInTheDocument()
  })

  it('PASS: tier_3 label "Do Not Target" renders as distinct text node', () => {
    renderCard('icp', icpFixture)
    expect(screen.getByText('Do Not Target')).toBeInTheDocument()
  })
})

// ─── TOV — 9 payload fields ───────────────────────────────────────────────────
// Fields: voice_summary, voice_style_note, voice_characteristics,
//         do_dont_list, vocabulary, writing_rules, what_this_voice_never_does,
//         before_after_examples, sentence_mechanics

describe('TOV — 9 payload fields', () => {
  it('PASS: voice_summary renders as readable text', () => {
    renderCard('tov', tovFixture)
    expect(didCrash()).toBe(false)
    expect(screen.getByText(tovFixture.voice_summary)).toBeInTheDocument()
  })

  it('PASS: voice_style_note renders as readable text', () => {
    renderCard('tov', tovFixture)
    expect(screen.getByText(tovFixture.voice_style_note)).toBeInTheDocument()
  })

  it('PASS: voice_characteristics[0].characteristic renders', () => {
    renderCard('tov', tovFixture)
    expect(screen.getByText('Blunt diagnosis delivered early')).toBeInTheDocument()
  })

  it('PASS: do_dont_list.do[] items render (not just section header)', () => {
    renderCard('tov', tovFixture)
    expect(
      screen.getByText('Open with a specific observation about the reader\'s situation.'),
    ).toBeInTheDocument()
  })

  it('PASS: vocabulary.words_they_use[] items render as chips', () => {
    renderCard('tov', tovFixture)
    expect(screen.getByText('fair enough')).toBeInTheDocument()
  })

  it('PASS: writing_rules[0].rule renders', () => {
    renderCard('tov', tovFixture)
    expect(screen.getByText('Never open with I or We')).toBeInTheDocument()
  })

  it('PASS: what_this_voice_never_does[0].rule renders', () => {
    renderCard('tov', tovFixture)
    expect(screen.getByText('Never uses exclamation marks')).toBeInTheDocument()
  })

  it('PASS: before_after_examples[0].context renders', () => {
    renderCard('tov', tovFixture)
    expect(
      screen.getByText(
        'LinkedIn first message to a founder/MD of a £5m recruitment firm with 30 staff, based in the UK.',
      ),
    ).toBeInTheDocument()
  })

  it('PASS: sentence_mechanics.dominant_sentence_length renders', () => {
    renderCard('tov', tovFixture)
    expect(screen.getByText(tovFixture.sentence_mechanics.dominant_sentence_length)).toBeInTheDocument()
  })
})

// ─── Positioning — 9 payload fields ──────────────────────────────────────────
// Fields: positioning_summary, moore_positioning, market_category, unique_attributes,
//         value_themes, competitive_alternatives, best_fit_characteristics,
//         competitive_landscape, key_messages

describe('Positioning — 9 payload fields', () => {
  it('PASS: positioning_summary renders as readable text', () => {
    renderCard('positioning', positioningFixture)
    expect(didCrash()).toBe(false)
    expect(screen.getByText(positioningFixture.positioning_summary)).toBeInTheDocument()
  })

  it('PASS: moore_positioning.compressed_positioning_statement renders', () => {
    renderCard('positioning', positioningFixture)
    expect(
      screen.getByText(positioningFixture.moore_positioning.compressed_positioning_statement),
    ).toBeInTheDocument()
  })

  it('PASS: market_category.chosen_category renders as distinct text', () => {
    renderCard('positioning', positioningFixture)
    expect(
      screen.getByText('Embedded fractional COO for founder-led service businesses'),
    ).toBeInTheDocument()
  })

  it('PASS: unique_attributes[0].what_it_is renders', () => {
    renderCard('positioning', positioningFixture)
    expect(screen.getByText(positioningFixture.unique_attributes[0].what_it_is)).toBeInTheDocument()
  })

  it('PASS: value_themes[0] — theme, for_whom, and outcome_statement all render', () => {
    renderCard('positioning', positioningFixture)
    expect(screen.getByText('The business runs without the founder in the room')).toBeInTheDocument()
    expect(screen.getByText(positioningFixture.value_themes[0].for_whom)).toBeInTheDocument()
    expect(
      screen.getByText(positioningFixture.value_themes[0].outcome_statement),
    ).toBeInTheDocument()
  })

  it('PASS: competitive_alternatives[0].name renders', () => {
    renderCard('positioning', positioningFixture)
    expect(
      screen.getByText('Keep running it themselves and hope the next hire fixes it'),
    ).toBeInTheDocument()
  })

  it('PASS: best_fit_characteristics.must_haves[0] renders', () => {
    renderCard('positioning', positioningFixture)
    expect(
      screen.getByText(positioningFixture.best_fit_characteristics.must_haves[0]),
    ).toBeInTheDocument()
  })

  it('PASS: competitive_landscape.white_space renders', () => {
    renderCard('positioning', positioningFixture)
    expect(
      screen.getByText(positioningFixture.competitive_landscape.white_space),
    ).toBeInTheDocument()
  })

  it('PASS: key_messages.cold_outreach_hook renders', () => {
    renderCard('positioning', positioningFixture)
    expect(
      screen.getByText('Still the one answering every question that shouldn\'t reach you?'),
    ).toBeInTheDocument()
  })
})

// ─── Crash fallback (requirement 3) ──────────────────────────────────────────
// Every renderer wraps its body in try/catch → renderCrashFallback on any throw.
// A malformed or future-shaped payload renders ugly — it never takes down the approvals page.

describe('Crash fallback — malformed payloads never crash the approvals page', () => {
  it('TOV: writing_rules as array of null values falls back gracefully', () => {
    // null items cause TypeError in the old renderer (.rule on null); try/catch catches it
    const broken = { voice_summary: 'test summary', writing_rules: [null, null] }
    renderCard('tov', broken)
    expect(didCrash()).toBe(false)
    // voice_summary was set before the crash point so it may or may not render;
    // the key guarantee is the ErrorBoundary was never triggered
  })

  it('Positioning: moore_positioning as a primitive does not crash', () => {
    // Old renderer passed {doc.moore_positioning} as a React child, crashing on object.
    // New renderer accesses .compressed_positioning_statement safely — no crash either way.
    const payload = { positioning_summary: 'safe summary text', moore_positioning: 'unexpected string' }
    renderCard('positioning', payload)
    expect(didCrash()).toBe(false)
    expect(screen.getByText('safe summary text')).toBeInTheDocument()
  })

  it('ICP: tier_1 with entirely wrong structure renders without crash', () => {
    const payload = { summary: 'icp summary text', tier_1: { label: 'Weird Tier', extra_unknown_field: 'surprise' } }
    renderCard('icp', payload)
    expect(didCrash()).toBe(false)
    expect(screen.getByText('icp summary text')).toBeInTheDocument()
    expect(screen.getByText('Weird Tier')).toBeInTheDocument()
  })

  it('Messaging: completely empty variants object does not crash', () => {
    const payload = { variants: {} }
    renderCard('messaging', payload)
    expect(didCrash()).toBe(false)
  })
})

// ─── Amendment 7: renderUnknownFields surfaces unknown keys ───────────────────

describe('renderUnknownFields — amendment 7 fallback', () => {
  it('surfaces a fake string field injected into a positioning payload', () => {
    const payload = { ...positioningFixture, _fake_field_xyz: 'sentinel-value-abc' }
    renderCard('positioning', payload)
    expect(didCrash()).toBe(false)
    expect(screen.getByText('sentinel-value-abc')).toBeInTheDocument()
  })

  it('renders the fake key label with underscores replaced by spaces', () => {
    const payload = { ...positioningFixture, _fake_field_xyz: 'sentinel-value-abc' }
    renderCard('positioning', payload)
    expect(screen.getByText('fake field xyz')).toBeInTheDocument()
  })
})
