// @vitest-environment jsdom
//
// NO EM/EN DASHES IN STRATEGY DOCUMENT CHROME.
//
// "Chrome" means the component's own hardcoded text: section headings, labels,
// separators, empty states. Not the document content, which is generated per
// client and policed by the messaging agent's validators.
//
// ── WHY THIS FILE LOOKS THE WAY IT DOES ──────────────────────────────────────
//
// The version this replaces declared the labels as a local array INSIDE the test
// and asserted the array contained no dashes. It never imported a component. It
// could not fail: the strings it checked were the strings it had just written.
// MessagingDocumentView has carried two rendered em dashes the whole time and
// this file stayed green through all of them. Found by the 2026-09-04 test audit.
//
// The fixtures below are deliberately DASH-FREE, so every dash the scan reports
// came from the component's own markup rather than from the content we passed in.

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { PositioningDocumentView } from '../PositioningDocumentView'
import { MessagingDocumentView } from '../MessagingDocumentView'

const EM_DASH = '—'
const EN_DASH = '–'
const DOUBLE_HYPHEN = '--'

const hasDash = (s: string) =>
  s.includes(EM_DASH) || s.includes(EN_DASH) || s.includes(DOUBLE_HYPHEN)

/**
 * The DISTINCT rendered strings that carry a dash.
 *
 * Distinct, not total: one chrome string reached through four disclosures is one
 * defect, not four, and counting instances would make the baseline move whenever
 * a fixture gained an email. Text nodes rather than concatenated textContent for
 * the same reason.
 */
function dashStrings(root: HTMLElement): string[] {
  const found = new Set<string>()
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (text && hasDash(text)) found.add(text)
  }
  return [...found].sort()
}

/**
 * Render, then reveal everything reachable: expand every collapsed section and
 * visit every variant tab, accumulating the text at each step. A dash hiding
 * behind a closed disclosure is still shipped chrome.
 */
function renderedChrome(ui: React.ReactElement): { dashes: string[]; chars: number } {
  const { container } = render(ui)
  const dashes = new Set<string>()
  let chars = 0

  const sweep = () => {
    container.querySelectorAll('button[aria-expanded="false"]').forEach(b => fireEvent.click(b))
    dashStrings(container).forEach(d => dashes.add(d))
    chars = Math.max(chars, (container.textContent ?? '').length)
  }

  sweep()
  const tabs = Array.from(container.querySelectorAll('button')).filter(b =>
    /^[A-D] /.test(b.textContent ?? ''),
  )
  for (const tab of tabs) {
    fireEvent.click(tab)
    sweep()
  }
  return { dashes: [...dashes].sort(), chars }
}

// ─── Dash-free fixtures ──────────────────────────────────────────────────────

const positioningContent = {
  positioning_summary: 'We help founder led firms build predictable pipeline.',
  moore_positioning: {
    compressed_positioning_statement: 'For firms that need pipeline.',
    full_positioning_statement: 'For firms that need pipeline, we run outbound end to end.',
  },
  unique_attributes: [
    { what_it_is: 'Operator run', why_competitors_cannot_claim_it: 'They sell software.', client_outcome: 'Nothing to learn.' },
  ],
  market_category: { chosen_category: 'Pipeline generation', why_this_frame: 'It is how buyers describe the gap.' },
  key_messages: { discovery_frame: 'Where does pipeline come from today?', cold_outreach_hook: 'A pattern worth naming.', objection_response: 'We can start small.' },
  value_themes: [{ theme: 'Predictability', for_whom: 'Founders', outcome_statement: 'Calls arrive weekly.' }],
  competitive_alternatives: [{ name: 'Hiring an SDR', buyer_reasoning: 'It feels safer.', limitation: 'Ramp takes months.' }],
  white_space: 'Nobody runs it for them.',
}

const email = (position: number, subject: string | null) => ({
  sequence_position: position,
  subject_line: subject,
  subject_char_count: subject ? subject.length : 0,
  body: `Body for email ${position}.`,
  word_count: 5,
})

const messagingContent = {
  variants: {
    A: { emails: [email(1, 'A quick question'), email(2, null), email(3, null), email(4, null)] },
    B: { emails: [email(1, 'One thought'), email(2, null), email(3, null), email(4, null)] },
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// Measured 2026-09-04 against the components as they stand.
//
//   MessagingDocumentView, 3 distinct dash-bearing strings from 2 source lines:
//     MessagingDocumentView.tsx:123  "No separate subject — threads under Email 1"
//     MessagingDocumentView.tsx:315  "{key} — {VARIANT_LABELS[key]}", once per
//                                    variant, so the A and B tabs are 2 strings.
//
//   PositioningDocumentView, 0. Its six em dashes are all in comments.
//
// FIXING THE DASHES IS NOT THIS FILE'S JOB and is tracked separately. This file
// only has to stop lying about them.
// ═══════════════════════════════════════════════════════════════════════════
const BASELINE = {
  PositioningDocumentView: 0,
  MessagingDocumentView: 3,
}

const VIEWS: Array<[keyof typeof BASELINE, () => React.ReactElement]> = [
  ['PositioningDocumentView', () => <PositioningDocumentView content={positioningContent as never} plainText={null} />],
  ['MessagingDocumentView', () => <MessagingDocumentView content={messagingContent as never} />],
]

describe('strategy document chrome carries no em or en dashes', () => {
  afterEach(() => cleanup())

  // ═════════════════════════════════════════════════════════════════════════
  // EXPECTED TO FAIL. This is the goal state, and it is red on purpose.
  //
  // WHAT UNBLOCKS IT: removing the two em dashes listed above from
  // MessagingDocumentView. When the last one goes, THIS TEST STARTS FAILING BY
  // PASSING (vitest treats a passing it.fails as a failure) and that is the
  // signal to delete the `.fails` and the baseline, leaving a plain zero.
  //
  // IT IS NOT THE PROTECTION. The ratchet below it is.
  // ═════════════════════════════════════════════════════════════════════════
  it.fails('GOAL: zero dashes in the rendered chrome of every strategy view', () => {
    const all = VIEWS.flatMap(([name, ui]) =>
      renderedChrome(ui()).dashes.map(h => `${name}: "${h}"`),
    )
    expect(all, `${all.length} dashes in rendered chrome:\n${all.join('\n')}`).toEqual([])
  })

  // THE ONE THAT ACTUALLY PROTECTS, and it is green today. A dash added to any
  // of these components tomorrow fails this the same day.
  it.each(VIEWS)('%s renders no more dashes than the count measured on 2026-09-04', (name, ui) => {
    const hits = renderedChrome(ui()).dashes
    expect(
      hits.length,
      `${name}: ${hits.length} dashes, baseline ${BASELINE[name]}. Baselines may only go down.\n${hits.join('\n')}`,
    ).toBeLessThanOrEqual(BASELINE[name])
  })

  // Guards the guard: the fixtures must stay dash-free, or the scan above starts
  // reporting our own test data as if it were component chrome.
  it('the fixtures introduce no dashes of their own', () => {
    const fixtureText = JSON.stringify(positioningContent) + JSON.stringify(messagingContent)
    expect(hasDash(fixtureText)).toBe(false)
  })

  // Guards the guard, the other way: proves the scan reaches real rendered text
  // rather than silently seeing an empty string, which is how the version this
  // replaced managed to pass.
  it('the scan reads real rendered output from each view', () => {
    for (const [name, ui] of VIEWS) {
      expect(renderedChrome(ui()).chars, `${name} rendered nothing`).toBeGreaterThan(100)
    }
  })
})
