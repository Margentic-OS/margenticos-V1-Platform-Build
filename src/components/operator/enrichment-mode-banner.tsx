'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

/**
 * Enrichment Mode Banner
 * Reads the SAME enrichment_live flag from integrations_registry.config that controls
 * actual enrichment behavior. This ensures the banner can never drift from reality.
 *
 * Data source: integrations_registry.config.enrichment_live (boolean)
 * - true: Live Apollo API enrichment active (consumes credits)
 * - false: Test-mode mock enrichment active (safe, no credits)
 */
export function EnrichmentModeBanner() {
  const [isLive, setIsLive] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const checkMode = async () => {
      try {
        const supabase = createClient<Database>(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        )

        const { data, error } = await supabase
          .from('integrations_registry')
          .select('config')
          .eq('capability', 'can_enrich_contact')
          .is('archived_at', null)
          .single()

        if (error || !data) {
          setIsLive(false) // Default to safe mode
        } else {
          setIsLive((data as any).config?.enrichment_live === true)
        }
      } catch {
        setIsLive(false) // Default to safe mode on error
      } finally {
        setLoading(false)
      }
    }

    checkMode()
  }, [])

  if (loading) {
    return null
  }

  if (isLive) {
    return (
      <div className="bg-red-50 border-l-4 border-red-500 p-4 mb-4">
        <div className="flex items-start">
          <div className="flex-shrink-0">
            <span className="text-red-600 text-lg font-bold">⚠️</span>
          </div>
          <div className="ml-3">
            <p className="text-sm font-medium text-red-800">
              <strong>Live Enrichment Active</strong>
            </p>
            <p className="text-sm text-red-700 mt-1">
              Apollo API enrichment is LIVE. Incoming enrichment runs will consume Apollo credits (~1 per prospect).
              Test data will NOT be used.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-blue-50 border-l-4 border-blue-500 p-4 mb-4">
      <div className="flex items-start">
        <div className="flex-shrink-0">
          <span className="text-blue-600 text-lg font-bold">ℹ️</span>
        </div>
        <div className="ml-3">
          <p className="text-sm font-medium text-blue-800">
            <strong>Test Mode Active</strong>
          </p>
          <p className="text-sm text-blue-700 mt-1">
            Enrichment is in test mode. Incoming enrichment runs will use mock data (.mock.invalid emails, ICP-plausible
            headcount, canonical industries). No Apollo credits consumed.
          </p>
        </div>
      </div>
    </div>
  )
}
