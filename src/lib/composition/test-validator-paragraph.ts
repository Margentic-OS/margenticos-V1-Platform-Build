// Synthetic test for the paragraph independence check in validateEmails().
// Verifies positive cases flag and negative cases pass before running on real data.
// Run with: npx tsx --env-file=.env.local src/lib/composition/test-validator-paragraph.ts
// Delete after test passes.

import { validateEmails, type EmailRecord } from '@/agents/messaging-generation-agent'

const SENDER = 'Doug'

// Minimal valid 4-email sequence — only email 1 body varies between test cases.
// Emails 2–4 are fixed clean templates that pass all other validator checks.
function makeSequence(email1Body: string): EmailRecord[] {
  return [
    {
      sequence_position: 1,
      subject_line: 'test subject line here',
      subject_char_count: 22,
      body: email1Body,
      word_count: 55,
    },
    {
      sequence_position: 2,
      subject_line: null,
      subject_char_count: 0,
      body: `{{first_name}}\n\nMost consultants at your stage describe the same thing: the months are either great or thin with nothing in between.\n\nThe outbound answer is not new to them. It just never compounds because delivery fills the week first.\n\nDoes that sound like where you are?\n\n${SENDER}`,
      word_count: 52,
    },
    {
      sequence_position: 3,
      subject_line: null,
      subject_char_count: 0,
      body: `{{first_name}}\n\nThe part most people miss: the bottleneck is not outreach volume.\n\nOutreach stops exactly when pipeline gets tight, which is when it matters most.\n\nWorth a quick call?\n\n${SENDER}`,
      word_count: 38,
    },
    {
      sequence_position: 4,
      subject_line: 'last note',
      subject_char_count: 9,
      body: `{{first_name}}\n\nLast one from me on this. If timing is off or it is not relevant, no issue.\n\nHappy to talk if priorities shift.\n\n${SENDER}`,
      word_count: 35,
    },
  ]
}

// ─── Positive cases — validator SHOULD flag ───────────────────────────────────

const positives: Array<{ label: string; body: string }> = [
  {
    label: 'P1: paragraph 2 opens with "That\'s what consistent pipeline looks like..."',
    body: `{{first_name}}\n\nQualified calls landing in your diary every week without writing a single email.\n\nThat's what consistent pipeline looks like for a B2B consultant with a proven offer.\n\nIs that where you are trying to get?\n\n${SENDER}`,
  },
  {
    label: 'P2: paragraph 2 opens with "That\'s the exact cycle most founders..."',
    body: `{{first_name}}\n\nMost founders describe the same feast-and-famine rhythm when I ask them about pipeline.\n\nThat's the exact cycle most founders I talk to are sick of.\n\nIs that where you are right now?\n\n${SENDER}`,
  },
  {
    label: 'P3: paragraph 2 opens with "The reason is most consultants miss..."',
    body: `{{first_name}}\n\nOutbound works differently for consultants than most people expect.\n\nThe reason is most consultants miss the timing window entirely.\n\nWorth a quick call?\n\n${SENDER}`,
  },
]

// ─── Negative cases — validator should NOT flag from paragraph independence ──

const negatives: Array<{ label: string; body: string }> = [
  {
    label: 'N1: paragraph 2 opens cleanly ("Most consultants who solve this...")',
    body: `{{first_name}}\n\nFeast-and-famine is the normal for most founder-led firms at your stage.\n\nMost consultants who solve this end up with a predictable pipeline inside 90 days.\n\nIs that a problem you are actively working on?\n\n${SENDER}`,
  },
  {
    label: 'N2: paragraph 2 opens cleanly ("Referrals carry the load...")',
    body: `{{first_name}}\n\nThe pattern is consistent across the consultants I talk to at your stage.\n\nReferrals carry the load until one goes quiet, and then there is nothing underneath.\n\nIs that where you are?\n\n${SENDER}`,
  },
  {
    label: 'N3: paragraph 1 (opener, exempt) starts with "That\'s what..." — must NOT flag',
    body: `{{first_name}}\n\nThat's what pipeline predictability looks like when the engine is actually running.\n\nMost B2B consultants at your stage do not have that yet.\n\nIs that a gap you are working on?\n\n${SENDER}`,
  },
  {
    label: 'N4: "the reason is" appears mid-paragraph, not at paragraph start — must NOT flag',
    body: `{{first_name}}\n\nOutbound gets ignored because most founders are too busy delivering.\n\nThe issue here is timing — the reason is outbound stops exactly when pipeline gets tight.\n\nWorth exploring?\n\n${SENDER}`,
  },
]

// ─── Runner ───────────────────────────────────────────────────────────────────

function paragraphViolations(violations: ReturnType<typeof validateEmails>) {
  return violations.filter(v => v.issue.includes('paragraph') && v.issue.includes('opens with'))
}

let passed = 0
let failed = 0

console.log('\n=== POSITIVE CASES (validator should flag) ===\n')
for (const { label, body } of positives) {
  const violations = validateEmails(makeSequence(body), SENDER)
  const paraViolations = paragraphViolations(violations)
  if (paraViolations.length > 0) {
    console.log(`  PASS  ${label}`)
    console.log(`        → flagged: ${paraViolations[0].issue}\n`)
    passed++
  } else {
    console.log(`  FAIL  ${label}`)
    console.log(`        → no paragraph independence violation raised\n`)
    failed++
  }
}

console.log('\n=== NEGATIVE CASES (validator should NOT flag paragraph independence) ===\n')
for (const { label, body } of negatives) {
  const violations = validateEmails(makeSequence(body), SENDER)
  const paraViolations = paragraphViolations(violations)
  if (paraViolations.length === 0) {
    console.log(`  PASS  ${label}\n`)
    passed++
  } else {
    console.log(`  FAIL  ${label}`)
    console.log(`        → unexpected violation: ${paraViolations[0].issue}\n`)
    failed++
  }
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`)
if (failed > 0) process.exit(1)
