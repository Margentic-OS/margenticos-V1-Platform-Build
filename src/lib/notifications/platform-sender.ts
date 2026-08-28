import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

// Who a platform email is FROM, resolved rather than hardcoded.
//
// The version_pending notification signed off as "<client company> Team", which reads as
// the client's own team writing to the client. These emails come from the operator, and the
// operator is a person.
//
// The name is read from the OPERATOR's organisation record, the same
// organisations.founder_first_name field that signs generated outbound copy for a client.
// Resolving via the operator user rather than by slug or id keeps CLAUDE.md's rule that no
// organisation id is hardcoded in application code, and it stays correct if the platform
// organisation is ever renamed or recreated.

export interface PlatformSender {
  firstName: string
  companyName: string
}

const FALLBACK: PlatformSender = { firstName: 'MargenticOS', companyName: 'MargenticOS' }

export async function resolvePlatformSender(
  supabase: SupabaseClient,
): Promise<PlatformSender> {
  const { data, error } = await supabase
    .from('users')
    .select('organisations(name, founder_first_name)')
    .eq('role', 'operator')
    .limit(1)
    .single()

  const org = Array.isArray(data?.organisations) ? data?.organisations[0] : data?.organisations
  const firstName = org?.founder_first_name?.trim()
  const companyName = org?.name?.trim()

  if (error || !firstName || !companyName) {
    // Deliberately NOT fatal. A notification that cannot resolve a sign-off is still worth
    // sending, and notifyAfterPromotion must never fail the promotion it follows. Loud in
    // the log rather than silent, because the fallback signs as a company and the whole
    // point of the change was that a person signs it.
    logger.warn('resolvePlatformSender: falling back to the platform name', {
      error: error?.message ?? 'operator organisation has no founder_first_name or name',
    })
    return FALLBACK
  }

  return { firstName, companyName }
}
