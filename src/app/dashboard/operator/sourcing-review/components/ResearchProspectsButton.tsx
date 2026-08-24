'use client'

import { useState } from 'react'

interface ResearchProspectsButtonProps {
  organisationId: string
  /** Prospects in this organisation that have never produced a research result. */
  unresearchedCount: number
}

type Status = 'idle' | 'researching' | 'success' | 'error' | 'queued'

interface ResearchResult {
  total: number
  completed: number
  failed: number
  skipped: number
  use_stored_findings: boolean
  bridge_frame_collisions: number
  question_collisions: number
  distinct_questions: number
}

export function ResearchProspectsButton({ organisationId, unresearchedCount }: ResearchProspectsButtonProps) {
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ResearchResult | null>(null)
  const [queuedMessage, setQueuedMessage] = useState<string | null>(null)

  async function handleResearch() {
    setStatus('researching')
    setError(null)
    setResult(null)
    setQueuedMessage(null)

    try {
      const res = await fetch(`/api/operator/organisations/${organisationId}/research-prospects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Only ever 'unresearched' from here. Re-running finished copy overwrites the
        // opening that was written for a prospect, or clears it when the judge holds, so
        // the dashboard has no control that asks for it.
        body: JSON.stringify({ scope: 'unresearched', use_stored_findings: true }),
      })

      const data = await res.json()

      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Research failed')
      }

      // ── QUEUED PATH ────────────────────────────────────────────────────────
      //
      // Nothing has been researched when this response arrives; the worker picks the jobs
      // up within a minute and runs ten at a time. The inline success view renders
      // completed, failed and collision counts, none of which exist yet on this path, so
      // rendering it would show zeros that look like a batch that did nothing.
      if (data.queued) {
        setQueuedMessage(data.result?.message ?? 'Prospects queued for research.')
        setStatus('queued')
        return
      }

      setResult(data.result as ResearchResult)
      setStatus('success')
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Unknown error')
    }
  }

  if (status === 'researching') {
    return (
      <div className="flex items-center gap-2">
        <button
          disabled
          className="text-sm font-medium px-3 py-1.5 rounded-[6px] bg-[#1C3A2A] text-white opacity-75 cursor-not-allowed"
        >
          Researching...
        </button>
        <span className="text-xs text-text-secondary">
          Up to a few minutes. Leave this tab open.
        </span>
      </div>
    )
  }

  if (status === 'queued') {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={handleResearch}
          className="text-sm font-medium px-3 py-1.5 rounded-[6px] bg-white text-[#1C3A2A] border border-[#BDDAB0] hover:bg-[#EBF5E6] transition-colors"
        >
          Queue more
        </button>
        <span className="text-xs text-[#3B6D11]">
          {queuedMessage} You can close this tab.
        </span>
      </div>
    )
  }

  if (status === 'success' && result) {
    const hasIssue = result.failed > 0 || result.bridge_frame_collisions > 0 || result.question_collisions > 0
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={
              hasIssue
                ? 'text-sm font-medium px-3 py-1.5 rounded-[6px] bg-[#FEF7E6] text-[#7A4800] border border-[#F0D080]'
                : 'text-sm font-medium px-3 py-1.5 rounded-[6px] bg-[#EBF5E6] text-[#3B6D11] border border-[#BDDAB0]'
            }
          >
            {hasIssue ? '⚠' : '✓'} {result.completed} of {result.total} researched
          </span>
          <button
            onClick={() => window.location.reload()}
            className="text-xs text-text-secondary hover:text-text-primary transition-colors underline"
          >
            Refresh
          </button>
        </div>

        <div className="text-xs text-text-secondary">
          {result.failed} failed, {result.skipped} skipped, {result.distinct_questions} distinct closing questions.
          {result.use_stored_findings ? ' Findings on file were reused where available.' : ''}
        </div>

        {(result.bridge_frame_collisions > 0 || result.question_collisions > 0) && (
          <div className="px-3 py-2 rounded-[6px] bg-[#FEF7E6] border border-[#F0D080] text-xs text-[#7A4800]">
            <span className="font-medium">Uniqueness gate let a collision through.</span>{' '}
            {result.bridge_frame_collisions} repeated bridge{result.bridge_frame_collisions === 1 ? '' : 's'},{' '}
            {result.question_collisions} repeated question{result.question_collisions === 1 ? '' : 's'}. This is a
            defect in the gate, not a warning about the copy. Check the logs before sending.
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <button
        onClick={handleResearch}
        disabled={unresearchedCount === 0}
        className="text-sm font-medium px-3 py-1.5 rounded-[6px] bg-[#1C3A2A] text-white hover:bg-[#152e21] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {status === 'error'
          ? 'Retry research'
          : unresearchedCount === 0
            ? 'Nothing left to research'
            : `Research ${unresearchedCount} prospect${unresearchedCount === 1 ? '' : 's'}`}
      </button>

      {unresearchedCount > 0 && (
        <div className="text-xs text-[#7A4800] bg-[#FEF7E6] px-3 py-2 rounded-[6px] border border-[#F0D080]">
          Research calls the Anthropic API and, for a prospect with nothing on file, four data
          sources. It runs only on prospects that have never been researched.
        </div>
      )}

      {status === 'error' && error && (
        <div className="px-3 py-2 rounded-[6px] bg-[#FDEEE8] border border-[#EFBCAA] text-xs text-[#8B2020]">
          {error}
        </div>
      )}
    </div>
  )
}
