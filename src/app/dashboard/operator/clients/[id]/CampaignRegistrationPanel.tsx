'use client'

import { useState, useTransition } from 'react'
import { checkCampaign, registerCampaign } from './actions'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface CampaignInfo {
  name: string
  status: string
  schedulingStatus: string | null
}

type PanelState =
  | { phase: 'idle' }
  | { phase: 'validating' }
  | ({ phase: 'validated' } & CampaignInfo)
  | ({ phase: 'registering' } & CampaignInfo)
  | { phase: 'registered'; name: string; campaignId: string }
  | { phase: 'error'; message: string }

export function CampaignRegistrationPanel({ orgId }: { orgId: string }) {
  const [uuid, setUuid] = useState('')
  const [state, setState] = useState<PanelState>({ phase: 'idle' })
  const [isPending, startTransition] = useTransition()

  const uuidError =
    uuid.length > 0 && !UUID_RE.test(uuid.trim())
      ? 'Must be a valid UUID (e.g. xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)'
      : null

  const isWorking = isPending || state.phase === 'validating' || state.phase === 'registering'
  const inputLocked = state.phase === 'validated' || state.phase === 'registering' || state.phase === 'validating'

  function handleValidate() {
    const trimmed = uuid.trim()
    if (!UUID_RE.test(trimmed)) return
    setState({ phase: 'validating' })
    startTransition(async () => {
      const result = await checkCampaign(orgId, trimmed)
      if (result.ok) {
        setState({ phase: 'validated', name: result.name, status: result.status, schedulingStatus: result.schedulingStatus })
      } else {
        setState({ phase: 'error', message: result.error })
      }
    })
  }

  function handleConfirm() {
    if (state.phase !== 'validated') return
    const info: CampaignInfo = { name: state.name, status: state.status, schedulingStatus: state.schedulingStatus }
    setState({ phase: 'registering', ...info })
    startTransition(async () => {
      const result = await registerCampaign(orgId, uuid.trim(), info.name)
      if (result.ok) {
        setState({ phase: 'registered', name: info.name, campaignId: result.campaignId })
      } else {
        setState({ phase: 'error', message: result.error })
      }
    })
  }

  function handleReset() {
    setUuid('')
    setState({ phase: 'idle' })
  }

  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] overflow-hidden">
      <div className="px-5 py-4 border-b border-border-card">
        <h2 className="text-[13px] font-semibold text-text-primary">Campaign registration</h2>
        <p className="text-[11px] text-text-secondary mt-0.5">
          Register an Instantly campaign UUID to link it to this client.
        </p>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Success state */}
        {state.phase === 'registered' && (
          <div className="space-y-3">
            <div className="bg-[#EBF5E6] border border-[#BDDAB0] rounded-[8px] px-4 py-3">
              <p className="text-[12px] font-medium text-brand-green-success">Campaign registered</p>
              <p className="text-[11px] text-brand-green-success mt-0.5">{state.name}</p>
            </div>
            <button
              onClick={handleReset}
              className="text-[11px] text-text-secondary hover:text-text-primary transition-colors"
            >
              Register another campaign
            </button>
          </div>
        )}

        {/* Active form states */}
        {state.phase !== 'registered' && (
          <>
            {/* UUID input */}
            <div>
              <label className="block text-[11px] font-medium text-text-secondary mb-1.5">
                Instantly campaign UUID
              </label>
              <input
                type="text"
                value={uuid}
                onChange={(e) => {
                  setUuid(e.target.value)
                  if (state.phase === 'error') setState({ phase: 'idle' })
                }}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                disabled={inputLocked}
                className={`w-full px-3 py-2 rounded-[6px] border text-[12px] text-text-primary placeholder:text-text-muted bg-white focus:outline-none focus:ring-1 focus:ring-brand-green-operator transition-colors ${
                  uuidError ? 'border-[#C0392B]' : 'border-border-card focus:border-brand-green-operator'
                } disabled:bg-[#F5F3EF] disabled:text-text-muted`}
              />
              {uuidError && (
                <p className="text-[11px] text-[#8B2020] mt-1">{uuidError}</p>
              )}
            </div>

            {/* Validated campaign info */}
            {(state.phase === 'validated' || state.phase === 'registering') && (
              <div className="bg-[#F5F3EF] border border-border-card rounded-[8px] px-4 py-3 space-y-1">
                <p className="text-[12px] font-medium text-text-primary">{state.name}</p>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] uppercase tracking-[0.07em] text-text-secondary">Status</span>
                  <span className="text-[11px] text-text-primary">{state.status}</span>
                  {state.schedulingStatus && (
                    <>
                      <span className="text-[10px] uppercase tracking-[0.07em] text-text-secondary">Scheduling</span>
                      <span className="text-[11px] text-text-primary">{state.schedulingStatus}</span>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Error message */}
            {state.phase === 'error' && (
              <div className="bg-[#FDF0F0] border border-[#E8B4B4] rounded-[8px] px-4 py-3">
                <p className="text-[12px] text-[#8B2020]">{state.message}</p>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-2">
              {(state.phase === 'idle' || state.phase === 'error') && (
                <button
                  onClick={handleValidate}
                  disabled={isWorking || !uuid.trim() || !!uuidError}
                  className="px-4 py-2 bg-brand-green-operator text-white rounded-[6px] text-[12px] font-medium hover:bg-brand-green-operator/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Validate &amp; register
                </button>
              )}

              {state.phase === 'validated' && (
                <>
                  <button
                    onClick={handleConfirm}
                    disabled={isWorking}
                    className="px-4 py-2 bg-brand-green-operator text-white rounded-[6px] text-[12px] font-medium hover:bg-brand-green-operator/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Confirm registration
                  </button>
                  <button
                    onClick={handleReset}
                    disabled={isWorking}
                    className="px-4 py-2 bg-[#F0ECE4] border border-border-card rounded-[6px] text-[12px] font-medium text-text-secondary hover:text-text-primary hover:border-[#D8D2C8] transition-colors"
                  >
                    Cancel
                  </button>
                </>
              )}

              {(state.phase === 'validating' || state.phase === 'registering') && (
                <p className="text-[11px] text-text-secondary">
                  {state.phase === 'validating' ? 'Checking with Instantly…' : 'Registering campaign…'}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
