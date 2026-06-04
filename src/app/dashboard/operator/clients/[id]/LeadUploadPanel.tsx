'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { handleUploadLeads, handleSyncSequenceShell } from './actions'
import type {
  UploadLeadsResult,
  CampaignOutcome,
  BlockedSegmentReason,
  ShellBlockedReason,
  ShellSyncActionResult,
} from './actions'

interface CampaignForSync {
  internalId: string
  externalId: string
  name: string | null
  shellSyncedAt: string | null
  shellStepCount: number | null
}

interface Props {
  orgId: string
  instantlyApiActive: boolean
  pendingCount: number
  primarySegmentId: string | null
  campaigns: CampaignForSync[]
}

type UploadPanelState =
  | { phase: 'idle' }
  | { phase: 'uploading' }
  | { phase: 'success'; result: Extract<UploadLeadsResult, { ok: true }> }
  | { phase: 'error'; message: string }

type SyncState = 'idle' | 'syncing' | 'done' | 'error'

export function LeadUploadPanel({ orgId, instantlyApiActive, pendingCount, primarySegmentId, campaigns }: Props) {
  const router = useRouter()
  const [uploadState, setUploadState] = useState<UploadPanelState>({ phase: 'idle' })
  const [isPending, startTransition] = useTransition()
  const [syncStates, setSyncStates] = useState<Record<string, SyncState>>({})
  const [syncErrors, setSyncErrors] = useState<Record<string, string>>({})

  const isUploading = isPending || uploadState.phase === 'uploading'

  function handleUpload() {
    setUploadState({ phase: 'uploading' })
    startTransition(async () => {
      const result = await handleUploadLeads(orgId)
      if (result.ok) {
        setUploadState({ phase: 'success', result })
        router.refresh()
      } else {
        setUploadState({ phase: 'error', message: result.error })
      }
    })
  }

  function handleReset() {
    setUploadState({ phase: 'idle' })
  }

  function handleSync(campaignInternalId: string, segmentId: string | null) {
    setSyncStates(prev => ({ ...prev, [campaignInternalId]: 'syncing' }))
    setSyncErrors(prev => { const n = { ...prev }; delete n[campaignInternalId]; return n })

    handleSyncSequenceShell(orgId, campaignInternalId, segmentId).then((result: ShellSyncActionResult) => {
      if (result.ok) {
        setSyncStates(prev => ({ ...prev, [campaignInternalId]: 'done' }))
        router.refresh()
      } else {
        setSyncStates(prev => ({ ...prev, [campaignInternalId]: 'error' }))
        setSyncErrors(prev => ({ ...prev, [campaignInternalId]: result.error }))
      }
    })
  }

  return (
    <div className="space-y-4">
      {/* Sequence shell panel — per campaign */}
      <div className="bg-surface-card border border-border-card rounded-[10px] overflow-hidden">
        <div className="px-5 py-4 border-b border-border-card">
          <h2 className="text-[13px] font-semibold text-text-primary">Sequence shell</h2>
          <p className="text-[11px] text-text-secondary mt-0.5">
            The generic template on each campaign that holds the <code>{'{{m_*}}'}</code> variables. Must be synced before uploading leads.
          </p>
        </div>
        <div className="px-5 py-4 space-y-3">
          {campaigns.length === 0 ? (
            <p className="text-[12px] text-text-secondary">No campaigns registered for this client. Add campaigns in the client settings before syncing.</p>
          ) : (
            campaigns.map(c => (
              <ShellRow
                key={c.internalId}
                campaign={c}
                segmentId={primarySegmentId}
                syncState={syncStates[c.internalId] ?? 'idle'}
                syncError={syncErrors[c.internalId]}
                onSync={() => handleSync(c.internalId, primarySegmentId)}
              />
            ))
          )}
        </div>
      </div>

      {/* Lead upload panel */}
      <div className="bg-surface-card border border-border-card rounded-[10px] overflow-hidden">
        <div className="px-5 py-4 border-b border-border-card">
          <h2 className="text-[13px] font-semibold text-text-primary">Lead upload</h2>
          <p className="text-[11px] text-text-secondary mt-0.5">
            Compose and upload pending prospects. Sequences composed from the approved Messaging doc.
          </p>
        </div>

        <div className="px-5 py-4 space-y-4">
          {!instantlyApiActive && (
            <div className="bg-[#FEFCE8] border border-[#FDE68A] rounded-[8px] px-4 py-3">
              <p className="text-[12px] font-medium text-[#92400E]">Mock mode active</p>
              <p className="text-[11px] text-[#92400E] mt-0.5">
                Outbound provider flag is off. Calls go to the mock server, not production. Flip instantly_api_active in integrations_registry to enable real uploads.
              </p>
            </div>
          )}

          {uploadState.phase === 'idle' && (
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-text-secondary">Pending leads ready to upload:</span>
              <span className="text-[12px] font-semibold text-text-primary">{pendingCount}</span>
            </div>
          )}

          {uploadState.phase === 'success' && (
            <SuccessDisplay result={uploadState.result} onReset={handleReset} />
          )}

          {uploadState.phase === 'error' && (
            <div className="space-y-3">
              <div className="bg-[#FDF0F0] border border-[#E8B4B4] rounded-[8px] px-4 py-3">
                <p className="text-[12px] text-[#8B2020]">{uploadState.message}</p>
              </div>
              <button onClick={handleReset} className="text-[11px] text-text-secondary hover:text-text-primary transition-colors">
                Try again
              </button>
            </div>
          )}

          {(uploadState.phase === 'idle' || uploadState.phase === 'uploading') && (
            <div className="flex items-center gap-3">
              <button
                onClick={handleUpload}
                disabled={isUploading || pendingCount === 0}
                className="px-4 py-2 bg-brand-green-operator text-white rounded-[6px] text-[12px] font-medium hover:bg-brand-green-operator/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {pendingCount === 0
                  ? 'No pending leads'
                  : `Upload ${pendingCount} pending lead${pendingCount === 1 ? '' : 's'}`}
              </button>
              {isUploading && (
                <p className="text-[11px] text-text-secondary">Composing and uploading…</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ShellRow({
  campaign,
  segmentId,
  syncState,
  syncError,
  onSync,
}: {
  campaign: CampaignForSync
  segmentId: string | null
  syncState: SyncState
  syncError?: string
  onSync: () => void
}) {
  const shortId = campaign.externalId.slice(0, 8)
  const label = campaign.name ? `${campaign.name} (${shortId}…)` : `${shortId}…`
  const isSyncing = syncState === 'syncing'

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[12px] font-medium text-text-primary truncate">{label}</p>
        {syncState === 'error' && syncError ? (
          <p className="text-[11px] text-[#8B2020] mt-0.5">{syncError}</p>
        ) : campaign.shellSyncedAt ? (
          <p className="text-[11px] text-text-secondary mt-0.5">
            {campaign.shellStepCount}-step shell synced {formatDate(campaign.shellSyncedAt)}
          </p>
        ) : (
          <p className="text-[11px] text-[#92400E] mt-0.5">No shell — sync required before uploading</p>
        )}
      </div>
      <button
        onClick={onSync}
        disabled={isSyncing}
        className="flex-shrink-0 px-3 py-1.5 border border-border-card rounded-[6px] text-[11px] font-medium text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isSyncing ? 'Syncing…' : syncState === 'done' ? 'Re-sync' : 'Sync sequence shell'}
      </button>
    </div>
  )
}

function SuccessDisplay({
  result,
  onReset,
}: {
  result: Extract<UploadLeadsResult, { ok: true }>
  onReset: () => void
}) {
  const totalAttempted  = result.outcomes.reduce((n, o) => n + (o.ok ? o.attempted : 0), 0)
  const totalCreated    = result.outcomes.reduce((n, o) => n + (o.ok ? o.created : 0), 0)
  const totalDuplicated = result.outcomes.reduce((n, o) => n + (o.ok ? o.duplicated : 0), 0)
  const totalBlocklisted = result.outcomes.reduce((n, o) => n + (o.ok ? o.in_blocklist : 0), 0)
  const totalInvalid    = result.outcomes.reduce((n, o) => n + (o.ok ? o.invalid : 0), 0)
  const totalIncomplete = result.outcomes.reduce((n, o) => n + (o.ok ? o.incomplete : 0), 0)

  const hasUploaded  = result.outcomes.length > 0
  const isPartial    = result.hasPartialFailure
  const hasBlocked   = result.blockedSegments.length > 0
  const hasShellBlocked = result.shellBlockedCampaigns.length > 0
  const hasCompFails = result.compositionFailureCount > 0
  const hasIssue     = isPartial || hasBlocked || hasShellBlocked || hasCompFails

  const headerText = !hasUploaded && (hasBlocked || hasShellBlocked)
    ? 'Upload held'
    : hasIssue
      ? 'Upload complete (with issues)'
      : 'Upload complete'

  const isDark    = !hasUploaded && (hasBlocked || hasShellBlocked)
  const headerCls = isDark || hasIssue ? 'text-[#92400E]' : 'text-brand-green-success'
  const containerCls = isDark || hasIssue
    ? 'bg-[#FEFCE8] border border-[#FDE68A]'
    : 'bg-[#EBF5E6] border border-[#BDDAB0]'

  return (
    <div className="space-y-3">
      <div className={`${containerCls} rounded-[8px] px-4 py-3 space-y-2`}>
        <p className={`text-[12px] font-medium ${headerCls}`}>{headerText}</p>

        {totalAttempted > 0 && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-0.5">
            <StatRow label="Attempted"    value={totalAttempted} />
            <StatRow label="Created"      value={totalCreated} />
            <StatRow label="Duplicated"   value={totalDuplicated} />
            <StatRow label="Blocklisted"  value={totalBlocklisted} />
            <StatRow label="Invalid email" value={totalInvalid} />
            <StatRow label="Incomplete"   value={totalIncomplete} />
          </div>
        )}

        {/* Composition failures */}
        {hasCompFails && (
          <p className="text-[11px] text-[#92400E]">
            <span className="mr-1">⚠</span>
            {result.compositionFailureCount} lead{result.compositionFailureCount === 1 ? '' : 's'} excluded — composition failed. Leads marked failed in DB; check agent logs.
          </p>
        )}

        {(result.outcomes.length > 1 || isPartial) && (
          <div className="mt-2 space-y-1 border-t border-black/10 pt-2">
            {result.outcomes.map(outcome => (
              <CampaignOutcomeRow key={outcome.external_id} outcome={outcome} />
            ))}
          </div>
        )}

        {/* Shell-blocked campaigns */}
        {hasShellBlocked && (
          <div className="space-y-1 border-t border-black/10 pt-2">
            {result.shellBlockedCampaigns.map((b, i) => (
              <ShellBlockedRow key={b.campaignExternalId ?? i} blocked={b} />
            ))}
          </div>
        )}

        {/* Approval-blocked segments */}
        {hasBlocked && (
          <div className={`space-y-1 ${totalAttempted > 0 || hasShellBlocked ? 'border-t border-black/10 pt-2' : ''}`}>
            {result.blockedSegments.map((b, i) => (
              <BlockedSegmentRow key={b.segmentId ?? i} blocked={b} />
            ))}
          </div>
        )}
      </div>

      <button onClick={onReset} className="text-[11px] text-text-secondary hover:text-text-primary transition-colors">
        Upload again
      </button>
    </div>
  )
}

function ShellBlockedRow({ blocked }: { blocked: ShellBlockedReason }) {
  const shortId = blocked.campaignExternalId.slice(0, 8)
  const reason  = blocked.reason === 'no_shell'
    ? 'no sequence shell — sync before uploading'
    : `shell step count (${blocked.shellStepCount}) differs from Messaging doc (${blocked.docStepCount} steps) — re-sync`
  return (
    <p className="text-[11px] text-[#92400E]">
      <span className="mr-1">⏸</span>
      Campaign {shortId}…: {reason}
    </p>
  )
}

function BlockedSegmentRow({ blocked }: { blocked: BlockedSegmentReason }) {
  const segLabel = blocked.segmentName ?? (blocked.segmentId ? blocked.segmentId.slice(0, 8) + '…' : 'Default segment')
  return (
    <p className="text-[11px] text-[#92400E]">
      <span className="mr-1">⏸</span>
      Awaiting approval for {segLabel}: {blocked.pendingDocs.join(', ')}
    </p>
  )
}

function CampaignOutcomeRow({ outcome }: { outcome: CampaignOutcome }) {
  const shortId = outcome.external_id.slice(0, 8)
  if (outcome.ok) {
    return (
      <p className="text-[11px] text-text-primary">
        <span className="text-brand-green-success mr-1">✓</span>
        Campaign {shortId}…: {outcome.created} uploaded
        {outcome.duplicated > 0 && `, ${outcome.duplicated} duplicate`}
        {outcome.in_blocklist > 0 && `, ${outcome.in_blocklist} blocklisted`}
      </p>
    )
  }
  return (
    <p className="text-[11px] text-[#8B2020]">
      <span className="mr-1">✗</span>
      Campaign {shortId}…: {outcome.error}
    </p>
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

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return iso.slice(0, 10)
  }
}
