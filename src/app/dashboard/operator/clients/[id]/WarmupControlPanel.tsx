'use client'

import { useState, useTransition } from 'react'
import { updateWarmupStartedAt } from './actions'

interface WarmupControlPanelProps {
  orgId: string
  warmupStartedAt: string | null
}

export function WarmupControlPanel({ orgId, warmupStartedAt: initial }: WarmupControlPanelProps) {
  const [current, setCurrent] = useState(initial)
  // HTML date input uses YYYY-MM-DD
  const [dateInput, setDateInput] = useState(
    initial ? initial.slice(0, 10) : ''
  )
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [, startTransition] = useTransition()

  function handleSave() {
    if (!dateInput) return
    setError(null)
    setSaved(false)
    startTransition(async () => {
      const isoDate = new Date(dateInput).toISOString()
      const result = await updateWarmupStartedAt(orgId, isoDate)
      if (result.error) {
        setError(result.error)
      } else {
        setCurrent(isoDate)
        setSaved(true)
      }
    })
  }

  function handleClear() {
    setError(null)
    setSaved(false)
    startTransition(async () => {
      const result = await updateWarmupStartedAt(orgId, null)
      if (result.error) {
        setError(result.error)
      } else {
        setCurrent(null)
        setDateInput('')
        setSaved(true)
      }
    })
  }

  const displayDate = current
    ? new Date(current).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'Not set'

  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <p className="text-[13px] font-medium text-text-primary">Email warmup</p>
          <p className="text-[11px] text-text-secondary mt-0.5">
            Setting this date shows the warmup progress bar and launch date on the client dashboard.
          </p>
        </div>
        <span className={[
          'flex items-center gap-1 px-2 py-0.5 rounded-full shrink-0',
          current ? 'bg-[#EBF5E6]' : 'bg-[#F0ECE4]',
        ].join(' ')}>
          <span className={`w-1 h-1 rounded-full ${current ? 'bg-[#3B6D11]' : 'bg-text-muted'}`} />
          <span className={`text-[9px] font-medium ${current ? 'text-[#3B6D11]' : 'text-text-muted'}`}>
            {current ? 'Active' : 'Not set'}
          </span>
        </span>
      </div>

      <div className="flex items-center gap-2 mb-1">
        <p className="text-[11px] text-text-secondary w-28 shrink-0">Warmup started:</p>
        <p className="text-[11px] font-medium text-text-primary">{displayDate}</p>
      </div>

      <div className="flex items-center gap-2 mt-3">
        <input
          type="date"
          value={dateInput}
          onChange={e => { setDateInput(e.target.value); setSaved(false) }}
          className="px-3 py-2 text-xs text-text-primary bg-surface-content border border-border-card rounded-[6px] focus:outline-none focus:border-brand-green-accent transition-colors"
        />
        <button
          onClick={handleSave}
          disabled={!dateInput}
          className="px-4 py-2 text-xs font-medium text-[#F5F0E8] bg-brand-green rounded-[20px] hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Set date
        </button>
        {current && (
          <button
            onClick={handleClear}
            className="px-4 py-2 text-xs text-text-secondary border border-border-card rounded-[20px] hover:text-text-primary transition-colors"
          >
            Clear
          </button>
        )}
        {saved && (
          <p className="text-[10px] text-[#3B6D11]">Saved</p>
        )}
      </div>

      {error && (
        <p className="mt-2 text-[11px] text-[#C0392B]">{error}</p>
      )}
    </div>
  )
}
