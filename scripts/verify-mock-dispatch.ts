#!/usr/bin/env npx tsx
// scripts/verify-mock-dispatch.ts
//
// Verification that in-process mock dispatch works for the three critical handler paths.
// Run: npx tsx scripts/verify-mock-dispatch.ts
//
// What this proves:
//   1. When INSTANTLY_API_ACTIVE=false, the handlers use in-process mock dispatch.
//   2. global.fetch is NEVER called for Instantly domains — zero network dependency.
//   3. The returned shapes match what the callers (server actions, cron) expect.

// ── Load env before any imports ──────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({ path: '.env.local' })

// Force mock mode via env var overrides (both added to auth.ts for this purpose)
process.env.INSTANTLY_API_ACTIVE = 'false'
process.env.INSTANTLY_API_KEY_OVERRIDE = 'test-key-verify'

// ── Patch fetch to throw for any Instantly domain ────────────────────────────
// If mock dispatch works, fetch is never called. If it is called, the test fails loudly.
const originalFetch = globalThis.fetch
let fetchCallCount = 0
// @ts-ignore - intentional override for test; ts-expect-error fails when TS sees no error here
globalThis.fetch = (url: RequestInfo | URL, ...args: unknown[]) => {
  const urlStr = String(url)
  if (
    urlStr.includes('api.instantly.ai') ||
    urlStr.includes('developer.instantly.ai') ||
    urlStr.includes('/api/mock/instantly')
  ) {
    fetchCallCount++
    throw new Error(`FETCH CALLED FOR INSTANTLY IN MOCK MODE: ${urlStr}`)
  }
  // Allow Supabase and other non-Instantly fetches through
  return originalFetch(url as RequestInfo | URL, ...(args as [RequestInit?]))
}

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0
let failed = 0

function assert(label: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`)
    failed++
  }
}

async function main() {
  console.log('\n── verify-mock-dispatch.ts ──────────────────────────────────────')
  console.log('  INSTANTLY_API_ACTIVE=false  INSTANTLY_API_KEY_OVERRIDE=test-key-verify')
  console.log('  fetch() patched: will throw if any Instantly URL is called\n')

  // ── Test 1: syncSequenceShell ────────────────────────────────────────────
  console.log('1. syncSequenceShell (PATCH /campaigns/:id)')
  {
    const { syncSequenceShell } = await import('../src/lib/integrations/handlers/instantly/syncSequenceShell')

    // Minimal 4-step messaging doc — matches standard sequence shape
    const messagingDoc = {
      emails: [
        { sequence_position: 1, subject_line: 'Intro', subject_char_count: 5, body: 'Email 1 body', word_count: 3 },
        { sequence_position: 2, subject_line: null, subject_char_count: 0, body: 'Email 2 body', word_count: 3 },
        { sequence_position: 3, subject_line: null, subject_char_count: 0, body: 'Email 3 body', word_count: 3 },
        { sequence_position: 4, subject_line: 'last note', subject_char_count: 9, body: 'Email 4 body', word_count: 3 },
      ],
    }

    const result = await syncSequenceShell({
      organisationId: 'verify-org-id',
      campaignExternalId: 'verify-ext-campaign-id',
      campaignInternalId: '00000000-0000-0000-0000-000000000001',
      segmentId: null,
      messagingDoc,
      messagingDocId: 'verify-doc-id',
    })

    console.log('  response:', JSON.stringify(result))
    assert('result.ok === true', result.ok === true)
    assert('stepCount === 4', result.ok && result.stepCount === 4)
    assert('syncedAt is ISO string', result.ok && typeof result.syncedAt === 'string' && result.syncedAt.includes('T'))
    assert('fetch NOT called for Instantly', fetchCallCount === 0, `fetchCallCount=${fetchCallCount}`)
  }

  // ── Test 2: uploadLeads (1 lead) ─────────────────────────────────────────
  console.log('\n2. uploadLeads (POST /leads/add, 1 lead)')
  {
    const { uploadLeads } = await import('../src/lib/integrations/handlers/instantly/uploadLeads')

    const result = await uploadLeads(
      'verify-org-id',
      'verify-ext-campaign-id',
      [{ email: 'test-verify@example.com', first_name: 'Test', last_name: 'Verify' }]
    )

    console.log('  response:', JSON.stringify(result))
    assert('leads_uploaded === 1', result.leads_uploaded === 1)
    assert('created_count === 1', result.created_count === 1)
    assert('in_blocklist === 0', result.in_blocklist === 0)
    assert('duplicated === 0', result.duplicated === 0)
    assert('fetch NOT called for Instantly', fetchCallCount === 0, `fetchCallCount=${fetchCallCount}`)
  }

  // ── Test 3: orderMailboxes simulate=true (DFY quote) ─────────────────────
  console.log('\n3. orderMailboxes simulate=true (POST /dfy-email-account-orders)')
  {
    const { orderMailboxes } = await import('../src/lib/integrations/handlers/instantly/orderMailboxes')

    const result = await orderMailboxes('verify-org-id', ['testdomain.com'], true)

    console.log('  response:', JSON.stringify(result))
    assert('order_placed === false', result.order_placed === false)
    assert('order_is_valid === true', result.order_is_valid === true)
    assert('total_price === 35', result.total_price === 35)
    assert('simulated === true', result.simulated === true)
    assert('fetch NOT called for Instantly', fetchCallCount === 0, `fetchCallCount=${fetchCallCount}`)
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed`)
  console.log(`fetch() called for Instantly domains: ${fetchCallCount} (must be 0)\n`)

  if (failed > 0 || fetchCallCount > 0) process.exit(1)
}

main().catch(err => {
  console.error('verify-mock-dispatch: unexpected error:', err)
  process.exit(1)
})
