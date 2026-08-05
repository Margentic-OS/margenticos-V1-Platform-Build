import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { logger } from '@/lib/logger'
import * as Sentry from '@sentry/nextjs'

interface ArchiveRequestBody {
  action: 'archive' | 'unarchive'
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  try {
    // ── 1. Authenticated ───────────────────────────────────────────────────────
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return redirect('/login')

    // ── 2. Operator role — checked on every request ────────────────────────────
    const { data: userRow } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    if (!userRow || userRow.role !== 'operator') {
      logger.warn('archive-org: non-operator attempted action', {
        user_id: user.id,
        org_id: id,
        role: userRow?.role,
      })
      return Response.json({ error: 'Operator access required' }, { status: 403 })
    }

    // ── 3. Parse request body ──────────────────────────────────────────────────
    const body = (await request.json()) as ArchiveRequestBody
    if (body.action !== 'archive' && body.action !== 'unarchive') {
      return Response.json({ error: 'Invalid action' }, { status: 400 })
    }

    // ── 4. Verify org exists ───────────────────────────────────────────────────
    const { data: org, error: orgError } = await supabase
      .from('organisations')
      .select('id, name, archived_at')
      .eq('id', id)
      .maybeSingle()

    if (orgError) {
      logger.error('archive-org: lookup failed', { org_id: id, error: orgError })
      return Response.json({ error: 'Failed to lookup organisation' }, { status: 500 })
    }

    if (!org) {
      logger.warn('archive-org: org not found', { org_id: id })
      return Response.json({ error: 'Organisation not found' }, { status: 404 })
    }

    // ── 5. Archive or unarchive ────────────────────────────────────────────────
    const isArchiving = body.action === 'archive'
    const now = new Date().toISOString()

    const { error: updateError } = await supabase
      .from('organisations')
      .update({
        archived_at: isArchiving ? now : null,
        updated_at: now,
      })
      .eq('id', id)

    if (updateError) {
      logger.error('archive-org: update failed', {
        org_id: id,
        action: body.action,
        error: updateError,
      })
      Sentry.captureException(new Error(`Archive action failed: ${updateError.message}`), {
        extra: { org_id: id, action: body.action },
      })
      return Response.json({ error: 'Failed to update organisation' }, { status: 500 })
    }

    // ── 6. Log and respond ─────────────────────────────────────────────────────
    logger.info('archive-org: action completed', {
      org_id: id,
      org_name: org.name,
      action: body.action,
      timestamp: now,
    })

    return Response.json({
      success: true,
      action: body.action,
      org_id: id,
      org_name: org.name,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('archive-org: unhandled error', { org_id: id, error: message })
    Sentry.captureException(error, { tags: { component: 'archive-org-route' } })
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
