import type { ServiceRoleClient } from '@/lib/supabase/service-role'
/**
 * Enrichment mode gating: test vs. live Apollo.
 *
 * Mode is controlled by explicit DB config flag, NOT by environment variable presence/absence.
 * This ensures:
 * - Mode is testable and auditable
 * - UI banner reading the same flag can never be out of sync
 * - No confusion from implicit env-based inference
 *
 * Flag location: integrations_registry.config.enrichment_live (boolean)
 * - enrichment_live=false: use mock test-mode enrichment (safe, no credits)
 * - enrichment_live=true: use real Apollo API (live, consumes credits)
 * Default: false (safe mode)
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { logger } from '@/lib/logger'

/**
 * A client that can READ integrations_registry, branded or not.
 *
 * Deliberately not ServiceRoleClient. resolveEnrichmentMode is called from the operator
 * layout with the operator's own session client so the read stays behind RLS
 * (operators_full_access_integrations). Requiring the service-role brand here would push
 * a UI read onto a client that bypasses RLS, which is the wrong direction for a banner.
 */
type RegistryReadClient = SupabaseClient<Database>

type SupabaseServiceClient = ServiceRoleClient

/**
 * Determine if enrichment should use mock test mode or live Apollo API.
 * Reads explicit flag from integrations_registry config.
 *
 * @param supabase - Supabase service client
 * @returns true if mock test mode, false if live Apollo API
 */
export async function shouldUseMockEnrichment(
  supabase: SupabaseServiceClient,
  organisationId: string,
): Promise<boolean> {
  try {
    const { data: registry, error } = await (supabase as any)
      .from('integrations_registry')
      .select('config')
      .eq('capability', 'can_enrich_contact')
      .single()

    if (error) {
      logger.warn('enrichment-mode: failed to read enrichment_live flag, defaulting to mock', {
        organisation_id: organisationId,
        error: error.message,
      })
      return true // Safe default: use mock mode
    }

    // Flag exists in config; check its value
    // If enrichment_live=true, return false (don't use mock)
    // If enrichment_live=false or missing, return true (use mock)
    const enrichmentLive = (registry as any)?.config?.enrichment_live === true
    const useMock = !enrichmentLive

    logger.info('enrichment-mode: determined', {
      organisation_id: organisationId,
      enrichment_live: enrichmentLive,
      use_mock: useMock,
    })

    return useMock
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('enrichment-mode: exception reading flag, defaulting to mock', {
      organisation_id: organisationId,
      error: msg,
    })
    return true // Safe default
  }
}

/**
 * Get enrichment_live flag for UI banner.
 * UI reads the SAME flag so banner state cannot diverge from actual behavior.
 */
export async function getEnrichmentLiveFlag(
  supabase: SupabaseServiceClient,
): Promise<boolean> {
  try {
    const { data: registry, error } = await (supabase as any)
      .from('integrations_registry')
      .select('config')
      .eq('capability', 'can_enrich_contact')
      .single()

    if (error) {
      return false // Default: flag is off (mock mode)
    }

    return (registry as any)?.config?.enrichment_live === true
  } catch {
    return false // Default: flag is off (mock mode)
  }
}

/**
 * Set enrichment_live flag (operator-only action).
 * Used when flipping from test to live or back.
 */
export async function setEnrichmentLiveFlag(
  supabase: SupabaseServiceClient,
  value: boolean,
): Promise<void> {
  const { error } = await (supabase as any)
    .from('integrations_registry')
    .update({
      config: { enrichment_live: value },
    })
    .eq('capability', 'can_enrich_contact')

  if (error) {
    throw new Error(`Failed to set enrichment_live flag: ${error.message}`)
  }

  logger.info('enrichment-mode: flag updated', {
    enrichment_live: value,
  })
}

/**
 * The three states the enrichment banner can be in.
 *
 * 'unknown' exists because the previous banner had no way to say "I could not find
 * out". A failed read fell into the same branch as a successful read of a disabled
 * flag, so both rendered "Test Mode Active". The banner spent its life reporting the
 * safe state while the flag was actually live, and nothing looked wrong.
 *
 * An unknown mode is NOT safe. Enrichment may well be live and spending Apollo
 * credits. It is rendered as a warning, never as reassurance.
 */
export type EnrichmentMode = 'live' | 'test' | 'unknown'

/**
 * Resolve the enrichment mode for the operator banner.
 *
 * Reads the SAME row and the SAME flag as shouldUseMockEnrichment, which is what
 * actually gates Apollo spend, so the banner cannot drift from behaviour. The filter
 * is `capability = 'can_enrich_contact'` and nothing else. It previously also filtered
 * `archived_at IS NULL`, a column integrations_registry does not have, so every read
 * failed with 42703 and was swallowed.
 *
 * Must be called with a client that can actually read integrations_registry: an
 * operator session client (RLS policy operators_full_access_integrations) or the
 * service client. The anon key returns zero rows and yields 'unknown'.
 */
export async function resolveEnrichmentMode(
  supabase: RegistryReadClient,
): Promise<EnrichmentMode> {
  try {
    const { data, error } = await (supabase as any)
      .from('integrations_registry')
      .select('config')
      .eq('capability', 'can_enrich_contact')
      .maybeSingle()

    if (error) {
      logger.error('enrichment-mode: banner could not read the flag', {
        error: error.message,
      })
      return 'unknown'
    }

    if (!data) {
      logger.error('enrichment-mode: no can_enrich_contact row in integrations_registry')
      return 'unknown'
    }

    return (data as { config?: { enrichment_live?: boolean } })?.config?.enrichment_live === true
      ? 'live'
      : 'test'
  } catch (err) {
    logger.error('enrichment-mode: exception resolving banner mode', {
      error: err instanceof Error ? err.message : String(err),
    })
    return 'unknown'
  }
}
