'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { logger } from '@/lib/logger'

// Generous. A booking link is a vendor-generated URL and some carry long path segments and
// query strings. The cap exists to refuse a paste of something that is not a URL at all,
// not to police length.
const MAX_BOOKING_URL_LENGTH = 500

/**
 * Sets or clears organisations.calendly_url for one client.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE COLUMN ALREADY EXISTED. THIS IS THE FIRST WRITE PATH TO IT.
 *
 * `calendly_url` has been on the organisation record since the reply-handling migration
 * and is read live by process-reply.ts, which puts it in the reply a prospect receives.
 * Until now nothing could set it outside SQL, and it was NULL on both live client
 * organisations while the Settings page displayed an invented link that belonged to
 * nobody.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * VALIDATED AS A URL, NEVER AS A VENDOR
 *
 * This deliberately does NOT require a Calendly address, and must not be changed to.
 * The locked decision of 2026-07-28 has two halves and only one of them is about Calendly:
 *
 *   "Sending prospects to a booking link is tool-agnostic and already open. Any link
 *    works." — and a client on another tool "uses their own connected instance of it".
 *
 * Only booking DETECTION is Calendly-specific, and detection is the webhook's business,
 * not this field's. Matching on a hostname here would put a vendor name in the application
 * layer, which is Rule Zero, and would refuse the exact case the decision anticipates.
 *
 * https is required because the link is sent to prospects. http would be downgraded or
 * warned about by their mail client, on a link whose whole job is to be clicked.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * CLEARING IS ALLOWED, AND IS NOT THE SAME AS FAILING TO SET
 *
 * An empty submission writes NULL rather than an empty string. NULL is what "no booking
 * link" already means everywhere else that reads this column, and an empty string would
 * pass a truthiness check in process-reply.ts and put a blank link in a prospect's reply.
 */
export async function updateBookingUrl(
  orgId: string,
  bookingUrl: string,
): Promise<{ error?: string; value?: string | null }> {
  const trimmed = bookingUrl.trim()

  if (trimmed.length > MAX_BOOKING_URL_LENGTH) {
    return { error: `Booking link must be ${MAX_BOOKING_URL_LENGTH} characters or fewer.` }
  }

  let stored: string | null = null

  if (trimmed) {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return {
        error:
          'That is not a valid web address. Paste the whole link, including https:// at the front.',
      }
    }

    if (parsed.protocol !== 'https:') {
      return {
        error:
          'The booking link must start with https://. This link is sent to prospects, and ' +
          'their mail client will warn on or downgrade an insecure one.',
      }
    }

    stored = parsed.toString()
  }

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  // The session client, not the service client, matching updateOrganisationName. The
  // operators_full_access_organisations policy is an ALL policy on authenticated gated by
  // is_operator(), so RLS is a real second layer here and there is no reason to step
  // around it.
  const { error } = await supabase
    .from('organisations')
    .update({ calendly_url: stored })
    .eq('id', orgId)

  if (error) return { error: error.message }

  // The organisation id is logged, the URL is not. A booking link is a client's own
  // address and belongs in their record rather than in a log line, matching the same
  // decision made for the company name.
  logger.info('operator: booking link updated', {
    organisation_id: orgId,
    cleared: stored === null,
  })

  revalidatePath('/dashboard/operator/settings')

  return { value: stored }
}
