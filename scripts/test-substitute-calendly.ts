/**
 * Unit tests for substituteCalendly.
 * Run: npx tsx scripts/test-substitute-calendly.ts
 */

import { substituteCalendly } from '../src/lib/reply-handling/substitute-calendly'

let passed = 0
let failed = 0

function expect(
  description: string,
  actual: unknown,
  expected: unknown,
): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
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

console.log('\nsubstitute-calendly tests\n')

// ── Body with placeholder + valid link → substituted ────────────────────────
{
  const result = substituteCalendly('Grab a slot: {calendly_link}', 'https://cal.com/doug/30min')
  expect('placeholder + valid link → substituted', result, {
    body: 'Grab a slot: https://cal.com/doug/30min',
    missing: false,
    substituted: true,
  })
}

// ── Body with placeholder + null link → missing: true ───────────────────────
{
  const result = substituteCalendly('Grab a slot: {calendly_link}', null)
  expect('placeholder + null link → missing: true', result, {
    body: 'Grab a slot: {calendly_link}',
    missing: true,
    substituted: false,
  })
}

// ── Body with placeholder + empty string link → missing: true ───────────────
{
  const result = substituteCalendly('Book here: {calendly_link}', '')
  expect('placeholder + empty string → missing: true', result, {
    body: 'Book here: {calendly_link}',
    missing: true,
    substituted: false,
  })
}

// ── Body with placeholder + whitespace-only link → missing: true ─────────────
{
  const result = substituteCalendly('Book here: {calendly_link}', '   ')
  expect('placeholder + whitespace-only → missing: true', result, {
    body: 'Book here: {calendly_link}',
    missing: true,
    substituted: false,
  })
}

// ── Body with multiple placeholders → all substituted ────────────────────────
{
  const result = substituteCalendly(
    'Click {calendly_link} or {calendly_link} to book.',
    'https://cal.com/doug/30min',
  )
  expect('multiple placeholders → all substituted', result, {
    body: 'Click https://cal.com/doug/30min or https://cal.com/doug/30min to book.',
    missing: false,
    substituted: true,
  })
}

// ── Body without placeholder + valid link → unchanged, substituted: false ────
{
  const result = substituteCalendly('No link in this body.', 'https://cal.com/doug/30min')
  expect('no placeholder + valid link → unchanged, not a failure', result, {
    body: 'No link in this body.',
    missing: false,
    substituted: false,
  })
}

// ── Body without placeholder + null link → unchanged, missing: false ─────────
{
  const result = substituteCalendly('No link in this body.', null)
  expect('no placeholder + null link → unchanged, NOT a failure', result, {
    body: 'No link in this body.',
    missing: false,
    substituted: false,
  })
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
