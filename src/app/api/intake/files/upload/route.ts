// POST /api/intake/files/upload
// Accepts a multipart form with fields: file (binary), file_purpose (string).
//
// Three checks before any data is written:
//   1. User is authenticated
//   2. User has a valid organisation_id in the users table
//   3. File is an allowed type and within the 10MB size limit
//
// Upload flow: validate → upload binary to Supabase Storage → extract text → insert metadata row.
// Text extraction happens here once. Agents read extracted_text from intake_files; they never
// download the binary again.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { isAllowedMimeType, extractText } from '@/lib/intake/extract-text'
import { logger } from '@/lib/logger'

const MAX_BYTES = 10 * 1024 * 1024 // 10MB

const VALID_PURPOSES = ['voice_sample', 'icp_doc', 'case_study', 'other'] as const
type FilePurpose = typeof VALID_PURPOSES[number]

function isValidPurpose(value: string): value is FilePurpose {
  return (VALID_PURPOSES as readonly string[]).includes(value)
}

export async function POST(request: NextRequest) {
  // ── 1. Authenticate via the user's session cookie ──────────────────────────
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

  // ── 2. Resolve organisation_id ─────────────────────────────────────────────
  // Use service role for all DB operations so we can write the intake_files row
  // and upload to storage regardless of RLS. Isolation is enforced by hardcoding
  // the organisation_id from the authenticated user's record.
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: userRecord } = await supabase
    .from('users')
    .select('organisation_id')
    .eq('id', user.id)
    .single() as { data: { organisation_id: string } | null; error: unknown }

  if (!userRecord) {
    return NextResponse.json({ error: 'User record not found.' }, { status: 403 })
  }

  const { organisation_id } = userRecord

  // ── 3. Parse multipart form data ───────────────────────────────────────────
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Could not parse form data.' }, { status: 400 })
  }

  const uploadedFile = formData.get('file')
  const rawPurpose = formData.get('file_purpose')

  if (!(uploadedFile instanceof File)) {
    return NextResponse.json({ error: 'No file provided.' }, { status: 400 })
  }

  if (!rawPurpose || typeof rawPurpose !== 'string' || !isValidPurpose(rawPurpose)) {
    return NextResponse.json(
      { error: 'file_purpose must be one of: voice_sample, icp_doc, case_study, other.' },
      { status: 400 }
    )
  }

  const filePurpose: FilePurpose = rawPurpose

  // ── 4. Validate file type and size ─────────────────────────────────────────
  const mimeType = uploadedFile.type

  if (!isAllowedMimeType(mimeType)) {
    return NextResponse.json(
      { error: 'Unsupported file type. Upload PDF, DOCX, TXT, or MD files only.' },
      { status: 422 }
    )
  }

  if (uploadedFile.size > MAX_BYTES) {
    return NextResponse.json(
      { error: 'File exceeds 10MB limit.' },
      { status: 422 }
    )
  }

  // ── 5. Build storage path ──────────────────────────────────────────────────
  // UUID prefix prevents collisions and removes any path traversal risk from
  // the original filename, which is stored as metadata only.
  const { randomUUID } = await import('crypto')
  const uuid = randomUUID()
  const sanitisedName = uploadedFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const storagePath = `${organisation_id}/${uuid}_${sanitisedName}`

  // ── 6. Upload binary to Supabase Storage ───────────────────────────────────
  const fileBuffer = Buffer.from(await uploadedFile.arrayBuffer())

  const { error: storageError } = await supabase.storage
    .from('intake-files')
    .upload(storagePath, fileBuffer, {
      contentType: mimeType,
      upsert: false,
    })

  if (storageError) {
    logger.error('File upload: storage upload failed', {
      organisation_id,
      error: storageError.message,
    })
    return NextResponse.json({ error: 'Storage upload failed.' }, { status: 500 })
  }

  // ── 7. Extract text ────────────────────────────────────────────────────────
  // Failures here are non-fatal — the file is uploaded, just not extractable.
  // extraction_status records this so the UI can surface it and the agent skips the file.
  let extractedText: string | null = null
  let extractionStatus: 'complete' | 'failed' = 'complete'

  try {
    extractedText = await extractText(fileBuffer, mimeType)
    if (!extractedText.trim()) {
      // File parsed but produced no text — treat as failed extraction.
      extractionStatus = 'failed'
      extractedText = null
      logger.warn('File upload: extraction produced empty text', {
        organisation_id, filename: uploadedFile.name, mimeType,
      })
    }
  } catch (err) {
    extractionStatus = 'failed'
    logger.error('File upload: text extraction failed', {
      organisation_id, filename: uploadedFile.name, mimeType,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // ── 8. Write metadata row ──────────────────────────────────────────────────
  const { data: fileRow, error: insertError } = await supabase
    .from('intake_files')
    .insert({
      organisation_id,
      storage_path: storagePath,
      original_filename: uploadedFile.name,
      file_size_bytes: uploadedFile.size,
      mime_type: mimeType,
      file_purpose: filePurpose,
      extracted_text: extractedText,
      extraction_status: extractionStatus,
      created_by: user.id,
    })
    .select('id, original_filename, file_size_bytes, mime_type, file_purpose, extraction_status, created_at')
    .single()

  if (insertError || !fileRow) {
    // Row insert failed — clean up the orphaned storage object.
    await supabase.storage.from('intake-files').remove([storagePath])
    logger.error('File upload: metadata insert failed', {
      organisation_id, error: insertError?.message,
    })
    return NextResponse.json({ error: 'Failed to save file record.' }, { status: 500 })
  }

  logger.info('File upload: complete', {
    organisation_id,
    file_id: fileRow.id,
    filename: uploadedFile.name,
    extraction_status: extractionStatus,
  })

  return NextResponse.json({ file: fileRow }, { status: 201 })
}
