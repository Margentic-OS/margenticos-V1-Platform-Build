// @vitest-environment jsdom
//
// NO EM/EN DASHES IN THE INTAKE FORM THE CLIENT ACTUALLY SEES.
//
// This is the first thing a new client reads, and CLAUDE.md's rule about dashes
// exists because our ICP is founders who have been burned by AI email. A dash in
// a question label is the worst place for one.
//
// ── WHY THIS FILE LOOKS THE WAY IT DOES ──────────────────────────────────────
//
// The version this replaces pasted the question labels into a local array and
// asserted that array held no dashes, under the comment "These are the hardcoded
// labels from the form". It never imported IntakeForm. The strings it checked
// were the strings it had just written, so it could not fail, and it did not:
// two live question labels in questions.ts have carried em dashes throughout.
// Found by the 2026-09-04 test audit.
//
// It renders the real component now. Every section is present in the DOM at once
// (IntakeForm.tsx:262 renders all five and hides the inactive ones with a class),
// so one render reaches every label without clicking through.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import IntakeForm from '../IntakeForm'
import { ALL_QUESTIONS } from '@/lib/intake/questions'

// The save path is a server action. Nothing here exercises it; it is mocked so
// the component can mount.
vi.mock('@/app/intake/actions', () => ({
  saveIntakeResponse: vi.fn(async () => ({ success: true })),
}))

const EM_DASH = '—'
const EN_DASH = '–'
const DOUBLE_HYPHEN = '--'
const hasDash = (s: string) =>
  s.includes(EM_DASH) || s.includes(EN_DASH) || s.includes(DOUBLE_HYPHEN)

/** Distinct rendered strings carrying a dash. Distinct, so one string shown in
 *  several places is one defect rather than several. */
function renderedDashStrings(): { all: string[]; chars: number } {
  const { container } = render(<IntakeForm initialValues={{}} initialFiles={[]} />)
  const found = new Set<string>()
  const walker = container.ownerDocument.createTreeWalker(container, 4 /* SHOW_TEXT */)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (text && hasDash(text)) found.add(text)
  }
  return { all: [...found].sort(), chars: (container.textContent ?? '').length }
}

/** A rendered string counts as a question label if a real question uses it. */
const isQuestionLabel = (text: string) =>
  ALL_QUESTIONS.some(q => {
    const label = (q.label ?? '').replace(/\s+/g, ' ').trim()
    return label.length > 0 && (label === text || text.includes(label))
  })

// ═══════════════════════════════════════════════════════════════════════════
// Measured 2026-09-04 against the form as it stands. Five dash-bearing strings
// reach the client:
//
//   QUESTION LABELS (2), both in src/lib/intake/questions.ts:
//     :132  "...Start from the beginning — how did they first become aware..."
//     :176  "...Deliverables, outputs, access — what exists at the end..."
//
//   HELPER AND PROMPT TEXT (3):
//     IntakeForm.tsx:222        "...rather than type them — people say 3x more"
//     IntakeForm.tsx:296        "Speak this one if you can — it'll take 60 seconds"
//     FileUploadSection.tsx:201 "...emails, case studies — anything showing your voice"
//
// The remaining em dashes in these files are either in code comments or, like
// IntakeForm.tsx:361, behind a condition this render does not meet. Both are
// therefore out of scope for a test that asserts on what is actually rendered:
// :361 needs a short answer already typed, and this form starts empty.
//
// FIXING THE DASHES IS NOT THIS FILE'S JOB and is tracked separately. This file
// only has to stop lying about them.
// ═══════════════════════════════════════════════════════════════════════════
const BASELINE_QUESTION_LABELS = 2
const BASELINE_OTHER = 3

describe('intake form copy carries no em or en dashes', () => {
  afterEach(() => cleanup())

  // ═════════════════════════════════════════════════════════════════════════
  // EXPECTED TO FAIL. This is the goal state, and it is red on purpose.
  //
  // WHAT UNBLOCKS IT: removing the five dashes listed above. When the last one
  // goes, THIS TEST STARTS FAILING BY PASSING (vitest treats a passing it.fails
  // as a failure) and that is the signal to delete the `.fails` and the two
  // baselines, leaving a plain zero.
  //
  // IT IS NOT THE PROTECTION. The two ratchets below it are.
  // ═════════════════════════════════════════════════════════════════════════
  it.fails('GOAL: zero dashes anywhere the client can read them', () => {
    const { all } = renderedDashStrings()
    expect(all, `${all.length} dash-bearing strings rendered:\n${all.join('\n')}`).toEqual([])
  })

  // THE ONES THAT ACTUALLY PROTECT, and both are green today. Split apart because
  // a dash in a question label is a worse defect than one in helper text, and a
  // combined count would let a new label dash hide behind a removed helper dash.
  it('no more dash-bearing QUESTION LABELS than measured on 2026-09-04', () => {
    const hits = renderedDashStrings().all.filter(isQuestionLabel)
    expect(
      hits.length,
      `${hits.length} question labels with dashes, baseline ${BASELINE_QUESTION_LABELS}. ` +
        `Baselines may only go down.\n${hits.join('\n')}`,
    ).toBeLessThanOrEqual(BASELINE_QUESTION_LABELS)
  })

  it('no more dash-bearing helper or prompt strings than measured on 2026-09-04', () => {
    const hits = renderedDashStrings().all.filter(t => !isQuestionLabel(t))
    expect(
      hits.length,
      `${hits.length} non-label strings with dashes, baseline ${BASELINE_OTHER}. ` +
        `Baselines may only go down.\n${hits.join('\n')}`,
    ).toBeLessThanOrEqual(BASELINE_OTHER)
  })

  // Guards the guard: proves the scan reads a real, fully rendered form rather
  // than an empty container, which is how the version this replaced passed.
  it('renders the whole form, every section, not an empty shell', () => {
    const { chars } = renderedDashStrings()
    expect(chars).toBeGreaterThan(2000)
  })

  it('every critical question label is actually present in the rendered DOM', () => {
    const { container } = render(<IntakeForm initialValues={{}} initialFiles={[]} />)
    const text = (container.textContent ?? '').replace(/\s+/g, ' ')
    const critical = ALL_QUESTIONS.filter(q => q.isCritical)
    expect(critical.length).toBeGreaterThan(10)
    const missing = critical
      .map(q => (q.label ?? '').replace(/\s+/g, ' ').trim())
      .filter(label => label.length > 0 && !text.includes(label))
    expect(missing, `labels not rendered:\n${missing.join('\n')}`).toEqual([])
  })
})
