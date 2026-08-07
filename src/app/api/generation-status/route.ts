// GET /api/generation-status
//
// Checks if there is an active generation run for an org+doctype.
// Used by the UI to poll for real generation state (reconnection on remount, status updates).
//
// Query params:
//   client_id (required): organisation to check
//   document_type (required): 'icp', 'positioning', 'tov', 'messaging'
//
// Response: { isGenerating: boolean, run_id?: string, started_at?: string }
// - isGenerating = true if there's a status='running' run started within 10 minutes
// - run_id and started_at only present if isGenerating=true

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { logger } from '@/lib/logger'

function makeServiceClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const client_id = searchParams.get('client_id')
  const document_type = searchParams.get('document_type')

  if (!client_id || !document_type) {
    return NextResponse.json(
      { error: 'client_id and document_type query params are required.' },
      { status: 400 }
    )
  }

  const cookieStore = await cookies()
  const sessionClient = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        },
      },
    }
  )
  const supabase = makeServiceClient()

  // ── Auth: user must be authenticated ────────────────────────────────────────
  const { data: { user }, error: authError } = await sessionClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  // ── Auth: user must be operator OR belong to this org ────────────────────────
  const { data: userRow, error: userError } = await supabase
    .from('users')
    .select('role, organisation_id')
    .eq('id', user.id)
    .single()

  if (userError || !userRow) {
    return NextResponse.json({ error: 'Could not verify user role.' }, { status: 403 })
  }

  const isOperator = userRow.role === 'operator'
  const userOrgId = userRow.organisation_id

  if (!isOperator && userOrgId !== client_id) {
    return NextResponse.json({ error: 'Not authorized for this client.' }, { status: 403 })
  }

  // ── Check for active generation runs ────────────────────────────────────────
  const RUNNING_THRESHOLD_MS = 10 * 60 * 1000
  const { data: runningRuns } = await supabase
    .from('agent_runs')
    .select('id, started_at')
    .eq('organisation_id', client_id)
    .eq('agent_name', `${document_type}-generation`)
    .eq('status', 'running')

  const now = Date.now()
  const freshRun = runningRuns?.find(run => {
    const elapsedMs = now - new Date(run.started_at).getTime()
    return elapsedMs < RUNNING_THRESHOLD_MS
  })

  if (freshRun) {
    return NextResponse.json({
      isGenerating: true,
      run_id: freshRun.id,
      started_at: freshRun.started_at,
    })
  }

  return NextResponse.json({ isGenerating: false })
}
