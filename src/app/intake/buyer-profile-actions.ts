'use server'

// Server actions for the buyer-targeting answers.
//
// A separate file from actions.ts because the store is a different shape: one typed row per
// organisation rather than one EAV row per field, so there is no fieldKey/fieldLabel/section
// triple to pass and nothing to word-count.
//
// The auth shape is deliberately identical to saveIntakeResponse: authenticate, resolve the
// caller's own organisation from the users table, and never accept an organisation_id from the
// caller. A client cannot name someone else's organisation because they are never asked for
// one.

import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import type { BuyerProfile } from '@/lib/intake/buyer-profile'
import {
  readBuyerProfile,
  writeBuyerProfile,
  changedBuyerProfileFields,
} from '@/lib/intake/buyer-profile-store'
import { documentsAffectedBy, intakeStaleReason } from '@/lib/intake/document-staleness'

async function resolveOwnOrganisationId(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: userRecord } = await supabase
    .from('users')
    .select('organisation_id')
    .eq('id', user.id)
    .single() as { data: { organisation_id: string } | null }

  return userRecord?.organisation_id ?? null
}

export async function loadBuyerProfile(): Promise<BuyerProfile | null> {
  const supabase = await createClient()
  const organisationId = await resolveOwnOrganisationId(supabase)
  if (!organisationId) return null
  return readBuyerProfile(supabase, organisationId)
}

export async function saveBuyerProfile(
  profile: BuyerProfile,
): Promise<{ success: true } | { error: string }> {
  const supabase = await createClient()

  const organisationId = await resolveOwnOrganisationId(supabase)
  if (!organisationId) {
    logger.warn('saveBuyerProfile called without a resolvable organisation')
    return { error: 'Not authenticated' }
  }

  // Read what is being replaced BEFORE writing, so an edit can be told from a first answer.
  // Same reasoning as saveIntakeResponse: the form saves whether or not anything changed.
  const previous = await readBuyerProfile(supabase, organisationId)

  const { error } = await writeBuyerProfile(supabase, organisationId, profile)
  if (error) {
    logger.error('saveBuyerProfile failed', { organisation_id: organisationId, error })
    return { error: 'Failed to save' }
  }

  await markDocumentsStaleForBuyerProfileEdit(
    supabase,
    organisationId,
    changedBuyerProfileFields(previous, profile),
  )

  return { success: true }
}

/**
 * Flag the live documents built from whichever of these answers changed.
 *
 * NOTHING IS FLAGGED TODAY AND THAT IS CORRECT. Every buyer-profile field is currently in
 * NOT_MAPPED, so documentsAffectedBy returns an empty list for all of them and this is a
 * no-op. It is wired now rather than later because the alternative is a session that maps a
 * field in document-staleness.ts, sees the map entry, and has no idea the write path never
 * calls the helper. Mapping a field is then the only step needed to make flagging work.
 *
 * Never throws, for the same reason the EAV version does not: the answers are already saved,
 * and losing a flag is a smaller harm than failing a save that succeeded.
 */
async function markDocumentsStaleForBuyerProfileEdit(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organisationId: string,
  changedFields: readonly string[],
): Promise<void> {
  for (const fieldKey of changedFields) {
    const affected = documentsAffectedBy(fieldKey)
    if (affected.length === 0) continue

    try {
      const { error } = await (supabase
        .from('strategy_documents') as unknown as {
          update: (values: Record<string, unknown>) => {
            eq: (c: string, v: string) => {
              eq: (c: string, v: string) => {
                in: (c: string, v: readonly string[]) => {
                  is: (c: string, v: boolean) => Promise<{ error: unknown }>
                }
              }
            }
          }
        })
        .update({ is_stale: true, stale_reason: intakeStaleReason(fieldKey) })
        .eq('organisation_id', organisationId) // explicit isolation filter
        .eq('status', 'active')
        .in('document_type', affected)
        .is('is_stale', false)

      if (error) {
        logger.error('buyer profile edit: could not flag documents stale', {
          organisation_id: organisationId, fieldKey, affected, error,
          consequence: 'The answer is saved. The documents built from it are NOT flagged.',
        })
      }
    } catch (err) {
      logger.error('buyer profile edit: threw while flagging documents stale', {
        organisation_id: organisationId, fieldKey, error: String(err),
      })
    }
  }
}
