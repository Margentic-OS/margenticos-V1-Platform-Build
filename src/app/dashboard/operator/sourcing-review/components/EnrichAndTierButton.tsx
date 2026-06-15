'use client'

import { useState } from 'react'

interface EnrichAndTierButtonProps {
  organisationId: string
}

type Status = 'idle' | 'enriching' | 'tiering' | 'success' | 'error'

export function EnrichAndTierButton({ organisationId }: EnrichAndTierButtonProps) {
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [enrichResult, setEnrichResult] = useState<{ enriched: number; credits: number } | null>(null)

  const handleEnrichAndTier = async () => {
    setStatus('enriching')
    setError(null)
    setEnrichResult(null)

    try {
      // Step 1: Enrich approved prospects
      const enrichRes = await fetch(
        `/api/operator/organisations/${organisationId}/enrich-approved-batch`,
        { method: 'POST' }
      )

      if (!enrichRes.ok) {
        const data = await enrichRes.json()
        throw new Error(data.error || 'Enrichment failed')
      }

      const enrichData = await enrichRes.json()

      if (!enrichData.ok) {
        throw new Error(enrichData.result?.error || 'Enrichment failed')
      }

      setEnrichResult({
        enriched: enrichData.result.enriched,
        credits: enrichData.result.credits_consumed,
      })

      // Step 2: If enrichment succeeded, trigger tiering
      setStatus('tiering')

      const tierRes = await fetch(
        `/api/operator/organisations/${organisationId}/tier-enriched-batch`,
        { method: 'POST' }
      )

      if (!tierRes.ok) {
        const data = await tierRes.json()
        throw new Error(data.error || 'Tiering failed')
      }

      const tierData = await tierRes.json()

      if (!tierData.ok) {
        throw new Error(tierData.result?.error || 'Tiering failed')
      }

      setStatus('success')

      // Refresh the page after a brief delay
      setTimeout(() => {
        window.location.reload()
      }, 1500)
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Unknown error')
    }
  }

  if (status === 'idle') {
    return (
      <button
        onClick={handleEnrichAndTier}
        className="text-sm font-medium px-3 py-1.5 rounded-[6px] bg-[#1C3A2A] text-white hover:bg-[#152e21] transition-colors"
      >
        Enrich and tier batch
      </button>
    )
  }

  if (status === 'enriching') {
    return (
      <button
        disabled
        className="text-sm font-medium px-3 py-1.5 rounded-[6px] bg-[#1C3A2A] text-white opacity-75 cursor-not-allowed"
      >
        Enriching...
      </button>
    )
  }

  if (status === 'tiering') {
    return (
      <button
        disabled
        className="text-sm font-medium px-3 py-1.5 rounded-[6px] bg-[#1C3A2A] text-white opacity-75 cursor-not-allowed"
      >
        Tiering...
      </button>
    )
  }

  if (status === 'success') {
    return (
      <button
        disabled
        className="text-sm font-medium px-3 py-1.5 rounded-[6px] bg-[#EBF5E6] text-[#3B6D11] border border-[#BDDAB0] cursor-default"
      >
        ✓ Complete
      </button>
    )
  }

  return (
    <div className="flex gap-2">
      <button
        onClick={handleEnrichAndTier}
        className="text-sm font-medium px-3 py-1.5 rounded-[6px] bg-[#1C3A2A] text-white hover:bg-[#152e21] transition-colors"
      >
        Retry
      </button>
      <div className="px-3 py-1.5 rounded-[6px] bg-[#FDEEE8] border border-[#EFBCAA] text-xs text-[#8B2020]">
        {error}
      </div>
    </div>
  )
}
