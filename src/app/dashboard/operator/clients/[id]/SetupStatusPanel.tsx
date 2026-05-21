'use client'

import { useState, useTransition } from 'react'
import { updateSetupStatus } from './actions'
import type { SetupStatusField, SetupStatusValue } from './actions'

export interface SetupStatusShape {
  campaigns: SetupStatusValue
  linkedin: SetupStatusValue
}

interface SetupStatusPanelProps {
  orgId: string
  initialStatus: SetupStatusShape
}

const STATUS_OPTIONS: { value: SetupStatusValue; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'complete', label: 'Complete' },
]

function StatusSelector({
  orgId,
  field,
  value,
  onChange,
}: {
  orgId: string
  field: SetupStatusField
  value: SetupStatusValue
  onChange: (v: SetupStatusValue) => void
}) {
  const [isPending, startTransition] = useTransition()

  function handleChange(next: SetupStatusValue) {
    onChange(next)
    startTransition(async () => {
      await updateSetupStatus(orgId, field, next)
    })
  }

  return (
    <div className="flex items-center gap-2">
      {STATUS_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => handleChange(opt.value)}
          disabled={isPending}
          className={`px-3 py-1.5 rounded-[6px] text-[11px] font-medium border transition-colors ${
            value === opt.value
              ? 'bg-brand-green-operator text-white border-brand-green-operator'
              : 'bg-surface-content border-border-card text-text-secondary hover:text-text-primary hover:border-[#D8D2C8]'
          } ${isPending ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

export function SetupStatusPanel({ orgId, initialStatus }: SetupStatusPanelProps) {
  const [status, setStatus] = useState<SetupStatusShape>(initialStatus)

  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] overflow-hidden">
      <div className="px-5 py-4 border-b border-border-card">
        <h2 className="text-[13px] font-semibold text-text-primary">Setup status</h2>
      </div>

      <div className="divide-y divide-border-card">
        <div className="px-5 py-4 flex items-center justify-between">
          <div>
            <p className="text-[13px] font-medium text-text-primary">Cold email campaigns</p>
            <p className="text-[11px] text-text-secondary mt-0.5">
              Instantly campaigns configured and active
            </p>
          </div>
          <StatusSelector
            orgId={orgId}
            field="campaigns"
            value={status.campaigns}
            onChange={(v) => setStatus((s) => ({ ...s, campaigns: v }))}
          />
        </div>

        <div className="px-5 py-4 flex items-center justify-between">
          <div>
            <p className="text-[13px] font-medium text-text-primary">LinkedIn content</p>
            <p className="text-[11px] text-text-secondary mt-0.5">
              LinkedIn posting and content strategy configured
            </p>
          </div>
          <StatusSelector
            orgId={orgId}
            field="linkedin"
            value={status.linkedin}
            onChange={(v) => setStatus((s) => ({ ...s, linkedin: v }))}
          />
        </div>
      </div>
    </div>
  )
}
