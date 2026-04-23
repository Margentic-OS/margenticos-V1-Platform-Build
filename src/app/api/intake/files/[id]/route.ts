// DELETE /api/intake/files/[id]
// Deletes an intake file by its intake_files row ID.
// Verifies the file belongs to the authenticated user's organisation before deleting.
// Removes both the storage object and the metadata row.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { logger } from '@/lib/logger'

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  // ── 1. Authenticate ────────────────────────────────────────────────────────
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

  const { data: { user }, error: authError } = await sessionClient.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // ── 2. Resolve user's organisation and verify file ownership ──────────────
  const { data: userRecord } = await supabase
    .from('users')
    .select('organisation_id')
    .eq('id', user.id)
    .single() as { data: { organisation_id: string } | null; error: unknown }

  if (!userRecord) {
    return NextResponse.json({ error: 'User record not found.' }, { status: 403 })
  }

  const { data: fileRow } = await supabase
    .from('intake_files')
    .select('id, organisation_id, storage_path')
    .eq('id', id)
    .single() as {
      data: { id: string; organisation_id: string; storage_path: string } | null;
      error: unknown
    }

  if (!fileRow) {
    return NextResponse.json({ error: 'File not found.' }, { status: 404 })
  }

  if (fileRow.organisation_id !== userRecord.organisation_id) {
    logger.warn('File delete: cross-org attempt blocked', {
      user_id: user.id,
      file_id: id,
      file_org: fileRow.organisation_id,
      user_org: userRecord.organisation_id,
    })
    return NextResponse.json({ error: 'File not found.' }, { status: 404 })
  }

  // ── 3. Delete storage object ───────────────────────────────────────────────
  const { error: storageError } = await supabase.storage
    .from('intake-files')
    .remove([fileRow.storage_path])

  if (storageError) {
    logger.error('File delete: storage removal failed', {
      file_id: id, error: storageError.message,
    })
    return NextResponse.json({ error: 'Storage deletion failed.' }, { status: 500 })
  }

  // ── 4. Delete metadata row ─────────────────────────────────────────────────
  const { error: deleteError } = await supabase
    .from('intake_files')
    .delete()
    .eq('id', id)

  if (deleteError) {
    logger.error('File delete: metadata row deletion failed', {
      file_id: id, error: deleteError.message,
    })
    return NextResponse.json({ error: 'Failed to delete file record.' }, { status: 500 })
  }

  logger.info('File delete: complete', { file_id: id, organisation_id: userRecord.organisation_id })

  return NextResponse.json({ success: true }, { status: 200 })
}
