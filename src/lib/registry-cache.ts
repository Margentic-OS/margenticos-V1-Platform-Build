// Registry cache — in-memory cache for integrations_registry rows.
// Avoids a live DB round-trip on every executeCapability() call.
// TTL: 5 minutes. Invalidated explicitly when a registry row is updated.
// Uses the service role key to bypass RLS — this is intentional because
// the cache runs at the application layer, not in a user request context.

import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import type { Capability } from '@/lib/handlers/capability'

export type RegistryRow = {
  id: string
  tool_name: string
  capability: string
  is_active: boolean
  api_handler_ref: string
  connection_status: 'connected' | 'disconnected' | 'error'
  config: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

const CACHE_TTL_MS = 5 * 60 * 1000

// Required capabilities that must be active at startup.
const REQUIRED_CAPABILITIES: Capability[] = [
  'can_send_email',
  'can_send_linkedin_dm',
  'can_enrich_contact',
]

type Cache = {
  rows: RegistryRow[]
  loadedAt: number
}

let cache: Cache | null = null

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error(
      'Registry cache: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.'
    )
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  })
}

async function loadRegistry(): Promise<RegistryRow[]> {
  const client = getServiceClient()

  const { data, error } = await client
    .from('integrations_registry')
    .select('*')
    .eq('is_active', true)

  if (error) {
    throw new Error(`Registry cache: failed to load integrations_registry — ${error.message}`)
  }

  return (data ?? []) as RegistryRow[]
}

// Returns all active registry rows, loading from DB if the cache is empty or expired.
export async function getRegistry(): Promise<RegistryRow[]> {
  const now = Date.now()

  if (cache && now - cache.loadedAt < CACHE_TTL_MS) {
    return cache.rows
  }

  logger.debug('registry-cache: loading integrations_registry from database')
  const rows = await loadRegistry()

  cache = { rows, loadedAt: now }
  logger.debug('registry-cache: loaded', { count: rows.length })

  return rows
}

// Returns the active registry row for a specific capability, or null if not found.
export async function getCapabilityRow(capability: Capability): Promise<RegistryRow | null> {
  const rows = await getRegistry()
  return rows.find(r => r.capability === capability) ?? null
}

// Clears the cache. Call this after any update to the integrations_registry table
// so the next executeCapability() call reflects the change immediately.
export function invalidateRegistry(): void {
  cache = null
  logger.info('registry-cache: cache invalidated')
}

// Logs the active capabilities and warns on any required ones that are missing or inactive.
// Call this at application startup to catch misconfiguration before it breaks a live campaign.
export async function logRegistryHealth(): Promise<void> {
  let rows: RegistryRow[]

  try {
    rows = await getRegistry()
  } catch (err) {
    logger.error('registry-cache: health check failed — could not load registry', {
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  if (rows.length === 0) {
    logger.warn('registry-cache: integrations_registry is empty — no capabilities are active')
  } else {
    for (const row of rows) {
      logger.info('registry-cache: active capability', {
        capability: row.capability,
        tool: row.tool_name,
        connection_status: row.connection_status,
      })
    }
  }

  const activeCapabilities = new Set(rows.map(r => r.capability))

  for (const required of REQUIRED_CAPABILITIES) {
    if (!activeCapabilities.has(required)) {
      logger.warn('registry-cache: required capability is not active', {
        capability: required,
        impact: 'Agent calls to this capability will fail until a handler is registered',
      })
    }
  }
}
