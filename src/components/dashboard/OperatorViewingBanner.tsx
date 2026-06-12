'use client'

import Link from 'next/link'
import { useSearchParams, usePathname } from 'next/navigation'
import { useState } from 'react'

interface OperatorViewingBannerProps {
  clients: { id: string; name: string }[]
}

export function OperatorViewingBanner({ clients }: OperatorViewingBannerProps) {
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const clientParam = searchParams.get('client')
  const match = clientParam ? clients.find(c => c.id === clientParam) : null
  const [isOpen, setIsOpen] = useState(false)

  // Build current URL query string to preserve other params
  const buildClientUrl = (clientId: string) => {
    const params = new URLSearchParams(searchParams)
    params.set('client', clientId)
    return `${pathname}?${params.toString()}`
  }

  return (
    <div className="flex items-center justify-between px-7 py-2 bg-[#FEF7E6] border-b border-[#F0D080] shrink-0">
      <div className="flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-brand-amber shrink-0" />

        {match ? (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-[#7A4800]">You are viewing</span>
            <div className="relative">
              <button
                onClick={() => setIsOpen(!isOpen)}
                className="text-[11px] font-medium text-[#7A4800] hover:underline inline-flex items-center gap-1"
              >
                {match.name}
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                </svg>
              </button>

              {isOpen && clients.length > 1 && (
                <div className="absolute top-full mt-1 left-0 bg-white border border-border-card rounded-[6px] shadow-sm min-w-[180px] z-10">
                  {clients.map(client => (
                    <Link
                      key={client.id}
                      href={buildClientUrl(client.id)}
                      onClick={() => setIsOpen(false)}
                      className={`block px-3 py-2 text-[11px] border-b border-border-card last:border-0 hover:bg-surface-shell transition-colors ${
                        client.id === clientParam ? 'bg-surface-shell font-medium text-brand-amber' : 'text-text-primary'
                      }`}
                    >
                      {client.name}
                    </Link>
                  ))}
                </div>
              )}
            </div>
            <span className="text-[11px] text-[#7A4800]">'s dashboard</span>
          </div>
        ) : (
          <span className="text-[11px] text-[#7A4800]">
            You are viewing the client experience
          </span>
        )}
      </div>
      <Link
        href="/dashboard/operator"
        className="text-[11px] font-medium text-[#7A4800] hover:underline"
      >
        Return to operator view →
      </Link>
    </div>
  )
}
