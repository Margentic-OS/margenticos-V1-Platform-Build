// Resolves the Instantly API key from integration_credentials.
// Current model (Phase 1): one global key for all organisations (organisation_id IS NULL).
// The organisationId parameter is accepted for forward-compatibility with per-org keys;
// the lookup currently ignores it and falls back to the global row.
// When per-org keys are supported: query for organisation_id = organisationId first,
// fall back to the NULL global row on miss.

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

export async function getInstantlyApiKey(_organisationId: string): Promise<string> {
  // Test/CI override — bypasses DB lookup when key is provided directly.
  if (process.env.INSTANTLY_API_KEY_OVERRIDE) return process.env.INSTANTLY_API_KEY_OVERRIDE

  const supabase = createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const { data: credential, error } = await supabase
    .from('integration_credentials')
    .select('value')
    .is('organisation_id', null)
    .eq('source', 'instantly')
    .eq('credential_type', 'api_key')
    .maybeSingle()

  if (error || !credential) {
    throw new Error(
      'Instantly API key not configured — ' +
      "INSERT INTO integration_credentials (organisation_id, source, credential_type, value) " +
      "VALUES (NULL, 'instantly', 'api_key', '<key>')"
    )
  }

  return credential.value
}

// Reads the instantly_api_active feature flag from integrations_registry.
// Returns false if the row is missing or unreadable — fail-safe toward mock mode.
export async function getInstantlyApiActive(): Promise<boolean> {
  // Test/CI override — bypasses DB lookup when flag is provided directly.
  if (process.env.INSTANTLY_API_ACTIVE !== undefined) {
    return process.env.INSTANTLY_API_ACTIVE === 'true'
  }

  const supabase = createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const { data } = await supabase
    .from('integrations_registry')
    .select('is_active')
    .eq('capability', 'instantly_api_active')
    .eq('tool_name', 'instantly')
    .maybeSingle()

  return data?.is_active ?? false
}
