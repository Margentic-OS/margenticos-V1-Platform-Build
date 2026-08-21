'use client'

import { useState } from 'react'

interface SourceProspectsButtonProps {
  organisationId: string
  /** Ceiling the entry point enforces. Shown so the operator sees it before typing a number. */
  maxBatchSize: number
}

type Status = 'idle' | 'sourcing' | 'success' | 'error'

interface SourceResult {
  candidates_sourced: number
  candidates_qualified: number
}

const DEFAULT_BATCH_SIZE = 25

export function SourceProspectsButton({ organisationId, maxBatchSize }: SourceProspectsButtonProps) {
  const [status, setStatus] = useState<Status>('idle')
  const [batchSize, setBatchSize] = useState<string>(String(DEFAULT_BATCH_SIZE))
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SourceResult | null>(null)

  const parsed = Number(batchSize)
  const batchSizeValid = Number.isInteger(parsed) && parsed >= 1 && parsed <= maxBatchSize

  async function handleSource() {
    setStatus('sourcing')
    setError(null)
    setResult(null)

    try {
      const res = await fetch(`/api/operator/organisations/${organisationId}/source-prospects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_batch_size: parsed }),
      })

      const data = await res.json()

      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Sourcing failed')
      }

      setResult({
        candidates_sourced: data.result.candidates_sourced,
        candidates_qualified: data.result.candidates_qualified,
      })
      setStatus('success')
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Unknown error')
    }
  }

  if (status === 'sourcing') {
    return (
      <div className="flex items-center gap-2">
        <button
          disabled
          className="text-sm font-medium px-3 py-1.5 rounded-[6px] bg-[#1C3A2A] text-white opacity-75 cursor-not-allowed"
        >
          Sourcing...
        </button>
        <span className="text-xs text-text-secondary">Searching and deduping. This takes under a minute.</span>
      </div>
    )
  }

  if (status === 'success' && result) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium px-3 py-1.5 rounded-[6px] bg-[#EBF5E6] text-[#3B6D11] border border-[#BDDAB0]">
          ✓ {result.candidates_qualified} new
        </span>
        <span className="text-xs text-text-secondary">
          {result.candidates_sourced} returned, {result.candidates_sourced - result.candidates_qualified} already known
        </span>
        <button
          onClick={() => window.location.reload()}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors underline"
        >
          Refresh
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`batch-${organisationId}`} className="text-xs text-text-secondary">
          Source
        </label>
        <input
          id={`batch-${organisationId}`}
          type="number"
          min={1}
          max={maxBatchSize}
          value={batchSize}
          onChange={e => setBatchSize(e.target.value)}
          className="w-20 px-2 py-1.5 text-sm border border-border-card rounded-[6px] text-text-primary"
        />
        <button
          onClick={handleSource}
          disabled={!batchSizeValid}
          className="text-sm font-medium px-3 py-1.5 rounded-[6px] bg-[#1C3A2A] text-white hover:bg-[#152e21] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {status === 'error' ? 'Retry sourcing' : 'Source prospects'}
        </button>
        <span className="text-xs text-text-secondary">max {maxBatchSize}</span>
      </div>

      <div className="text-xs text-[#7A4800] bg-[#FEF7E6] px-3 py-2 rounded-[6px] border border-[#F0D080]">
        Sourcing spends Apollo credits. It needs an ICP that the client has approved.
      </div>

      {status === 'error' && error && (
        <div className="px-3 py-2 rounded-[6px] bg-[#FDEEE8] border border-[#EFBCAA] text-xs text-[#8B2020]">
          {error}
        </div>
      )}
    </div>
  )
}
