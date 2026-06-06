// Fix 4 verification: hit the actual /api/documents/revise route with REVISION_FORCE_GATE_FAIL=true
// Confirms: response is 422, body is { error: "..." } in the shape DocApprovalControls reads.
// Run with: REVISION_FORCE_GATE_FAIL=true npx tsx scripts/test-revision-route-422.ts

import * as dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'

const DRY_RUN_USER_EMAIL = 'd.h.p1999+dryrun1@gmail.com'
const MESSAGING_DOC_ID   = '7660973b-3895-4aae-bd9e-5819f000d488'
const PROJECT_REF        = 'hjpvnvjryxdjcfdsfhzy'
const BASE_URL           = 'http://localhost:3000'
const COOKIE_NAME        = `sb-${PROJECT_REF}-auth-token`

async function main() {
  if (process.env.REVISION_FORCE_GATE_FAIL !== 'true') {
    console.error('Run with: REVISION_FORCE_GATE_FAIL=true npx tsx scripts/test-revision-route-422.ts')
    process.exit(1)
  }

  const admin = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Step 1: Generate a magic link OTP for the DRY RUN test user.
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: DRY_RUN_USER_EMAIL,
  })
  if (linkErr || !linkData) {
    console.error('generateLink failed:', linkErr?.message)
    process.exit(1)
  }
  const otp = linkData.properties?.email_otp
  if (!otp) {
    console.error('No email_otp in generateLink response')
    process.exit(1)
  }

  // Step 2: Exchange OTP for a full session via the Supabase verify endpoint.
  const verifyRes = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/verify`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      },
      body: JSON.stringify({ type: 'email', email: DRY_RUN_USER_EMAIL, token: otp }),
    },
  )
  const session = await verifyRes.json() as {
    access_token?: string
    refresh_token?: string
    token_type?: string
    expires_in?: number
    expires_at?: number
    user?: unknown
  }
  if (!session.access_token) {
    console.error('verifyOtp failed:', JSON.stringify(session))
    process.exit(1)
  }

  // Step 3: Construct the @supabase/ssr cookie value.
  // Format: "base64-" + base64url(JSON.stringify(session))
  const sessionPayload = {
    access_token:  session.access_token,
    token_type:    session.token_type ?? 'bearer',
    expires_in:    session.expires_in ?? 3600,
    expires_at:    session.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
    refresh_token: session.refresh_token,
    user:          session.user,
  }
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(sessionPayload)).toString('base64url')

  // Step 4: POST to the route with the auth cookie and the force-fail env already set.
  console.log(`\nPOST ${BASE_URL}/api/documents/revise`)
  console.log('Body: { document_id, note }')
  console.log('Env:  REVISION_FORCE_GATE_FAIL=true\n')

  const routeRes = await fetch(`${BASE_URL}/api/documents/revise`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `${COOKIE_NAME}=${cookieValue}`,
    },
    body: JSON.stringify({
      document_id: MESSAGING_DOC_ID,
      note: 'Minor wording tweak',
    }),
  })

  const responseBody = await routeRes.json() as unknown

  console.log(`Status: ${routeRes.status}`)
  console.log('Body:', JSON.stringify(responseBody, null, 2))

  const passed = routeRes.status === 422 &&
    typeof responseBody === 'object' &&
    responseBody !== null &&
    'error' in responseBody &&
    typeof (responseBody as { error: unknown }).error === 'string' &&
    (responseBody as { error: string }).error.startsWith("We couldn't apply")

  console.log(`\nFix 4 route test: ${passed ? 'PASS' : 'FAIL'}`)
  if (passed) {
    console.log('422 confirmed with human-readable error string in { error } shape.')
  }
}

main().catch(err => {
  console.error('Script error:', err)
  process.exit(1)
})
