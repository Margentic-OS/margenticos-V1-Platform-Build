// The prospects receiving the approved opening because the writer was stopped. Read-only.
// See src/lib/operator/writer-stopped.ts for how they are found and why the list exists.

import type { WriterStoppedProspect } from '@/lib/operator/writer-stopped'

interface WriterStoppedPanelProps {
  prospects: WriterStoppedProspect[]
  error: string | null
}

export function WriterStoppedPanel({ prospects, error }: WriterStoppedPanelProps) {
  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] overflow-hidden">
      <div className="px-6 py-4 border-b border-border-card bg-surface-shell">
        <h3 className="text-[13px] font-medium text-text-primary">Approved opening, writer stopped</h3>
        <p className="text-[11px] text-text-secondary mt-1">
          Research found nothing specific, checkable and relevant enough to write from, so these
          prospects get the approved opening instead of a personalised one.
          {!error && ` ${prospects.length} prospect${prospects.length === 1 ? '' : 's'}.`}
        </p>
      </div>
      {error ? (
        <p className="px-6 py-3 text-[11px] text-text-secondary">Could not load this list: {error}</p>
      ) : prospects.length === 0 ? (
        <p className="px-6 py-3 text-[11px] text-text-secondary">None on the latest research runs.</p>
      ) : (
        <ul className="divide-y divide-border-card">
          {prospects.map(p => (
            <li key={p.id} className="px-6 py-3">
              <p className="text-[12px] font-medium text-text-primary">
                {p.name}{p.company_name ? `, ${p.company_name}` : ''}
              </p>
              {p.job_title && <p className="text-[11px] text-text-secondary">{p.job_title}</p>}
              {p.synthesis_note && (
                <p className="text-[11px] text-text-secondary mt-0.5">Research note: {p.synthesis_note}</p>
              )}
              {p.research_ran_at && (
                <p className="text-[11px] text-text-secondary mt-0.5">Researched {p.research_ran_at.slice(0, 10)}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
