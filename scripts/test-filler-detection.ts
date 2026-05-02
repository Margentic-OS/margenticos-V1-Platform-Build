// Filler-detection test printer — no test runner configured (see pre-build check notes).
// Covers all 5 skip rules plus the pass-through case.
// Run with: npm run test-filler-detection
//
// This is NOT a pass/fail CI suite. It prints results to console for human review.
// A line labelled FAIL indicates the gate behaved differently from expected.

import { shouldSkipExtraction } from '../src/lib/faq/filler-detection'

// ─── Test state ───────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  const marker = ok ? '  PASS' : '  FAIL'
  if (ok) passed++
  else failed++

  console.log(`${marker}  ${label}`)
  if (!ok) {
    console.log(`         expected: ${JSON.stringify(expected)}`)
    console.log(`         actual:   ${JSON.stringify(actual)}`)
  }
}

// ─── Test cases ───────────────────────────────────────────────────────────────

console.log('\nFiller Detection Test Harness')
console.log('='.repeat(60))

// ── Rule 1: word count < 20 ────────────────────────────────────────────────

console.log('\n[Rule 1] Word count < 20')

const shortAnswer = 'Our onboarding takes about two to three weeks in total.'
check(
  'Short answer (9 words) → skip, reason contains answer_too_short',
  shouldSkipExtraction({ prospectQuestion: 'how long?', operatorAnswer: shortAnswer, aiDraftBody: 'different text entirely' }),
  { skip: true, reason: 'answer_too_short_9_words' },
)

const borderlineAnswer = 'Our onboarding process typically runs two to three weeks from contract signing to first emails going out in Instantly.'
// 19 words — should still skip
const borderlineWords = borderlineAnswer.split(/\s+/).filter(Boolean).length
check(
  `Borderline answer (${borderlineWords} words — below 20) → skip`,
  shouldSkipExtraction({ prospectQuestion: 'how long?', operatorAnswer: borderlineAnswer, aiDraftBody: 'something completely different here and now' }).skip,
  true,
)

// ── Rule 2: filler prefix ─────────────────────────────────────────────────

console.log('\n[Rule 2] Filler prefix in first 40 chars')

check(
  '"Let me come back" prefix → skip',
  shouldSkipExtraction({
    prospectQuestion: 'how does pricing work?',
    operatorAnswer: 'Let me come back to you on Monday with the exact figures. We have a few tiers that depend on your outreach volume and campaign complexity.',
    aiDraftBody: 'totally unrelated content about something else here',
  }),
  { skip: true, reason: 'filler_prefix_detected_let_me_come_back' },
)

check(
  '"Got it" prefix → skip',
  shouldSkipExtraction({
    prospectQuestion: 'when do we start?',
    operatorAnswer: "Got it, thanks. We'll connect again soon and I'll explain everything then.",
    aiDraftBody: 'something else here that is very different from the above',
  }),
  { skip: true, reason: 'filler_prefix_detected_got_it' },
)

check(
  '"Good question" prefix → skip',
  shouldSkipExtraction({
    prospectQuestion: 'what makes you different?',
    operatorAnswer: "Good question — that's exactly what I want to walk you through. Our approach is built specifically for consulting firms who need qualified meetings without doing the outreach themselves.",
    aiDraftBody: 'some completely different text that does not match at all',
  }),
  { skip: true, reason: 'filler_prefix_detected_good_question' },
)

// ── Rule 3: question-dominated ────────────────────────────────────────────

console.log('\n[Rule 3] Question-dominated answer')

check(
  'More question marks than full stops → skip',
  shouldSkipExtraction({
    prospectQuestion: 'do you work with SaaS companies?',
    operatorAnswer: 'That depends on your situation. What industry are you in? What is your average deal size? How many leads are you currently working with? Do you have an outbound motion already?',
    aiDraftBody: 'something completely different and not matching at all in any way',
  }),
  { skip: true, reason: 'operator_asked_clarifying_questions_not_answer' },
)

// ── Rule 4: Booking-link-only ─────────────────────────────────────────────

console.log('\n[Rule 4] Booking-link-only response')

check(
  'Booking placeholder with minimal context → skip',
  shouldSkipExtraction({
    prospectQuestion: 'can we jump on a call?',
    operatorAnswer: 'Happy to walk you through it. {calendly_link}',
    aiDraftBody: 'a very different draft body with lots of different words not matching the above',
  }),
  { skip: true, reason: 'booking_link_only_minimal_context' },
)

check(
  'Calendly link with substantive context (30+ stripped words) → no skip on rule 4',
  // NOTE: This may still skip on Rule 1 (word count) — we check the skip reason
  shouldSkipExtraction({
    prospectQuestion: 'can we jump on a call?',
    operatorAnswer: 'Absolutely, a call would be the best way to cover this. I want to walk you through exactly how the onboarding process works, show you the dashboard, and explain the qualification criteria we use to source your prospects. Book a slot here: {calendly_link}',
    aiDraftBody: 'a very different draft body with lots of words not matching the above text at all in any way shape or form whatsoever',
  }).reason,
  // If any skip fires, it should NOT be 'calendly_only_minimal_context'
  undefined,  // pass-through: no rule fires for a substantive answer
)

// ── Rule 5: unedited AI draft ─────────────────────────────────────────────

console.log('\n[Rule 5] Operator did not edit AI draft')

const sharedText = `
  Thanks for asking about our onboarding timeline. We typically run a two to three week
  setup process that covers your ICP document, messaging strategy, prospect sourcing,
  and campaign configuration. You review and approve everything before we send a single
  email. Once the first batch is live, qualified meetings start appearing in your calendar.
`.trim()

check(
  'Identical operator answer and AI draft → skip',
  shouldSkipExtraction({
    prospectQuestion: 'how does onboarding work?',
    operatorAnswer: sharedText,
    aiDraftBody: sharedText,
  }),
  { skip: true, reason: 'operator_did_not_edit_ai_draft' },
)

check(
  'Slightly modified draft (>5% change) → no skip on rule 5',
  shouldSkipExtraction({
    prospectQuestion: 'how does onboarding work?',
    operatorAnswer: `
      Thanks for your question about our onboarding process. We run a structured two to three
      week setup: ICP document, messaging strategy, prospect sourcing, campaign configuration.
      You approve everything before the first email goes out. After that, qualified meetings
      land in your calendar automatically.
    `.trim(),
    aiDraftBody: sharedText,
  }).reason,
  undefined,
)

// ── Pass-through: all rules pass ──────────────────────────────────────────

console.log('\n[Pass-through] Substantive clean answer')

check(
  'Substantive answer — no rules fire → skip: false',
  shouldSkipExtraction({
    prospectQuestion: 'what does the onboarding process look like?',
    operatorAnswer: `
      Our onboarding runs two to three weeks from contract signing. Week one covers your ICP
      document and messaging strategy — you review and approve both before we move to sourcing.
      Week two is prospect sourcing and campaign setup in Instantly. Week three is a final review
      of the first email batch before anything goes out. After that, meetings start arriving in
      your calendar and we handle everything from there.
    `.trim(),
    aiDraftBody: `
      Happy to walk you through it. The process typically starts with an ICP workshop followed
      by copywriting. We then source prospects and set up the campaigns. Expect your first
      meetings within 4-6 weeks of contract signing.
    `.trim(),
  }),
  { skip: false },
)

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60))
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('Review FAIL lines above.')
  process.exit(1)
} else {
  console.log('All checks passed.')
}
