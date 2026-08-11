// POST /api/operator/prospects/override-tier
// Operator-only endpoint to override prospect tier classification
// Allows operators to approve flagged prospects or flag approved ones

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { logger } from '@/lib/logger'
import { requireOperator } from '@/lib/supabase/require-operator'

export const dynamic = 'force-dynamic'

async function buildSessionClient() {
  const cookieStore = await cookies()
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        },
      },
    }
  )
}

export async function POST(request: NextRequest) {
  try {
    const sessionClient = await buildSessionClient()
    const supabase = createServiceClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { user, authorized } = await requireOperator(sessionClient, supabase)
    if (!authorized || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    const { prospect_id, tier, reason } = await request.json()

    if (!prospect_id || !tier) {
      return NextResponse.json({ error: 'Missing prospect_id or tier' }, { status: 400 })
    }

    if (!['tier_1', 'tier_2', 'tier_3', null].includes(tier)) {
      return NextResponse.json({ error: 'Invalid tier' }, { status: 400 })
    }

    // Fetch prospect to verify existence and get organisation
    const { data: prospect, error: prospectError } = await supabase
      .from('prospects')
      .select('id, organisation_id, sourced_tier')
      .eq('id', prospect_id)
      .single()

    if (prospectError || !prospect) {
      return NextResponse.json({ error: 'Prospect not found' }, { status: 404 })
    }

    // Update prospect with override
    const now = new Date().toISOString()
    const { error: updateError } = await supabase
      .from('prospects')
      .update({
        operator_override_at: now,
        operator_override_by: user.id,
        operator_override_tier: tier,
        operator_override_reason: reason || null,
      })
      .eq('id', prospect_id)

    if (updateError) {
      logger.error('operator-override: update failed', {
        prospect_id,
        operator_id: user.id,
        error: updateError.message,
      })
      return NextResponse.json({ error: 'Failed to update prospect' }, { status: 500 })
    }

    logger.info('operator-override: applied', {
      prospect_id,
      organisation_id: prospect.organisation_id,
      operator_id: user.id,
      previous_tier: prospect.sourced_tier,
      new_tier: tier,
      reason: reason || 'no reason provided',
    })

    return NextResponse.json({
      ok: true,
      prospect_id,
      previous_tier: prospect.sourced_tier,
      new_tier: tier,
      override_at: now,
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger.error('operator-override: failed', { error: errorMsg })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
