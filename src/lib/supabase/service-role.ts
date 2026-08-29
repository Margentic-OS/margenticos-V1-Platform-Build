// The service-role Supabase client, and the type that proves a client IS one.
//
// WHY THE BRAND EXISTS. On 2026-08-28 uploading prospects failed in production with
// `permission denied for table suppressed_emails`, because handleUploadLeads passed its
// SSR SESSION client to a function whose parameter was declared:
//
//   type SupabaseServiceClient = SupabaseClient<Database>
//
// That alias is structurally identical to the session client. The name asserted a
// privilege level the type did not enforce, so passing the wrong client compiled clean and
// failed only at runtime, against the database, in production. It was the FOURTH
// recurrence of that fault class in this codebase.
//
// A `unique symbol` brand makes the two types incompatible. A session client is now a
// COMPILE ERROR wherever a service-role client is required, which is what the naming
// convention was pretending to do all along.
//
// The brand is phantom: it exists only in the type system and no such property is ever
// created at runtime. Nothing reads it, nothing serialises it, and it costs nothing.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

declare const SERVICE_ROLE_BRAND: unique symbol

/**
 * A Supabase client built with SUPABASE_SERVICE_ROLE_KEY.
 *
 * Obtain one from createServiceRoleClient(), or from asServiceRoleClient() at a site that
 * builds its own with the service-role key. There is deliberately no other way to make one.
 */
export type ServiceRoleClient = SupabaseClient<Database> & {
  readonly [SERVICE_ROLE_BRAND]: true
}

/**
 * The single assertion boundary for the brand.
 *
 * A brand needs exactly one place where an unbranded client becomes a branded one, and
 * that place has to be an assertion because no runtime check can inspect the key inside a
 * constructed client. The value of naming it is that every such assertion is GREPPABLE and
 * has to be written deliberately, where the old alias made the same mistake invisible.
 *
 * ONLY call this on the same expression that passes SUPABASE_SERVICE_ROLE_KEY. Calling it
 * on a session client restores exactly the bug the brand exists to prevent, and the
 * function name is chosen so that doing so is obvious in review.
 */
export function asServiceRoleClient(client: SupabaseClient<Database>): ServiceRoleClient {
  return client as ServiceRoleClient
}

export async function createServiceRoleClient(): Promise<ServiceRoleClient> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY environment variable not set')
  }

  return asServiceRoleClient(
    createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          persistSession: false,
        },
      }
    )
  )
}
