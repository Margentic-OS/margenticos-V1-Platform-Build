// POST /api/intake/website/fetch
// Accepts { url: string } in the request body.
//
// Three checks before any fetch begins:
//   1. User is authenticated
//   2. User has a valid organisation_id in the users table
//   3. URL is a non-empty string
//
// Fetch flow: normalise URL → fetch homepage + discover up to 3 inner pages →
// delete existing rows for this org → insert fresh rows.
// Old rows are always replaced on re-fetch so agents always see current content.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { fetchWebsitePages } from '@/lib/intake/fetch-website'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  // ── 1. Authenticate via session cookie ────────────────────────────────────
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

  // ── 2. Resolve organisation_id ────────────────────────────────────────────
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: userRow, error: userError } = await supabase
    .from('users')
    .select('organisation_id')
    .eq('id', user.id)
    .single()

  if (userError || !userRow?.organisation_id) {
    return NextResponse.json({ error: 'No organisation found for this user.' }, { status: 403 })
  }

  const organisation_id: string = userRow.organisation_id

  // ── 3. Validate request body ──────────────────────────────────────────────
  let body: { url?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }

  const url = typeof body.url === 'string' ? body.url.trim() : ''
  if (!url) {
    return NextResponse.json({ error: 'url is required.' }, { status: 400 })
  }

  logger.info('website-fetch: starting', { organisation_id, url })

  // ── 4. Fetch pages (may take up to ~40s for 4 pages with retries) ─────────
  let pages
  try {
    pages = await fetchWebsitePages(url)
  } catch (err) {
    logger.error('website-fetch: unexpected error during fetch', { organisation_id, url, error: String(err) })
    return NextResponse.json({ error: 'Website fetch failed unexpectedly.' }, { status: 500 })
  }

  // ── 5. Replace existing pages for this org ────────────────────────────────
  // Delete then insert — keeps the table tidy on re-fetch without needing upsert keys.
  const { error: deleteError } = await supabase
    .from('intake_website_pages')
    .delete()
    .eq('organisation_id', organisation_id)

  if (deleteError) {
    logger.error('website-fetch: failed to delete existing pages', { organisation_id, error: deleteError.message })
    return NextResponse.json({ error: 'Database error — could not replace existing pages.' }, { status: 500 })
  }

  const rows = pages.map(p => ({ ...p, organisation_id }))
  const { error: insertError } = await supabase
    .from('intake_website_pages')
    .insert(rows)

  if (insertError) {
    logger.error('website-fetch: failed to insert pages', { organisation_id, error: insertError.message })
    return NextResponse.json({ error: 'Database error — could not save fetched pages.' }, { status: 500 })
  }

  const complete = pages.filter(p => p.fetch_status === 'complete').length
  const failed   = pages.filter(p => p.fetch_status === 'failed').length

  logger.info('website-fetch: complete', { organisation_id, total: pages.length, complete, failed })

  return NextResponse.json({
    success: true,
    pages_fetched: complete,
    pages_failed: failed,
    pages: pages.map(p => ({ label: p.page_label, url: p.url, status: p.fetch_status })),
  })
}
