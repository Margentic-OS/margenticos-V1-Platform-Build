// Who is an email allowed to reach?
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
//
// Six operator templates resolve their recipient from a single environment string,
// RESEND_OPERATOR_EMAIL. agent-failure carries raw internal error text. One wrong
// character in that variable sends a client our internal errors, and nothing in the
// system would notice, because a successful Resend call looks identical either way.
//
// So the recipient is checked against the database at send time rather than trusted.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY THE DATABASE AND NOT A DOMAIN LITERAL
//
// The obvious guard is `to.endsWith('@margenticos.com')`. It is wrong twice over.
//
// It is a Rule Zero violation: a hardcoded tenant assumption in shared code. And it
// breaks for real. A client who happens to sit on the same domain as the operator
// would pass a domain check while being exactly the person who must not receive an
// operator alert. The question is never "which domain is this" but "is this address
// a client of ours", and only the database knows that.
//
// ═══════════════════════════════════════════════════════════════════════════════
// IT FAILS CLOSED ON A BROKEN LOOKUP, AND OPEN ON AN ABSENT ONE
//
// Two different situations, and collapsing them was wrong:
//
//   Credentials present, query FAILS   -> REFUSE. Something is wrong with a database we
//                                         are supposed to be able to reach, and sending
//                                         to an address nobody verified is the exact
//                                         failure this module exists to prevent.
//
//   Credentials ABSENT                 -> allow, and log loudly. This is a unit test or
//                                         an unconfigured environment, not an outage.
//                                         recordEmailDeliveryFailure in this same
//                                         directory already draws the identical line and
//                                         says so: "No credentials means unit tests, or a
//                                         misconfigured environment."
//
// The trade-off in the second case, stated plainly: a production missing
// SUPABASE_SERVICE_ROLE_KEY would send an operator alert unverified. That production
// cannot read its own client list, cannot record a delivery failure, and cannot serve a
// dashboard, so the guard is not what is protecting anybody at that point. Turning a
// missing environment variable into a total operator-alert blackout costs more than it
// buys. The first case is where the real risk lives and it still refuses.

import { logger } from '@/lib/logger'
import { createServiceRoleClient } from '@/lib/supabase/service-role'

// EmailAudience lives in send.ts and means 'operator' | 'customer'. This module does NOT
// define its own: the flag that relaxes content rules is the same flag that tightens the
// recipient, deliberately, so the two cannot drift into disagreeing about what internal
// means.
export type RecipientVerdict =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * Returns the lowercased email address of every user whose role is 'client'.
 *
 * Injectable so the guard can be tested without a database. The default reads live.
 */
export type ClientAddressReader = () => Promise<{
  addresses: string[]
  failed: boolean
  /** True when there is no database to ask, as opposed to a database that would not answer. */
  credentialsMissing?: boolean
}>

const defaultClientAddressReader: ClientAddressReader = async () => {
  // Checked BEFORE constructing a client, so an unconfigured environment costs nothing
  // and does not sit waiting on a connection that cannot be made.
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { addresses: [], failed: false, credentialsMissing: true }
  }

  try {
    const supabase = await createServiceRoleClient()

    // Reads every client user's address on each operator send. Deliberate at this
    // scale: the table holds single figures today and an operator alert is not a hot
    // path. Comparing in code rather than with .eq() keeps the match exact regardless
    // of how the address was cased on the way in. Revisit if client users pass ~1000.
    const { data, error } = await supabase
      .from('users')
      .select('email')
      .eq('role', 'client')

    if (error) {
      logger.error('recipient-audience: could not read client addresses', { error: error.message })
      return { addresses: [], failed: true }
    }

    const addresses = (data ?? [])
      .map(row => (row as { email: string | null }).email)
      .filter((e): e is string => typeof e === 'string' && e.length > 0)
      .map(e => e.trim().toLowerCase())

    return { addresses, failed: false }
  } catch (err) {
    logger.error('recipient-audience: client address lookup threw', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { addresses: [], failed: true }
  }
}

/**
 * Refuses an operator-audience send whose recipient belongs to a client user.
 *
 * `to` is the address the message will ACTUALLY be sent to, after any override has
 * been applied. Checking the address we intended rather than the address we will use
 * would leave the override path unguarded, which is the hole this pairs with.
 */
export async function assertOperatorRecipient(
  to: string,
  readClientAddresses: ClientAddressReader = defaultClientAddressReader,
): Promise<RecipientVerdict> {
  const normalised = to.trim().toLowerCase()

  if (!normalised) {
    return { ok: false, reason: 'operator recipient is empty' }
  }

  const { addresses, failed, credentialsMissing } = await readClientAddresses()

  if (credentialsMissing) {
    logger.error(
      'recipient-audience: no database credentials, operator recipient NOT verified',
      { recipient_domain: normalised.split('@')[1] ?? 'unknown' },
    )
    return { ok: true }
  }

  if (failed) {
    // See the header: closed, not open.
    return {
      ok: false,
      reason:
        'could not verify the recipient against the client list, so the send was refused. ' +
        'This fails closed deliberately: an unverified operator recipient is not sent to.',
    }
  }

  if (addresses.includes(normalised)) {
    return {
      ok: false,
      reason:
        `recipient ${normalised} belongs to a CLIENT user, and this is an operator-only ` +
        'email. Check RESEND_OPERATOR_EMAIL and TEST_EMAIL_RECIPIENT.',
    }
  }

  return { ok: true }
}
