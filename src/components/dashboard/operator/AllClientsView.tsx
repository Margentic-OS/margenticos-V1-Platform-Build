// OPERATOR ONLY — payment_status, contract_status, and engagement_month displayed
// here must NEVER appear in client-facing queries or components. These fields are
// operator-only and exist solely for Doug's operational visibility.

export interface ClientSummary {
  id: string
  name: string
  pipeline_unlocked: boolean
  // TODO: Add payment_status and contract_status when columns are added to the
  // organisations table. These are operator-only fields and must never be exposed
  // to client-facing queries or components.
  engagement_month: number | null
}

interface AllClientsViewProps {
  clients: ClientSummary[]
}

function statusLabel(client: ClientSummary): { label: string; style: string; dot: string } {
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

function ClientRow({ client }: { client: ClientSummary }) {
  const status = statusLabel(client)

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

      {/* Engagement month */}
      <div className="shrink-0 text-right w-20">
        <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-0.5">
          Month
        </p>
        <p className="text-[12px] font-medium text-text-primary">
          {client.engagement_month ?? '—'}
        </p>
      </div>

      {/* Payment status — OPERATOR ONLY, never shown in client-facing components */}
      {/* TODO: Query payment_status from organisations table when column is added */}
      <div className="shrink-0 text-right w-24">
        <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-0.5">
          Payment
        </p>
        <p className="text-[12px] font-medium text-brand-green-success">
          Current
        </p>
      </div>

      {/* Contract status — OPERATOR ONLY, never shown in client-facing components */}
      {/* TODO: Query contract_status from organisations table when column is added */}
      <div className="shrink-0 text-right w-24">
        <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-0.5">
          Contract
        </p>
        <p className="text-[12px] font-medium text-text-primary">
          Active
        </p>
      </div>

      {/* Pending approvals — TODO: join with document_suggestions count per org */}
      <div className="shrink-0 w-24 text-right">
        <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-0.5">
          Approvals
        </p>
        <p className="text-[12px] font-medium text-text-muted">—</p>
      </div>

      {/* View action */}
      <a
        href={`/dashboard/operator?client=${client.id}`}
        className="shrink-0 px-3 py-1.5 bg-[#F0ECE4] border border-border-card rounded-[6px] text-[11px] font-medium text-text-secondary hover:text-text-primary hover:border-[#D8D2C8] transition-colors"
      >
        View
      </a>
    </div>
  )
}

export function AllClientsView({ clients }: AllClientsViewProps) {
  if (clients.length === 0) {
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
      <div className="px-7 py-6 max-w-[1040px] space-y-3">
        {clients.map((client) => (
          <ClientRow key={client.id} client={client} />
        ))}
      </div>
    </div>
  )
}
