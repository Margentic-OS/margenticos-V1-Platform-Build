// OPERATOR ONLY — payment_status, contract_status, engagement_month, and
// pendingApprovals displayed here must NEVER appear in client-facing queries
// or components. These fields exist solely for Doug's operational visibility.

'use client'

import Link from 'next/link'
import { useState } from 'react'
import { ArchiveButton } from './ArchiveButton'

export interface ClientSummary {
  id: string
  name: string
  pipeline_unlocked: boolean
  engagement_month: number | null
  archived_at: string | null
  // Operator-only fields — never expose in client-facing queries or components
  payment_status: string | null
  contract_status: string | null
  pendingApprovals: number
}

interface AllClientsViewProps {
  clients: ClientSummary[]
  archivedClients?: ClientSummary[]
}

function statusLabel(client: ClientSummary): { label: string; style: string; dot: string } {
  if (client.archived_at) {
    return {
      label: 'Archived',
      style: 'bg-[#E8E8E8] text-[#666666] border border-[#CCCCCC]',
      dot: 'bg-[#999999]',
    }
  }
  if (client.pipeline_unlocked) {
    return {
      label: 'Live',
      style: 'bg-[#EBF5E6] text-brand-green-success border border-[#BDDAB0]',
      dot: 'bg-brand-green-success',
    }
  }
  if ((client.engagement_month ?? 0) > 0) {
    return {
      label: 'Warming',
      style: 'bg-[#FEF7E6] text-[#7A4800] border border-[#F0D080]',
      dot: 'bg-brand-amber',
    }
  }
  return {
    label: 'Setup',
    style: 'bg-[#F0ECE4] text-text-secondary border border-border-card',
    dot: 'bg-text-muted',
  }
}

interface ClientRowProps {
  client: ClientSummary
  onArchiveChange?: () => void
}

function ClientRow({ client, onArchiveChange }: ClientRowProps) {
  const status = statusLabel(client)
  const isArchived = !!client.archived_at

  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] px-5 py-4 flex items-center gap-5">
      {/* Status dot + name */}
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        <span className={`w-2 h-2 rounded-full shrink-0 ${status.dot}`} />
        <span className="text-[13px] font-medium text-text-primary truncate">
          {client.name}
        </span>
      </div>

      {/* Status pill */}
      <div className={`flex items-center px-2.5 py-1 rounded-full text-[10px] font-medium shrink-0 ${status.style}`}>
        {status.label}
      </div>

      {/* Engagement month (hide if archived) */}
      {!isArchived && (
        <div className="shrink-0 text-right w-20">
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-0.5">
            Month
          </p>
          <p className="text-[12px] font-medium text-text-primary">
            {client.engagement_month ?? '—'}
          </p>
        </div>
      )}

      {/* Payment status — OPERATOR ONLY, hide if archived */}
      {!isArchived && (
        <div className="shrink-0 text-right w-24">
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-0.5">
            Payment
          </p>
          <p className={`text-[12px] font-medium ${
            client.payment_status === 'overdue'
              ? 'text-[#8B2020]'
              : client.payment_status === 'current'
              ? 'text-brand-green-success'
              : 'text-text-muted'
          }`}>
            {client.payment_status === 'overdue'
              ? 'Overdue'
              : client.payment_status === 'current'
              ? 'Current'
              : '—'}
          </p>
        </div>
      )}

      {/* Contract status — OPERATOR ONLY, hide if archived */}
      {!isArchived && (
        <div className="shrink-0 text-right w-24">
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-0.5">
            Contract
          </p>
          <p className={`text-[12px] font-medium ${
            client.contract_status === 'churned'
              ? 'text-[#8B2020]'
              : client.contract_status === 'paused'
              ? 'text-[#7A4800]'
              : client.contract_status === 'active'
              ? 'text-text-primary'
              : 'text-text-muted'
          }`}>
            {client.contract_status === 'active'
              ? 'Active'
              : client.contract_status === 'paused'
              ? 'Paused'
              : client.contract_status === 'churned'
              ? 'Churned'
              : '—'}
          </p>
        </div>
      )}

      {/* Pending approvals — hide if archived */}
      {!isArchived && (
        <div className="shrink-0 w-24 text-right">
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-0.5">
            Approvals
          </p>
          {client.pendingApprovals > 0 ? (
            <p className="text-[12px] font-medium text-[#7A4800]">
              {client.pendingApprovals} pending
            </p>
          ) : (
            <p className="text-[12px] font-medium text-text-muted">—</p>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="shrink-0 flex items-center gap-2">
        {!isArchived && (
          <>
            <Link
              href={`/dashboard?client=${client.id}`}
              className="px-3 py-1.5 bg-[#F0ECE4] border border-border-card rounded-[6px] text-[11px] font-medium text-text-secondary hover:text-text-primary hover:border-[#D8D2C8] transition-colors"
            >
              View
            </Link>
            <Link
              href={`/dashboard/operator/clients/${client.id}`}
              className="px-3 py-1.5 bg-[#F0ECE4] border border-border-card rounded-[6px] text-[11px] font-medium text-text-secondary hover:text-text-primary hover:border-[#D8D2C8] transition-colors"
            >
              Manage
            </Link>
          </>
        )}
        <ArchiveButton
          orgId={client.id}
          orgName={client.name}
          isArchived={isArchived}
          onSuccess={onArchiveChange}
        />
      </div>
    </div>
  )
}

export function AllClientsView({ clients, archivedClients = [] }: AllClientsViewProps) {
  const [showArchived, setShowArchived] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  const handleArchiveChange = () => {
    setRefreshKey(prev => prev + 1)
  }

  const hasArchived = archivedClients.length > 0
  const activeCount = clients.length
  const totalCount = activeCount + archivedClients.length

  if (activeCount === 0 && archivedClients.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto bg-surface-content">
        <div className="px-7 py-6 max-w-[1040px]">
          <div className="bg-surface-card border border-border-card rounded-[10px] px-8 py-12 text-center">
            <p className="text-[13px] font-medium text-text-primary mb-2">
              No clients onboarded yet
            </p>
            <p className="text-[12px] text-text-secondary">
              MargenticOS runs as client zero first — add the first client to begin.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto bg-surface-content">
      <div className="px-7 py-6 max-w-[1040px]">
        {/* Active clients section */}
        <div className="space-y-3 mb-6">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-medium text-text-primary">
              Active clients ({activeCount})
            </h2>
          </div>
          {activeCount > 0 ? (
            <div key={refreshKey} className="space-y-3">
              {clients.map((client) => (
                <ClientRow
                  key={client.id}
                  client={client}
                  onArchiveChange={handleArchiveChange}
                />
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-text-secondary italic py-4">No active clients</p>
          )}
        </div>

        {/* Archived clients section */}
        {hasArchived && (
          <div className="space-y-3 pt-6 border-t border-border-card">
            <button
              onClick={() => setShowArchived(!showArchived)}
              className="flex items-center gap-2 text-[12px] font-medium text-text-secondary hover:text-text-primary transition-colors"
            >
              <span>{showArchived ? '▼' : '▶'}</span>
              <span>Archived ({archivedClients.length})</span>
            </button>

            {showArchived && (
              <div className="space-y-3 mt-4">
                {archivedClients.map((client) => (
                  <ClientRow
                    key={client.id}
                    client={client}
                    onArchiveChange={handleArchiveChange}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
