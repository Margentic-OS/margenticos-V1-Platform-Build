// @vitest-environment jsdom
//
// S2 verification: payload-field-count vs rendered-field-count for each doc type.
// Fixtures use the REAL schemas from DRY RUN org (a2b621fc), verified 2026-06-06.
//
// Three outcomes per field:
//   PASS   — content appears in DOM as intended
//   CRASH  — renderer passes object directly as React child → component throws
//   MISS   — renderer silently drops the field (wrong type assumption, wrong key name)

import React from 'react'
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import ApprovalCard, { type PendingSuggestion } from '../ApprovalCard'

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
// ErrorBoundary handles them. We suppress those events so vitest doesn't treat
// them as uncaught exceptions failing the whole suite.
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
    suggestion_reason: 'S2 renderer verification',
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

// ─── Messaging (1 payload field: variants) ────────────────────────────────────
// Verdict: 1/1 PASS

const MESSAGING_FIXTURE = {
  variants: {
    A: {
      emails: [
        { sequence_position: 1, subject_line: 'still the bottleneck', subject_char_count: 20, body: '{{first_name}}\n\nEvery holiday you haven\'t taken got cancelled.\n\nDoug', word_count: 12 },
        { sequence_position: 2, subject_line: null, subject_char_count: 0, body: '{{first_name}}\n\nMost founders have tried the obvious fixes.\n\nDoug', word_count: 10 },
        { sequence_position: 3, subject_line: null, subject_char_count: 0, body: '{{first_name}}\n\nDiagnostic takes 3 weeks, £12k fixed.\n\nDoug', word_count: 9 },
        { sequence_position: 4, subject_line: 'last note', subject_char_count: 9, body: '{{first_name}}\n\nLast email. Fair enough if timing is wrong.\n\nDoug', word_count: 11 },
      ],
    },
    B: {
      emails: [
        { sequence_position: 1, subject_line: 'one question', subject_char_count: 12, body: '{{first_name}}\n\nStill the bottleneck?\n\nDoug', word_count: 6 },
        { sequence_position: 2, subject_line: null, subject_char_count: 0, body: '{{first_name}}\n\nThe fix isn\'t another hire.\n\nDoug', word_count: 7 },
        { sequence_position: 3, subject_line: null, subject_char_count: 0, body: '{{first_name}}\n\nThree weeks to find out.\n\nDoug', word_count: 6 },
        { sequence_position: 4, subject_line: 'last note', subject_char_count: 9, body: '{{first_name}}\n\nSay the word if timing shifts.\n\nDoug', word_count: 8 },
      ],
    },
  },
}

describe('Messaging — 1 payload field', () => {
  it('PASS: variants renders A/B tabs', () => {
    renderCard('messaging', MESSAGING_FIXTURE)
    expect(didCrash()).toBe(false)
    expect(screen.getByText('Variant A')).toBeInTheDocument()
    expect(screen.getByText('Variant B')).toBeInTheDocument()
  })

  it('PASS: active variant shows email 1 header', () => {
    renderCard('messaging', MESSAGING_FIXTURE)
    // All 4 emails render as headers; getAllByText confirms at least one "Email 1" is present
    const emailOnes = screen.getAllByText('Email 1')
    expect(emailOnes.length).toBeGreaterThanOrEqual(1)
  })
})

// ─── ICP (5 payload fields) ───────────────────────────────────────────────────
// Real schema: tier_1 (object), tier_2 (object), tier_3 (object), summary (string), jtbd_statement (string)
// Renderer built for: icp_summary (absent), positioning_note (absent), tiers[] (absent)
// Verdict: 2/5 PASS via renderUnknownFields (strings), 3/5 MISS (objects as JSON blob)

describe('ICP — 5 payload fields', () => {
  const ICP_FIXTURE = {
    summary: 'The ideal client is a founder-led UK service business doing £2m to £20m in revenue.',
    jtbd_statement: 'Get me out of the day-to-day so I can stop being the bottleneck.',
    tier_1: { label: 'Ideal Client', description: 'Founder-led UK service businesses.', disqualifiers: ['Revenue below £1.5m.'] },
    tier_2: { label: 'Good Client', description: 'Founder-led UK service businesses at £10m–£20m.' },
    tier_3: { label: 'Do Not Target', description: 'Businesses under £1.5m revenue.' },
  }

  it('PASS: summary (string) renders as readable text via renderUnknownFields', () => {
    renderCard('icp', ICP_FIXTURE)
    expect(didCrash()).toBe(false)
    expect(screen.getByText('The ideal client is a founder-led UK service business doing £2m to £20m in revenue.')).toBeInTheDocument()
  })

  it('PASS: jtbd_statement (string) renders as readable text via renderUnknownFields', () => {
    renderCard('icp', ICP_FIXTURE)
    expect(screen.getByText('Get me out of the day-to-day so I can stop being the bottleneck.')).toBeInTheDocument()
  })

  it('MISS: tier_1 — object serialised as JSON blob, "Ideal Client" label not readable', () => {
    renderCard('icp', ICP_FIXTURE)
    // The label text is buried inside a JSON string — not a distinct DOM text node
    expect(screen.queryByText('Ideal Client')).not.toBeInTheDocument()
  })

  it('MISS: tier_2 — object serialised as JSON blob, "Good Client" label not readable', () => {
    renderCard('icp', ICP_FIXTURE)
    expect(screen.queryByText('Good Client')).not.toBeInTheDocument()
  })

  it('MISS: tier_3 — object serialised as JSON blob, "Do Not Target" label not readable', () => {
    renderCard('icp', ICP_FIXTURE)
    expect(screen.queryByText('Do Not Target')).not.toBeInTheDocument()
  })
})

// ─── TOV (9 payload fields) ───────────────────────────────────────────────────
// Verdict: 3/9 PASS, 1/9 PARTIAL (before_after_examples: before+after show, context dropped),
//          2/9 CRASH (writing_rules, what_this_voice_never_does: object items as JSX children),
//          3/9 MISS (do_dont_list: object not array; vocabulary: wrong key names; sentence_mechanics: wrong key names)

// Safe base fixture — only fields confirmed not to crash
const TOV_SAFE_BASE = {
  voice_summary: 'Direct, understated, and blunt.',
  voice_style_note: 'Consistent with how you actually write. No contradiction to flag.',
  voice_characteristics: [
    { characteristic: 'Blunt diagnosis delivered early', description: 'The uncomfortable truth appears early.', evidence: '"On the first call I told him."' },
  ],
  vocabulary: { words_they_use: ['fair enough', 'say the word'], words_they_avoid: ['innovative', 'robust'], sentence_length: 'Short to medium.', structural_patterns: ['Opens with concrete observation.'] },
  do_dont_list: { do: ['Open with a specific observation.', 'Include at least one concrete number.'], dont: ['Never use exclamation marks.'] },
  sentence_mechanics: { fragment_usage: 'Fragments are present but infrequent.', opening_move_pattern: 'Messages open with reader\'s name.', punctuation_patterns: 'Hard full stops dominate.', dominant_sentence_length: 'Short to medium, 8 to 18 words.' },
  before_after_examples: [{ before: 'Hi Sarah, I hope you\'re well!', after: 'Sarah\n\nAt 30 staff most founders are still the bottleneck.', context: 'LinkedIn first message to a £5m firm.' }],
}

describe('TOV — 9 payload fields (testing non-crashing fields)', () => {
  it('PASS: voice_summary renders correctly', () => {
    renderCard('tov', TOV_SAFE_BASE)
    expect(didCrash()).toBe(false)
    expect(screen.getByText('Direct, understated, and blunt.')).toBeInTheDocument()
  })

  it('PASS: voice_style_note renders correctly', () => {
    renderCard('tov', TOV_SAFE_BASE)
    expect(screen.getByText('Consistent with how you actually write. No contradiction to flag.')).toBeInTheDocument()
  })

  it('PASS: voice_characteristics renders characteristic labels', () => {
    renderCard('tov', TOV_SAFE_BASE)
    expect(screen.getByText('Blunt diagnosis delivered early')).toBeInTheDocument()
  })

  it('MISS: do_dont_list — renderer expects DoDontItem[] (array of {do,dont} objects), actual is {do:string[],dont:string[]}', () => {
    renderCard('tov', TOV_SAFE_BASE)
    // The "Do / Don't" section header should appear if rendering correctly
    expect(screen.queryByText("Do / Don't")).not.toBeInTheDocument()
  })

  it('MISS: vocabulary — renderer looks for .preferred/.avoid, actual has .words_they_use/.words_they_avoid', () => {
    renderCard('tov', TOV_SAFE_BASE)
    // "fair enough" should appear as a Preferred chip if rendering correctly
    expect(screen.queryByText('fair enough')).not.toBeInTheDocument()
  })

  it('PARTIAL: before_after_examples — before+after text renders, context field dropped (renderer looks for .note, actual has .context)', () => {
    renderCard('tov', TOV_SAFE_BASE)
    expect(screen.getByText(/"Hi Sarah, I hope you're well!/)).toBeInTheDocument()
    expect(screen.getByText(/"Sarah/)).toBeInTheDocument()
    expect(screen.queryByText('LinkedIn first message to a £5m firm.')).not.toBeInTheDocument()
  })

  it('MISS: sentence_mechanics — renderer looks for {avg_sentence_length,punctuation_rules,paragraph_length}, actual has {fragment_usage,opening_move_pattern,punctuation_patterns,dominant_sentence_length}', () => {
    renderCard('tov', TOV_SAFE_BASE)
    expect(screen.queryByText('Fragments are present but infrequent.')).not.toBeInTheDocument()
  })
})

describe('TOV — crashing fields', () => {
  it('CRASH: writing_rules — renderer maps array items as strings and renders {rule} directly, actual items are {rule,why,example_correct,example_violation} objects', () => {
    const fixture = {
      voice_summary: 'test',
      writing_rules: [{ rule: 'Never open with I or We', why: 'Sounds like agencies.', example_correct: 'Most firms have the same bottleneck.', example_violation: 'I wanted to reach out.' }],
    }
    renderCard('tov', fixture)
    expect(didCrash()).toBe(true)
  })

  it('CRASH: what_this_voice_never_does — renderer maps array items as strings and renders {item} directly, actual items are {rule,evidence} objects', () => {
    const fixture = {
      voice_summary: 'test',
      what_this_voice_never_does: [{ rule: 'Never uses exclamation marks', evidence: 'Zero exclamation marks appear.' }],
    }
    renderCard('tov', fixture)
    expect(didCrash()).toBe(true)
  })
})

// ─── Positioning (9 payload fields) ──────────────────────────────────────────
// Real schema: moore_positioning (object), market_category (object), unique_attributes (object[]),
//              competitive_landscape (object), best_fit_characteristics (object), key_messages (object),
//              value_themes (object[]), competitive_alternatives (object[]) ✓, positioning_summary (string) ✓
// Verdict: 2/9 PASS, 1/9 PARTIAL (value_themes: theme.theme shows, for_whom/outcome_statement dropped),
//          4/9 CRASH (moore_positioning, market_category, unique_attributes, competitive_landscape rendered as strings),
//          2/9 MISS (key_messages: object not array; best_fit_characteristics: object not array)

// Safe base with only confirmed non-crashing fields
const POSITIONING_SAFE_BASE = {
  positioning_summary: 'PartScale is a fractional COO practice for founder-led UK service businesses.',
  competitive_alternatives: [
    { name: 'Keep running it themselves', limitation: 'The founder is the structural problem.', buyer_reasoning: 'The founder has survived this long on personal competence.' },
  ],
  key_messages: { discovery_frame: 'The problem is rarely the team.', cold_outreach_hook: 'Still the one answering every question?', objection_response: 'We do not send you a report and leave.' },
  best_fit_characteristics: { amplifiers: ['A key person has recently quit.'], must_haves: ['Founder-led UK B2B service business.'], disqualifiers: ['Revenue below £1.5m.'] },
  value_themes: [{ theme: 'The business runs without the founder in the room', for_whom: 'Tier 1 founders.', outcome_statement: 'The leadership team runs the cadence independently.' }],
}

describe('Positioning — 9 payload fields (non-crashing fields)', () => {
  it('PASS: positioning_summary renders correctly', () => {
    renderCard('positioning', POSITIONING_SAFE_BASE)
    expect(didCrash()).toBe(false)
    expect(screen.getByText('PartScale is a fractional COO practice for founder-led UK service businesses.')).toBeInTheDocument()
  })

  it('PASS: competitive_alternatives renders name and limitation', () => {
    renderCard('positioning', POSITIONING_SAFE_BASE)
    expect(screen.getByText('Keep running it themselves')).toBeInTheDocument()
    expect(screen.getByText('The founder is the structural problem.')).toBeInTheDocument()
  })

  it('MISS: key_messages — renderer expects KeyMessage[] array, actual is {discovery_frame,cold_outreach_hook,objection_response} object', () => {
    renderCard('positioning', POSITIONING_SAFE_BASE)
    expect(screen.queryByText('Still the one answering every question?')).not.toBeInTheDocument()
  })

  it('MISS: best_fit_characteristics — renderer expects string[], actual is {amplifiers[],must_haves[],disqualifiers[]} object', () => {
    renderCard('positioning', POSITIONING_SAFE_BASE)
    expect(screen.queryByText('A key person has recently quit.')).not.toBeInTheDocument()
  })

  it('PARTIAL: value_themes — theme.theme renders, for_whom/outcome_statement dropped (renderer looks for .proof_points which is absent)', () => {
    renderCard('positioning', POSITIONING_SAFE_BASE)
    expect(screen.getByText('The business runs without the founder in the room')).toBeInTheDocument()
    expect(screen.queryByText('The leadership team runs the cadence independently.')).not.toBeInTheDocument()
  })
})

describe('Positioning — crashing fields', () => {
  it('CRASH: moore_positioning — renderer renders {doc.moore_positioning} expecting string, actual is {full_positioning_statement,...} object', () => {
    const fixture = {
      positioning_summary: 'test',
      moore_positioning: { full_positioning_statement: 'For founders...', compressed_positioning_statement: 'Short version.' },
    }
    renderCard('positioning', fixture)
    expect(didCrash()).toBe(true)
  })

  it('CRASH: market_category — renderer renders {doc.market_category} expecting string, actual is {chosen_category,why_this_frame,...} object', () => {
    const fixture = {
      positioning_summary: 'test',
      market_category: { chosen_category: 'Embedded fractional COO', why_this_frame: 'This frame does three things.' },
    }
    renderCard('positioning', fixture)
    expect(didCrash()).toBe(true)
  })

  it('CRASH: unique_attributes — renderer maps items as strings with {attr}, actual items are {what_it_is,client_outcome,why_competitors_cannot_claim_it} objects', () => {
    const fixture = {
      positioning_summary: 'test',
      unique_attributes: [{ what_it_is: 'The team embeds 1-2 days per week.', client_outcome: 'Founder stops being pulled in.', why_competitors_cannot_claim_it: 'Others deliver via reports.' }],
    }
    renderCard('positioning', fixture)
    expect(didCrash()).toBe(true)
  })

  it('CRASH: competitive_landscape — renderer renders {doc.competitive_landscape} expecting string, actual is {white_space,direct_competitors[],dominant_narrative} object', () => {
    const fixture = {
      positioning_summary: 'test',
      competitive_landscape: { white_space: 'Territory no competitor claims.', direct_competitors: ['Other fractional COOs.'], dominant_narrative: 'Everyone says "we\'ll help you scale".' },
    }
    renderCard('positioning', fixture)
    expect(didCrash()).toBe(true)
  })
})

// ─── Amendment 7: renderUnknownFields surfaces unknown keys ───────────────────

describe('renderUnknownFields — amendment 7 fallback', () => {
  it('surfaces a fake string field injected into a positioning payload', () => {
    const payload = {
      ...POSITIONING_SAFE_BASE,
      _fake_field_xyz: 'sentinel-value-abc',
    }
    renderCard('positioning', payload)
    expect(didCrash()).toBe(false)
    expect(screen.getByText('sentinel-value-abc')).toBeInTheDocument()
  })

  it('renders the fake key label with underscores replaced by spaces', () => {
    const payload = {
      ...POSITIONING_SAFE_BASE,
      _fake_field_xyz: 'sentinel-value-abc',
    }
    renderCard('positioning', payload)
    expect(screen.getByText('fake field xyz')).toBeInTheDocument()
  })
})
