'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useState } from 'react'

interface ClientSwitcherProps {
  clients: { id: string; name: string }[]
  currentClientId: string | null
  className?: string
  buttonClassName?: string
}

export function ClientSwitcher({
  clients,
  currentClientId,
  className,
  buttonClassName,
}: ClientSwitcherProps) {
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const [isOpen, setIsOpen] = useState(false)

  if (!currentClientId || clients.length === 0) {
    return null
  }

  const currentClient = clients.find(c => c.id === currentClientId)
  if (!currentClient) return null

  const buildClientUrl = (clientId: string) => {
    const params = new URLSearchParams(searchParams)
    params.set('client', clientId)
    return `${pathname}?${params.toString()}`
  }

  return (
    <div className={className}>
      <div className="relative">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className={buttonClassName}
        >
          {currentClient.name}
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
                  client.id === currentClientId ? 'bg-surface-shell font-medium text-brand-amber' : 'text-text-primary'
                }`}
              >
                {client.name}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
