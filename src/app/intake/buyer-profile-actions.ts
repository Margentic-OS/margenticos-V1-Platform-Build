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
  readBuyerProfileRow,
  writeBuyerProfile,
  changedBuyerProfileFields,
} from '@/lib/intake/buyer-profile-store'
import { flagDocumentsStaleForIntakeEditSafely } from '@/lib/intake/flag-stale-documents'
import { buyerProfileAnswerChanges } from '@/lib/intake/answer-change'
import { notifyOperatorOfIntakeEditSafely } from '@/lib/intake/notify-intake-edit'

/**
 * The caller's own organisation, from their session. THE ONLY SOURCE OF organisationId here.
 *
 * Read this before changing anything downstream of it. The flagging below runs with the
 * service-role key, which bypasses RLS, and the whole safety argument for that rests on this
 * function: the id comes from Supabase Auth and then from that user's own row in `users`.
 * saveBuyerProfile takes a BuyerProfile and nothing else, and BuyerProfile has no
 * organisation field, so there is no argument through which a caller could name one.
 *
 * If a future signature ever accepts an organisation id from the caller, the service-role
 * write downstream becomes a cross-organisation write primitive. Do not do that.
 */
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
  //
  // readBuyerProfileRow, NOT readBuyerProfile. The difference is the whole first-save fix:
  // readBuyerProfile returns an EMPTY profile when no row exists, which is indistinguishable
  // from a row whose answers are all blank. Comparing against that made a client's FIRST save
  // report every answer they filled in as "changed", and flag their live prospect profile on
  // the strength of answers that never had an older value. readBuyerProfileRow returns null
  // for "no row", and changedBuyerProfileFields returns nothing for null, which is exactly
  // what isIntakeAnswerEdit does with a null previous on the other path.
  const previous = await readBuyerProfileRow(supabase, organisationId)

  const { error } = await writeBuyerProfile(supabase, organisationId, profile)
  if (error) {
    logger.error('saveBuyerProfile failed', { organisation_id: organisationId, error })
    return { error: 'Failed to save' }
  }

  // ONE COMPARISON, TWO CONSUMERS. The flagging and the notification must never disagree
  // about which answers moved, so changedBuyerProfileFields is called once and its result is
  // handed to both. Calling it twice would be two derivations of one fact, which is the shape
  // this file's neighbours keep paying for.
  //
  // It returns NOTHING when `previous` is null, which is how a first save is told from an
  // edit here. That is why the read above is readBuyerProfileRow and not readBuyerProfile:
  // see its header, and isIntakeAnswerEdit on the other path for the same decision.
  const changedFields = changedBuyerProfileFields(previous, profile)

  // Flags only; never regenerates. Never throws: the answers are already saved, and losing a
  // flag is a smaller harm than failing a save that succeeded. See flag-stale-documents.ts
  // for why this needs the service-role client and why that is safe with the id above.
  const flaggedDocumentTypes = await flagDocumentsStaleForIntakeEditSafely(
    organisationId,
    changedFields,
  )

  // Told, never acted on.
  //
  // GATED HERE, not only inside the callee. notifyOperatorOfIntakeEditSafely does return
  // immediately on an empty change list, so an unconditional call would behave correctly
  // today. It would put the first-save rule in one place on this path and another place on
  // the intake path, and leave nothing at this call site saying that a first save must not
  // notify. The `if` mirrors isIntakeAnswerEdit in actions.ts so both paths state the same
  // rule in the same shape.
  //
  // `previous` is non-null whenever changedFields is non-empty: changedBuyerProfileFields
  // returns [] for a null previous, which is exactly how a first save is told from an edit.
  const changes = previous
    ? buyerProfileAnswerChanges(previous, profile, changedFields)
    : []

  if (changes.length > 0) {
    await notifyOperatorOfIntakeEditSafely({
      organisationId,
      changes,
      flaggedDocumentTypes,
    })
  }

  return { success: true }
}
