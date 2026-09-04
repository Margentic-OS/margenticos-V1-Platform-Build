'use server'

// Server action: upsert a single intake response.
// Called on blur from the intake form — one field at a time.
// Uses UPSERT so re-saving a field increments its version rather than duplicating.
// See prd/sections/05-intake.md for field definitions.

import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import {
  documentsAffectedBy,
  intakeStaleReason,
} from '@/lib/intake/document-staleness'

export async function saveIntakeResponse(
  fieldKey: string,
  fieldLabel: string,
  responseValue: string,
  isCritical: boolean,
  section: string
) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    logger.warn('saveIntakeResponse called without authenticated user')
    return { error: 'Not authenticated' }
  }

  // Get the user's organisation_id from the users table
  const { data: userRecord } = await supabase
    .from('users')
    .select('organisation_id')
    .eq('id', user.id)
    .single() as { data: { organisation_id: string } | null; error: unknown }

  if (!userRecord) {
    logger.error('saveIntakeResponse: no user record found', { userId: user.id })
    return { error: 'User record not found' }
  }

  const wordCount = responseValue.trim()
    ? responseValue.trim().split(/\s+/).length
    : 0

  // Read the answer being replaced BEFORE writing over it. The form saves on blur whether or
  // not anything was typed, so without this comparison every visit to a field would count as
  // an edit and flag documents that nothing has actually invalidated.
  const { data: existing } = await supabase
    .from('intake_responses')
    .select('response_value')
    .eq('organisation_id', userRecord.organisation_id)
    .eq('field_key', fieldKey)
    .maybeSingle() as { data: { response_value: string | null } | null }

  // UPSERT: insert or update based on (organisation_id, field_key) unique constraint
  // Cast required because Database type is a placeholder until schema types are generated
  const { error } = await (supabase
    .from('intake_responses') as unknown as {
      upsert: (
        values: Record<string, unknown>,
        options: { onConflict: string; ignoreDuplicates: boolean }
      ) => Promise<{ error: unknown }>
    })
    .upsert(
      {
        organisation_id: userRecord.organisation_id,
        field_key: fieldKey,
        field_label: fieldLabel,
        response_value: responseValue,
        is_critical: isCritical,
        word_count: wordCount,
        section,
      },
      {
        onConflict: 'organisation_id,field_key',
        ignoreDuplicates: false,
      }
    )

  if (error) {
    logger.error('saveIntakeResponse failed', { fieldKey, error })
    return { error: 'Failed to save' }
  }

  // An answer that CHANGED, not one written for the first time. A first answer cannot
  // invalidate a document, because no document was built without it: either it predates
  // generation, or generation has not happened yet.
  const previous = existing?.response_value ?? null
  const isEdit = previous !== null && previous.trim() !== responseValue.trim()

  if (isEdit) {
    await markDocumentsStaleForIntakeEdit(
      supabase,
      userRecord.organisation_id,
      fieldKey,
    )
  }

  return { success: true, wordCount }
}

/**
 * Flag the live documents built from this answer.
 *
 * MARKS ONLY. Nothing regenerates and nothing is republished: an approved document keeps its
 * approved content, and a human decides what to do. Replacing approved copy with something
 * the client has not seen is the failure this must never cause.
 *
 * Never throws. The client's answer is already saved by the time this runs, and losing the
 * flag is a smaller harm than failing a save that succeeded.
 */
async function markDocumentsStaleForIntakeEdit(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organisationId: string,
  fieldKey: string,
): Promise<void> {
  const affected = documentsAffectedBy(fieldKey)
  if (affected.length === 0) return

  try {
    const { error, count } = await (supabase
      .from('strategy_documents') as unknown as {
        update: (values: Record<string, unknown>, options: { count: 'exact' }) => {
          eq: (c: string, v: string) => {
            eq: (c: string, v: string) => {
              in: (c: string, v: readonly string[]) => {
                is: (c: string, v: boolean) => Promise<{ error: unknown; count: number | null }>
              }
            }
          }
        }
      })
      .update(
        { is_stale: true, stale_reason: intakeStaleReason(fieldKey) },
        { count: 'exact' },
      )
      .eq('organisation_id', organisationId) // explicit isolation filter
      .eq('status', 'active')
      .in('document_type', affected)
      .is('is_stale', false)

    if (error) {
      logger.error('intake edit: could not flag documents stale', {
        organisation_id: organisationId, fieldKey, affected, error,
        consequence: 'The answer is saved. The documents built from it are NOT flagged, so ' +
          'the operator will not be told they may be out of date.',
      })
      return
    }

    logger.info('intake edit: flagged documents stale', {
      organisation_id: organisationId, fieldKey, affected, flagged: count ?? 0,
    })
  } catch (err) {
    logger.error('intake edit: threw while flagging documents stale', {
      organisation_id: organisationId, fieldKey, error: String(err),
    })
  }
}

export interface IntakeFileRecord {
  id: string
  original_filename: string
  file_size_bytes: number
  mime_type: string
  file_purpose: 'voice_sample' | 'icp_doc' | 'case_study' | 'other'
  extraction_status: 'pending' | 'complete' | 'failed'
  created_at: string
}

export async function loadIntakeFiles(): Promise<IntakeFileRecord[]> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const { data: userRecord } = await supabase
    .from('users')
    .select('organisation_id')
    .eq('id', user.id)
    .single() as { data: { organisation_id: string } | null; error: unknown }

  if (!userRecord) return []

  // intake_files is not yet in the generated Database type — cast required until types are regenerated.
  const { data } = await (supabase as unknown as {
    from: (table: string) => {
      select: (cols: string) => {
        eq: (col: string, val: string) => {
          order: (col: string, opts: { ascending: boolean }) => Promise<{ data: IntakeFileRecord[] | null }>
        }
      }
    }
  })
    .from('intake_files')
    .select('id, original_filename, file_size_bytes, mime_type, file_purpose, extraction_status, created_at')
    .eq('organisation_id', userRecord.organisation_id)
    .order('created_at', { ascending: false })

  return data ?? []
}

export async function loadIntakeResponses() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return {}

  const { data: userRecord } = await supabase
    .from('users')
    .select('organisation_id')
    .eq('id', user.id)
    .single() as { data: { organisation_id: string } | null; error: unknown }

  if (!userRecord) return {}

  const { data: responses } = await supabase
    .from('intake_responses')
    .select('field_key, response_value, word_count')
    .eq('organisation_id', userRecord.organisation_id) as {
      data: { field_key: string; response_value: string; word_count: number }[] | null;
      error: unknown
    }

  if (!responses) return {}

  // Return as a map of field_key → response_value for easy lookup in the form
  return Object.fromEntries(
    responses.map(r => [r.field_key, { value: r.response_value, wordCount: r.word_count }])
  ) as Record<string, { value: string; wordCount: number }>
}
