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

import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { logger } from '@/lib/logger'

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
