'use client'

import { useState, useTransition } from 'react'
import { handleDfyQuote, handleDfyRealOrder, INSTANTLY_DFY_ALLOWED_TLDS } from './actions'

interface Props {
  orgId: string
  instantlyApiActive: boolean
}

type QuoteInfo = { orderIsValid: boolean; totalPrice: number | null; domains: string[] }

type PanelState =
  | { phase: 'idle' }
  | { phase: 'quoting' }
  | ({ phase: 'quoted' } & QuoteInfo)
  | ({ phase: 'ordering' } & QuoteInfo)
  | { phase: 'ordered' }
  | { phase: 'error'; message: string }

function parseDomains(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map(d => d.trim().toLowerCase())
    .filter(Boolean)
}

function tldOf(domain: string): string {
  const idx = domain.lastIndexOf('.')
  return idx === -1 ? '' : domain.slice(idx)
}

export function MailboxOrderPanel({ orgId, instantlyApiActive }: Props) {
  const [domainsRaw, setDomainsRaw] = useState('')
  const [state, setState] = useState<PanelState>({ phase: 'idle' })
  const [isPending, startTransition] = useTransition()

  const domains = parseDomains(domainsRaw)

  const allowedTlds = INSTANTLY_DFY_ALLOWED_TLDS as readonly string[]
  const invalidDomains = domains.filter(d => !allowedTlds.includes(tldOf(d)))
  const tldError =
    invalidDomains.length > 0
      ? `Invalid TLD${invalidDomains.length > 1 ? 's' : ''}: ${invalidDomains.join(', ')}. Allowed: ${allowedTlds.join(', ')}`
      : null

  const isWorking = isPending || state.phase === 'quoting' || state.phase === 'ordering'
  const canGetQuote = domains.length > 0 && !tldError && !isWorking

  function handleGetQuote() {
    if (!canGetQuote) return
    setState({ phase: 'quoting' })
    startTransition(async () => {
      const result = await handleDfyQuote(orgId, domains)
      if (result.ok) {
        setState({ phase: 'quoted', orderIsValid: result.order_is_valid, totalPrice: result.total_price, domains })
      } else {
        setState({ phase: 'error', message: result.error })
      }
    })
  }

  function handlePlaceOrder() {
    if (state.phase !== 'quoted') return
    const quoteInfo: QuoteInfo = { orderIsValid: state.orderIsValid, totalPrice: state.totalPrice, domains: state.domains }
    setState({ phase: 'ordering', ...quoteInfo })
    startTransition(async () => {
      const result = await handleDfyRealOrder(orgId, quoteInfo.domains)
      if (result.ok) {
        setState({ phase: 'ordered' })
      } else {
        setState({ phase: 'error', message: result.error })
      }
    })
  }

  function handleReset() {
    setDomainsRaw('')
    setState({ phase: 'idle' })
  }

  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] overflow-hidden">
      <div className="px-5 py-4 border-b border-border-card">
        <h2 className="text-[13px] font-semibold text-text-primary">DFY mailbox ordering</h2>
        <p className="text-[11px] text-text-secondary mt-0.5">
          Order pre-warmed Instantly DFY email accounts. Get a quote first, then confirm. Supported TLDs: .com, .org.
        </p>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Mock-mode banner (always visible when flag is off) */}
        {!instantlyApiActive && (
          <div className="bg-[#FEFCE8] border border-[#FDE68A] rounded-[8px] px-4 py-3">
            <p className="text-[12px] font-medium text-[#92400E]">Mock mode active</p>
            <p className="text-[11px] text-[#92400E] mt-0.5">
              instantly_api_active is false. Quotes will call the mock server.
              The confirm button is disabled until the flag is enabled.
            </p>
          </div>
        )}

        {/* Success state */}
        {state.phase === 'ordered' && (
          <div className="space-y-3">
            <div className="bg-[#EBF5E6] border border-[#BDDAB0] rounded-[8px] px-4 py-3">
              <p className="text-[12px] font-medium text-brand-green-success">Order placed</p>
              <p className="text-[11px] text-brand-green-success mt-0.5">
                Instantly DFY mailboxes have been ordered. Allow 24–72 hours for setup.
              </p>
            </div>
            <button
              onClick={handleReset}
              className="text-[11px] text-text-secondary hover:text-text-primary transition-colors"
            >
              Order more mailboxes
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
              Start over
            </button>
          </div>
        )}

        {/* Active form */}
        {state.phase !== 'ordered' && state.phase !== 'error' && (
          <>
            {/* Domain input */}
            <div>
              <label className="block text-[11px] font-medium text-text-secondary mb-1.5">
                Domains (one per line or comma-separated)
              </label>
              <textarea
                value={domainsRaw}
                onChange={(e) => {
                  setDomainsRaw(e.target.value)
                  if (state.phase === 'quoted') setState({ phase: 'idle' })
                }}
                placeholder="client-outreach.com&#10;client-email.org"
                rows={3}
                disabled={state.phase === 'quoted' || state.phase === 'quoting' || state.phase === 'ordering'}
                className={`w-full px-3 py-2 rounded-[6px] border text-[12px] text-text-primary placeholder:text-text-muted bg-white focus:outline-none focus:ring-1 focus:ring-brand-green-operator transition-colors resize-none ${
                  tldError ? 'border-[#C0392B]' : 'border-border-card focus:border-brand-green-operator'
                } disabled:bg-[#F5F3EF] disabled:text-text-muted`}
              />
              {tldError && (
                <p className="text-[11px] text-[#8B2020] mt-1">{tldError}</p>
              )}
            </div>

            {/* Quote result */}
            {(state.phase === 'quoted' || state.phase === 'ordering') && (
              <div className="bg-[#F5F3EF] border border-border-card rounded-[8px] px-4 py-3 space-y-1">
                <p className="text-[12px] font-medium text-text-primary">Quote</p>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] uppercase tracking-[0.07em] text-text-secondary">Valid</span>
                    <span className="text-[11px] text-text-primary">{state.orderIsValid ? 'Yes' : 'No'}</span>
                  </div>
                  {state.totalPrice !== null && (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] uppercase tracking-[0.07em] text-text-secondary">Total</span>
                      <span className="text-[11px] text-text-primary font-medium">${state.totalPrice.toFixed(2)}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] uppercase tracking-[0.07em] text-text-secondary">Domains</span>
                    <span className="text-[11px] text-text-primary">{state.domains.join(', ')}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-2">
              {(state.phase === 'idle' || state.phase === 'quoting') && (
                <button
                  onClick={handleGetQuote}
                  disabled={!canGetQuote}
                  className="px-4 py-2 bg-brand-green-operator text-white rounded-[6px] text-[12px] font-medium hover:bg-brand-green-operator/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Get quote
                </button>
              )}

              {(state.phase === 'quoted' || state.phase === 'ordering') && (
                <>
                  <button
                    onClick={handlePlaceOrder}
                    disabled={isWorking || !instantlyApiActive || !state.orderIsValid}
                    title={!instantlyApiActive ? 'Enable instantly_api_active flag to place real orders' : undefined}
                    className="px-4 py-2 bg-brand-green-operator text-white rounded-[6px] text-[12px] font-medium hover:bg-brand-green-operator/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Confirm and place real order
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

              {isWorking && (
                <p className="text-[11px] text-text-secondary">
                  {state.phase === 'quoting' ? 'Getting quote from Instantly…' : 'Placing order…'}
                </p>
              )}
            </div>

            {/* Disabled confirm explanation */}
            {state.phase === 'quoted' && !instantlyApiActive && (
              <p className="text-[11px] text-[#92400E]">
                The confirm button is disabled. Set instantly_api_active=true in integrations_registry to enable real orders.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
