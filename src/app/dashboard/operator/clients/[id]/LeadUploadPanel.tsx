'use client'

import { useState, useTransition } from 'react'
import { handleUploadLeads } from './actions'
import type { UploadLeadsResult } from './actions'

interface Props {
  orgId: string
  instantlyApiActive: boolean
  pendingCount: number
}

type PanelState =
  | { phase: 'idle' }
  | { phase: 'uploading' }
  | { phase: 'success'; result: Extract<UploadLeadsResult, { ok: true }> }
  | { phase: 'error'; message: string }

export function LeadUploadPanel({ orgId, instantlyApiActive, pendingCount }: Props) {
  const [state, setState] = useState<PanelState>({ phase: 'idle' })
  const [isPending, startTransition] = useTransition()

  const isWorking = isPending || state.phase === 'uploading'

  function handleUpload() {
    setState({ phase: 'uploading' })
    startTransition(async () => {
      const result = await handleUploadLeads(orgId)
      if (result.ok) {
        setState({ phase: 'success', result })
      } else {
        setState({ phase: 'error', message: result.error })
      }
    })
  }

  function handleReset() {
    setState({ phase: 'idle' })
  }

  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] overflow-hidden">
      <div className="px-5 py-4 border-b border-border-card">
        <h2 className="text-[13px] font-semibold text-text-primary">Lead upload</h2>
        <p className="text-[11px] text-text-secondary mt-0.5">
          Upload pending prospects to the Instantly campaign assigned to each lead.
        </p>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Mock-mode banner */}
        {!instantlyApiActive && (
          <div className="bg-[#FEFCE8] border border-[#FDE68A] rounded-[8px] px-4 py-3">
            <p className="text-[12px] font-medium text-[#92400E]">Mock mode active</p>
            <p className="text-[11px] text-[#92400E] mt-0.5">
              instantly_api_active is false. Calls go to the mock server, not production Instantly.
              Flip the flag in integrations_registry to enable real uploads.
            </p>
          </div>
        )}

        {/* Pending count */}
        {state.phase === 'idle' && (
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-text-secondary">Pending leads ready to upload:</span>
            <span className="text-[12px] font-semibold text-text-primary">{pendingCount}</span>
          </div>
        )}

        {/* Success state */}
        {state.phase === 'success' && (
          <div className="space-y-3">
            <div className="bg-[#EBF5E6] border border-[#BDDAB0] rounded-[8px] px-4 py-3 space-y-1.5">
              <p className="text-[12px] font-medium text-brand-green-success">Upload complete</p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-0.5">
                <StatRow label="Attempted" value={state.result.total_attempted} />
                <StatRow label="Created" value={state.result.created} />
                <StatRow label="Duplicated" value={state.result.duplicated} />
                <StatRow label="Blocklisted" value={state.result.in_blocklist} />
                <StatRow label="Invalid email" value={state.result.invalid} />
                <StatRow label="Incomplete" value={state.result.incomplete} />
              </div>
            </div>
            <button
              onClick={handleReset}
              className="text-[11px] text-text-secondary hover:text-text-primary transition-colors"
            >
              Upload again
            </button>
          </div>
        )}

        {/* Error state */}
        {state.phase === 'error' && (
          <div className="space-y-3">
            <div className="bg-[#FDF0F0] border border-[#E8B4B4] rounded-[8px] px-4 py-3">
              <p className="text-[12px] text-[#8B2020]">{state.message}</p>
            </div>
            <button
              onClick={handleReset}
              className="text-[11px] text-text-secondary hover:text-text-primary transition-colors"
            >
              Try again
            </button>
          </div>
        )}

        {/* Upload button */}
        {(state.phase === 'idle' || state.phase === 'uploading') && (
          <div className="flex items-center gap-3">
            <button
              onClick={handleUpload}
              disabled={isWorking || pendingCount === 0}
              className="px-4 py-2 bg-brand-green-operator text-white rounded-[6px] text-[12px] font-medium hover:bg-brand-green-operator/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {pendingCount === 0
                ? 'No pending leads'
                : `Upload ${pendingCount} pending lead${pendingCount === 1 ? '' : 's'}`}
            </button>
            {isWorking && (
              <p className="text-[11px] text-text-secondary">Uploading to Instantly…</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function StatRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-[0.07em] text-text-secondary">{label}</span>
      <span className="text-[11px] text-text-primary font-medium">{value}</span>
    </div>
  )
}
