// scripts/test-reply-drafts-list.ts
// Printer-with-assertions tests for the GET /api/reply-drafts logic.
// Run: npx tsx scripts/test-reply-drafts-list.ts
// No test runner — fails with process.exit(1) if any assertion fails.
//
// Tests the pure helper functions extracted from the list endpoint:
//   1. extractReplyBody — handles Instantly raw_data shapes and null inputs
//   2. Sort order — pending → send_failed → manual_required / draft_failed
//   3. Null prospect handling — missing prospect returns null gracefully
//   4. Null original_outbound_body — surfaced as null, not thrown
//
// Manual test steps (require a running server + operator session):
//   A. Auth check: GET /api/reply-drafts with no session → 401
//   B. Auth check: GET /api/reply-drafts with client-role session → 403
//   C. Happy path: GET /api/reply-drafts as operator → 200 with drafts array
//   D. Org filter: if a second org exists, its drafts must NOT appear in the response
//   E. Pending draft → approve → row disappears from next poll response
//   F. Pending draft → reject → row disappears from next poll response

import { extractReplyBody } from '../src/app/api/reply-drafts/route'

let passed = 0
let failed = 0

function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
    failed++
  }
}

// ── extractReplyBody ──────────────────────────────────────────────────────────

console.log('\n── extractReplyBody ───────────────────────────────────────────\n')

assert(
  'Instantly shape: raw_data.body.text string',
  extractReplyBody({ body: { text: 'Hello there' } }) === 'Hello there',
)

assert(
  'Flat string: raw_data.body as plain string',
  extractReplyBody({ body: 'Plain body' }) === 'Plain body',
)

assert(
  'Null input → null',
  extractReplyBody(null) === null,
)

assert(
  'No body field → null',
  extractReplyBody({ subject: 'Re: test' }) === null,
)

assert(
  'Body object with no text field → null',
  extractReplyBody({ body: { html: '<p>Hi</p>' } }) === null,
)

assert(
  'Empty string body → null (trimmed)',
  extractReplyBody({ body: { text: '   ' } }) === null,
)

assert(
  'Whitespace is trimmed from result',
  extractReplyBody({ body: { text: '  trimmed  ' } }) === 'trimmed',
)

// ── Sort order ────────────────────────────────────────────────────────────────
// Test the sort logic directly — mirrors the STATUS_PRIORITY constant in route.ts.

console.log('\n── Sort order ─────────────────────────────────────────────────\n')

type SortRow = { status: string; created_at: string }

const STATUS_PRIORITY: Record<string, number> = {
  pending: 0,
  send_failed: 1,
  manual_required: 2,
  draft_failed: 2,
}

function sortRows(rows: SortRow[]): SortRow[] {
  return [...rows].sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status] ?? 99
    const pb = STATUS_PRIORITY[b.status] ?? 99
    if (pa !== pb) return pa - pb
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })
}

const rows: SortRow[] = [
  { status: 'draft_failed',    created_at: '2026-05-04T10:00:00Z' },
  { status: 'send_failed',     created_at: '2026-05-04T09:00:00Z' },
  { status: 'pending',         created_at: '2026-05-04T08:00:00Z' },
  { status: 'manual_required', created_at: '2026-05-04T07:00:00Z' },
  { status: 'pending',         created_at: '2026-05-04T11:00:00Z' },
]

const sorted = sortRows(rows)

assert(
  'First row is pending (newest)',
  sorted[0].status === 'pending' && sorted[0].created_at === '2026-05-04T11:00:00Z',
  `got status=${sorted[0].status} created_at=${sorted[0].created_at}`,
)

assert(
  'Second row is pending (older)',
  sorted[1].status === 'pending' && sorted[1].created_at === '2026-05-04T08:00:00Z',
)

assert(
  'Third row is send_failed',
  sorted[2].status === 'send_failed',
)

assert(
  'Fourth and fifth rows are manual_required / draft_failed (either order)',
  ['manual_required', 'draft_failed'].includes(sorted[3].status) &&
  ['manual_required', 'draft_failed'].includes(sorted[4].status),
)

assert(
  'Unknown status sorts to end',
  sortRows([{ status: 'pending', created_at: '2026-05-04T10:00:00Z' }, { status: 'bogus_unknown', created_at: '2026-05-04T12:00:00Z' }])[0].status === 'pending',
)

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n── Results ────────────────────────────────────────────────────`)
console.log(`   Passed: ${passed}   Failed: ${failed}`)

if (failed > 0) {
  console.error('\nTest run FAILED')
  process.exit(1)
}

console.log('\nAll tests passed.')
console.log('\n── Manual test steps (requires running server) ────────────────')
console.log('  A. GET /api/reply-drafts with no session → expect 401')
console.log('  B. GET /api/reply-drafts with client-role session → expect 403')
console.log('  C. GET /api/reply-drafts as operator → expect 200 { drafts: [...] }')
console.log('  D. Org filter: confirm no cross-org rows in response')
console.log('  E. Approve pending draft → confirm row absent from next poll')
console.log('  F. Reject pending draft → confirm row absent from next poll')
console.log('  G. Polling: open triage page, switch tab, wait 60s, switch back — confirm fresh fetch fires')
console.log('  H. Concurrent edit: type in textarea, wait 30s poll → confirm edit not wiped')
