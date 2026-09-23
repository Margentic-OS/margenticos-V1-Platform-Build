'use client'

// Seed FAQs panel — the operator's only way to run the FAQ seed agent.
//
// Shows three things the operator needs before pressing anything: whether a run is
// allowed, how many candidates the last run produced, and when it happened. The run
// itself is a single Opus call that can take a couple of minutes, so the button stays
// in its running state until the route answers.

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface SeedRun {
  id: string
  state: 'running' | 'completed' | 'failed'
  started_at: string
  finished_at: string | null
  candidates_created: number | null
  error_message: string | null
}

interface SeedStatus {
  pending_seed_count: number
  last_run: SeedRun | null
  running: boolean
}

interface SeedFaqsPanelProps {
  orgId: string
  orgName: string
  /** Called after a run creates candidates, so the queue beside this panel reloads. */
  onSeeded: () => void
}

function formatRunTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'an unknown time'
  return d.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function describeLastRun(run: SeedRun | null): string {
  if (!run) return 'No seed run yet for this client.'

  const when = formatRunTime(run.started_at)
  if (run.state === 'running') return `A run started ${when} and is still going.`
  if (run.state === 'failed') return `Last run ${when} failed.`

  const created = run.candidates_created ?? 0
  return `Last run ${when} created ${created} candidate${created === 1 ? '' : 's'}.`
}

export function SeedFaqsPanel({ orgId, orgName, onSeeded }: SeedFaqsPanelProps) {
  const router = useRouter()

  const [status, setStatus] = useState<SeedStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [justCreated, setJustCreated] = useState<number | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/operator/faq-seed?client=${orgId}`, { credentials: 'same-origin' })
      if (res.status === 401) { router.push('/login'); return }
      if (!res.ok) {
        // Surface the route's own message where it has one, so a refused role reads
        // differently from a failed read.
        const json = await res.json().catch(() => ({})) as Record<string, unknown>
        setStatusError(typeof json.error === 'string' ? json.error : `Could not load seed status (${res.status}).`)
        return
      }
      setStatus(await res.json() as SeedStatus)
      setStatusError(null)
    } catch {
      setStatusError('Could not load seed status.')
    }
  }, [orgId, router])

  useEffect(() => { fetchStatus() }, [fetchStatus])

  async function handleSeed() {
    if (running) return
    setRunning(true)
    setRunError(null)
    setJustCreated(null)

    try {
      const res = await fetch('/api/operator/faq-seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ organisation_id: orgId }),
      })

      if (res.status === 401) { router.push('/login'); return }

      const json = await res.json().catch(() => ({})) as Record<string, unknown>

      if (!res.ok) {
        setRunError(typeof json.error === 'string' ? json.error : `Seed run failed (${res.status}).`)
        await fetchStatus()
        return
      }

      const created = typeof json.candidates_created === 'number' ? json.candidates_created : 0
      setJustCreated(created)
      await fetchStatus()
      onSeeded()
    } catch {
      setRunError('Connection error — the run may still be going. Reload before trying again.')
    } finally {
      setRunning(false)
    }
  }

  const pending = status?.pending_seed_count ?? 0
  const blockedByPending = pending > 0
  const disabled = running || blockedByPending || status === null

  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] px-5 py-4 mb-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-text-primary mb-1">Seed FAQs</p>
          <p className="text-[12px] text-text-secondary">
            Generates baseline FAQ candidates for {orgName} from its intake and strategy documents.
            Candidates land in the queue on the left for review, and cannot be used in a reply
            until approved.
          </p>
        </div>
        <button
          type="button"
          onClick={handleSeed}
          disabled={disabled}
          className="shrink-0 px-3.5 py-1.5 rounded-[6px] bg-brand-green text-[#F5F0E8] text-[12px] font-medium hover:bg-[#244030] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {running ? 'Generating…' : 'Generate seed FAQs'}
        </button>
      </div>

      <div className="mt-3 flex flex-col gap-1">
        {statusError ? (
          <p className="text-[11px] text-[#8B2020]">{statusError}</p>
        ) : (
          <p className="text-[11px] text-text-muted">{describeLastRun(status?.last_run ?? null)}</p>
        )}

        {blockedByPending && (
          <p className="text-[11px] text-text-secondary">
            {pending} seed candidate{pending === 1 ? '' : 's'} from an earlier run
            {pending === 1 ? ' is' : ' are'} still waiting for review. Clear the queue before seeding again.
          </p>
        )}

        {running && (
          <p className="text-[11px] text-text-secondary">
            This takes up to a few minutes. Leave the page open.
          </p>
        )}

        {justCreated !== null && (
          <p className="text-[11px] text-text-primary">
            Created {justCreated} candidate{justCreated === 1 ? '' : 's'}.
          </p>
        )}

        {runError && <p className="text-[11px] text-[#8B2020]">{runError}</p>}
      </div>
    </div>
  )
}
