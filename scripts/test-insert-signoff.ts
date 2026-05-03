/**
 * Unit tests for insertSignoff.
 * Run: npx tsx scripts/test-insert-signoff.ts
 */

import { insertSignoff } from '../src/lib/reply-handling/insert-signoff'

let passed = 0
let failed = 0

function expect(description: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected
  if (ok) {
    console.log(`  ✓  ${description}`)
    passed++
  } else {
    console.error(`  ✗  ${description}`)
    console.error(`       expected: ${JSON.stringify(expected)}`)
    console.error(`       actual:   ${JSON.stringify(actual)}`)
    failed++
  }
}

function expectThrows(description: string, fn: () => unknown): void {
  try {
    fn()
    console.error(`  ✗  ${description} — expected throw but did not throw`)
    failed++
  } catch {
    console.log(`  ✓  ${description}`)
    passed++
  }
}

console.log('\ninsert-signoff tests\n')

// ── Body without sign-off → appended correctly ──────────────────────────────
{
  const result = insertSignoff('Hi there,\n\nThanks for reaching out.', 'Doug')
  expect('body without sign-off → sign-off appended', result, 'Hi there,\n\nThanks for reaching out.\n\nDoug')
}

// ── Body with "Cheers, Jane" → no double-append ─────────────────────────────
{
  const result = insertSignoff('Thanks for your message.\n\nCheers,\nJane', 'Jane')
  expect('body with "Cheers," → no append', result, 'Thanks for your message.\n\nCheers,\nJane')
}

// ── Body with "Best, Doug" → no double-append ───────────────────────────────
{
  const result = insertSignoff('Sounds good.\n\nBest,\nDoug', 'Doug')
  expect('body with "Best," → no append', result, 'Sounds good.\n\nBest,\nDoug')
}

// ── Body with "Thanks," → no double-append ──────────────────────────────────
{
  const result = insertSignoff('Let me know if that works.\n\nThanks,\nSarah', 'Sarah')
  expect('body with "Thanks," → no append', result, 'Let me know if that works.\n\nThanks,\nSarah')
}

// ── Body with "Regards," → no double-append ─────────────────────────────────
{
  const result = insertSignoff('Please find details below.\n\nRegards,\nAlex', 'Alex')
  expect('body with "Regards," → no append', result, 'Please find details below.\n\nRegards,\nAlex')
}

// ── Body with "Kind regards," → no double-append ────────────────────────────
{
  const result = insertSignoff('Happy to help.\n\nKind regards,\nMike', 'Mike')
  expect('body with "Kind regards," → no append', result, 'Happy to help.\n\nKind regards,\nMike')
}

// ── Body with "All the best," → no double-append ────────────────────────────
{
  const result = insertSignoff('See you then.\n\nAll the best,\nLucy', 'Lucy')
  expect('body with "All the best," → no append', result, 'See you then.\n\nAll the best,\nLucy')
}

// ── Body ending with founder first name alone on last line → no append ───────
{
  const result = insertSignoff('Great, talk soon.\n\nDoug', 'Doug')
  expect('body ending with first name alone → no append', result, 'Great, talk soon.\n\nDoug')
}

// ── Body with trailing whitespace → trimmed before append ───────────────────
{
  const result = insertSignoff('Let me know.   \n   ', 'Doug')
  expect('trailing whitespace trimmed before append', result, 'Let me know.\n\nDoug')
}

// ── Empty founderFirstName → throws ─────────────────────────────────────────
{
  expectThrows('empty founderFirstName → throws', () => insertSignoff('Hi', ''))
}

// ── Whitespace-only founderFirstName → throws ────────────────────────────────
{
  expectThrows('whitespace-only founderFirstName → throws', () => insertSignoff('Hi', '   '))
}

// ── "thanks for the message" embedded in body → not treated as closer ────────
// The closer detection looks for standalone closer patterns ("thanks,") not
// embedded uses of the word "thanks".
{
  const result = insertSignoff('Hi,\n\nThanks for the message — really helpful context.', 'Doug')
  expect('embedded "thanks" in body → appended (not a closer)', result, 'Hi,\n\nThanks for the message — really helpful context.\n\nDoug')
}

// ── "Doug, thanks" at end (name in non-signoff context) → appended ───────────
// Detection requires founderFirstName to be the LAST non-empty line alone.
// "Doug, thanks" has more text than just "Doug" so it does not trigger the guard.
{
  const result = insertSignoff('Sure.\n\nDoug, thanks for flagging that.', 'Doug')
  expect('"Doug, thanks" on last line → appended (name not alone)', result, 'Sure.\n\nDoug, thanks for flagging that.\n\nDoug')
}

// ── Multi-line body, sign-off detected in second-to-last line ────────────────
// The closer check scans the last 100 chars, which would include "Best," even if
// it is followed by a blank line.
{
  const result = insertSignoff('Here are the details.\n\nBest,\nDoug\n\n', 'Doug')
  expect('"Best," in last 100 chars with trailing whitespace → no append', result, 'Here are the details.\n\nBest,\nDoug')
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
