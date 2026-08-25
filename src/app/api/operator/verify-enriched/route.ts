// src/app/api/operator/verify-enriched/route.ts
//
// Operator-gated endpoint to trigger email verification for enriched prospects.
// Independent of tiering (parallel pass).
// Respects daily free-tier limit.

import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { verifyEnrichedBatch, DEFAULT_VERIFY_BATCH_SIZE } from '@/lib/sourcing/verification-trigger'

// The Hobby ceiling, and this repo's convention for every long route. This file declared
// NOTHING, which meant Vercel's default while the trigger deliberately sleeps 2s per address
// for rate limiting: the old default batch of 100 spent ~200s asleep before its last API
// call and could not complete inside its own request. Same omission commit 81ec7c9 fixed on
// the lead-upload page.
export const maxDuration = 300

interface VerifyEnrichedRequest {
  organisation_id: string
  max_batch_size?: number
}

export async function POST(request: NextRequest) {
  try {
    // ── 1. Authenticated ───────────────────────────────────────────────────
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthenticated' },
        { status: 401 }
      )
    }

    // ── 2. Operator role ───────────────────────────────────────────────────
    const { data: userRow } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    if (!userRow || userRow.role !== 'operator') {
      return NextResponse.json(
        { error: 'Forbidden: operator role required' },
        { status: 403 }
      )
    }

    // ── 3. Parse request ───────────────────────────────────────────────────
    const body: VerifyEnrichedRequest = await request.json()
    const { organisation_id, max_batch_size } = body

    if (!organisation_id) {
      return NextResponse.json(
        { error: 'organisation_id is required' },
        { status: 400 }
      )
    }

    // ── 4. Verify operator can access this organisation ──────────────────
    const { data: org } = await supabase
      .from('organisations')
      .select('id')
      .eq('id', organisation_id)
      .maybeSingle()

    if (!org) {
      return NextResponse.json(
        { error: 'Organisation not found' },
        { status: 404 }
      )
    }

    // ── 5. Trigger verification ────────────────────────────────────────────
    logger.info('verify-enriched: triggered by operator', {
      user_id: user.id,
      organisation_id,
      max_batch_size: max_batch_size ?? DEFAULT_VERIFY_BATCH_SIZE,
    })

    const result = await verifyEnrichedBatch(
      supabase,
      organisation_id,
      max_batch_size ?? DEFAULT_VERIFY_BATCH_SIZE,
    )

    logger.info('verify-enriched: completed', {
      user_id: user.id,
      organisation_id,
      status: result.status,
      total_verified: result.total_verified,
      send_eligible: result.send_eligible_count,
    })

    return NextResponse.json({
      success: true,
      result,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('verify-enriched: request failed', {
      error: msg,
    })

    return NextResponse.json(
      { error: 'Verification request failed', details: msg },
      { status: 500 }
    )
  }
}
