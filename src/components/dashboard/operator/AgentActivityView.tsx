// TODO: Replace placeholder data with a real query from an agent_runs table when
// that table exists. The query should select across all organisations, joining on
// organisations.name for the client column. Order by started_at desc.

export interface AgentRun {
  id: string
  clientName: string
  agentName: string
  status: 'completed' | 'failed' | 'running'
  durationMs: number | null
  outputSummary: string
  startedAt: string
}

const PLACEHOLDER_RUNS: AgentRun[] = [
  {
    id: 'r1',
    clientName: 'Apex Consulting',
    agentName: 'ICP Generation',
    status: 'completed',
    durationMs: 14200,
    outputSummary: 'ICP document generated — v2.0',
    startedAt: '2026-04-19T09:14:00Z',
  },
  {
    id: 'r2',
    clientName: 'Meridian Group',
    agentName: 'Prospect Research',
    status: 'completed',
    durationMs: 8700,
    outputSummary: '3 prospects researched — Accenture, BCG, Deloitte',
    startedAt: '2026-04-19T08:52:00Z',
  },
  {
    id: 'r3',
    clientName: 'Apex Consulting',
    agentName: 'Reply Handler',
    status: 'failed',
    durationMs: 340,
    outputSummary: 'Could not classify reply — forwarded to operator review',
    startedAt: '2026-04-18T17:30:00Z',
  },
  {
    id: 'r4',
    clientName: 'Meridian Group',
    agentName: 'Positioning Agent',
    status: 'running',
    durationMs: null,
    outputSummary: 'Positioning document in progress',
    startedAt: '2026-04-18T16:05:00Z',
  },
]

const STATUS_STYLES: Record<AgentRun['status'], { label: string; style: string }> = {
  completed: {
    label: 'Completed',
    style: 'bg-[#EBF5E6] text-brand-green-success border border-[#BDDAB0]',
  },
  failed: {
    label: 'Failed',
    style: 'bg-[#FDEEE8] text-[#8B2020] border border-[#EFBCAA]',
  },
  running: {
    label: 'Running',
    style: 'bg-[#FEF7E6] text-[#7A4800] border border-[#F0D080]',
  },
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

interface AgentActivityViewProps {
  runs?: AgentRun[]
}

export function AgentActivityView({ runs = PLACEHOLDER_RUNS }: AgentActivityViewProps) {
  if (runs.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto bg-surface-content">
        <div className="px-7 py-6 max-w-[1040px]">
          <div className="bg-surface-card border border-border-card rounded-[10px] px-8 py-12 text-center">
            <p className="text-[13px] font-medium text-text-primary mb-2">
              No agent activity yet
            </p>
            <p className="text-[12px] text-text-secondary">
              Agents run when campaigns are live — activity will appear here once the first campaign launches.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto bg-surface-content">
      <div className="px-7 py-6 max-w-[1040px]">
        <div className="bg-surface-card border border-border-card rounded-[10px] overflow-hidden">
          {/* Column headers */}
          <div className="grid grid-cols-[130px_1fr_130px_100px_80px_1fr] gap-4 px-5 py-2.5 border-b border-border-card">
            {['Timestamp', 'Client', 'Agent', 'Status', 'Duration', 'Output'].map((col) => (
              <p key={col} className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary">
                {col}
              </p>
            ))}
          </div>

          {/* Rows */}
          {runs.map((run, i) => {
            const s = STATUS_STYLES[run.status]
            return (
              <div
                key={run.id}
                className={`grid grid-cols-[130px_1fr_130px_100px_80px_1fr] gap-4 px-5 py-3 items-center ${
                  i < runs.length - 1 ? 'border-b border-border-card' : ''
                }`}
              >
                <p className="text-[11px] text-text-secondary tabular-nums">
                  {formatTimestamp(run.startedAt)}
                </p>
                <p className="text-[11px] font-medium text-text-primary truncate">
                  {run.clientName}
                </p>
                <p className="text-[11px] text-text-primary truncate">
                  {run.agentName}
                </p>
                <div>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${s.style}`}>
                    {s.label}
                  </span>
                </div>
                <p className="text-[11px] text-text-secondary tabular-nums">
                  {formatDuration(run.durationMs)}
                </p>
                <p className="text-[11px] text-text-secondary truncate">
                  {run.outputSummary}
                </p>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
