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
 * Sets or clears organisations.booking_url for one client.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE COLUMN ALREADY EXISTED. THIS IS THE FIRST WRITE PATH TO IT.
 *
 * `booking_url` has been on the organisation record since the reply-handling migration
 * and is read live by process-reply.ts, which puts it in the reply a prospect receives.
 * Until now nothing could set it outside SQL, and it was NULL on both live client
 * organisations while the Settings page displayed an invented link that belonged to
 * nobody.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * VALIDATED AS A URL, NEVER AS A VENDOR
 *
 * This deliberately does NOT require any particular booking tool's address, and must not
 * be changed to. Sending prospects to a booking link is tool-agnostic: any link works.
 * Only booking DETECTION depends on the tool (Cal.com since 2026-09-11, ADR-056), and
 * detection is the webhook's business, not this field's. Matching on a hostname here
 * would put a vendor name in the application layer, which is Rule Zero, and would refuse a
 * client who books through a tool we do not detect, which is the case manual meeting
 * recording exists for.
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
    .update({ booking_url: stored })
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

/**
 * Switches the ICP revenue band on or off as a sourcing filter, for one client.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * OFF UNLESS AN OPERATOR TURNS IT ON
 *
 * MEASURED 2026-09-10: the sourcing provider's revenue filter excludes every company it holds
 * no revenue figure for, and no request shape keeps them. On one live client's search that was
 * 78% of everyone it could reach, so applying a band by default would delete most of a
 * client's audience for missing data rather than for being the wrong size. The band is
 * therefore applied only to a client who has been opted in, here.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT TAKES EFFECT AT THE NEXT ICP APPROVAL
 *
 * The spec is built from this switch when the ICP is approved, so the stored spec always
 * describes the search it produces. Flipping it does not rewrite a stored spec, and the page
 * says so beside the control.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A BOOLEAN IS VALIDATED AS A BOOLEAN
 *
 * A caller posting the string "false" would otherwise be truthy and switch a client ON while
 * the operator meant off, which is the one direction this setting must never fail in.
 */
export async function updateRevenueFilterEnabled(
  orgId: string,
  enabled: boolean,
): Promise<{ error?: string; value?: boolean }> {
  if (typeof enabled !== 'boolean') {
    return { error: 'The revenue filter can only be switched on or off.' }
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

  // The session client, matching updateBookingUrl: operators_full_access_organisations is an
  // ALL policy gated by is_operator(), and clients have no UPDATE policy on organisations, so
  // RLS is a real second layer and a client cannot switch this on for themselves.
  const { error } = await supabase
    .from('organisations')
    .update({ sourcing_revenue_filter_enabled: enabled })
    .eq('id', orgId)

  if (error) return { error: error.message }

  logger.info('operator: revenue filter opt-in changed', {
    organisation_id: orgId,
    enabled,
  })

  revalidatePath('/dashboard/operator/settings')

  return { value: enabled }
}
