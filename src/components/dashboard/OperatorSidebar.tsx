'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'

export interface ClientOrg {
  id: string
  name: string
  pipeline_unlocked: boolean
}

interface OperatorSidebarProps {
  clients: ClientOrg[]
}

const NAV_RESULTS = [
  { label: 'Pipeline', href: '/dashboard/pipeline' },
  { label: 'Campaigns', href: '/dashboard/campaigns' },
  { label: 'Benchmarks', href: '/dashboard/benchmarks' },
  { label: 'Approvals', href: '/dashboard/approvals' },
]

const NAV_STRATEGY = [
  { label: 'Prospect profile', href: '/dashboard/strategy/icp' },
  { label: 'Positioning', href: '/dashboard/strategy/positioning' },
  { label: 'Voice guide', href: '/dashboard/strategy/tov' },
  { label: 'Messaging', href: '/dashboard/strategy/messaging' },
]

const NAV_OPERATOR = [
  { label: 'All clients', href: '/dashboard/operator' },
  { label: 'Agent activity', href: '/dashboard/operator/activity' },
  { label: 'Signals log', href: '/dashboard/operator/signals' },
  { label: 'Settings', href: '/dashboard/operator/settings' },
]

function clientStatus(client: ClientOrg): 'active' | 'setup' {
  return client.pipeline_unlocked ? 'active' : 'setup'
}

export function OperatorSidebar({ clients }: OperatorSidebarProps) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const router = useRouter()
  const [dropdownOpen, setDropdownOpen] = useState(false)

  const selectedId = searchParams.get('client') ?? clients[0]?.id ?? null
  const selectedClient = clients.find(c => c.id === selectedId) ?? clients[0] ?? null

  function isActive(href: string) {
    if (href === '/dashboard/operator') return pathname === '/dashboard/operator'
    return pathname.startsWith(href)
  }

  function selectClient(id: string) {
    setDropdownOpen(false)
    const params = new URLSearchParams(searchParams.toString())
    params.set('client', id)
    router.push(`${pathname}?${params.toString()}`)
  }

  return (
    <aside className="w-[210px] min-h-screen bg-brand-green-operator flex flex-col shrink-0 print:hidden">
      {/* Wordmark */}
      <div className="px-5 pt-6 pb-4">
        <span className="text-[#F5F0E8] text-[15px] font-medium tracking-[-0.01em]">
          MargenticOS
        </span>
      </div>

      {/* Operator mode badge */}
      <div className="px-5 pb-4">
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#FEF7E6] border border-[#F0D080]">
          <span className="w-1.5 h-1.5 rounded-full bg-brand-amber shrink-0" />
          <span className="text-[10px] font-medium text-[#7A4800]">Operator mode</span>
        </div>
      </div>

      {/* Client selector */}
      <div className="px-5 pb-5 relative">
        <p className="text-[8px] font-normal uppercase tracking-[0.09em] text-[rgba(245,240,232,0.28)] mb-[4px]">
          Viewing
        </p>
        <button
          onClick={() => setDropdownOpen(!dropdownOpen)}
          className="w-full flex items-center justify-between text-left bg-[rgba(245,240,232,0.06)] hover:bg-[rgba(245,240,232,0.09)] border border-[rgba(245,240,232,0.10)] rounded-[6px] px-2.5 py-1.5 transition-colors"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-green-accent shrink-0" />
            <span className="text-[12px] font-medium text-[#F5F0E8] truncate">
              {selectedClient?.name ?? 'All clients'}
            </span>
          </div>
          <svg
            width="10" height="6" viewBox="0 0 10 6" fill="none"
            className={`shrink-0 ml-1.5 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`}
          >
            <path
              d="M1 1L5 5L9 1"
              stroke="rgba(245,240,232,0.40)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {dropdownOpen && clients.length > 0 && (
          <div className="absolute left-5 right-5 top-full z-50 mt-1 bg-[#223322] border border-[rgba(245,240,232,0.10)] rounded-[8px] shadow-lg overflow-hidden">
            {clients.map((client) => (
              <button
                key={client.id}
                onClick={() => selectClient(client.id)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[rgba(245,240,232,0.06)] transition-colors"
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  client.id === selectedClient?.id
                    ? 'bg-brand-green-accent'
                    : 'bg-[rgba(245,240,232,0.20)]'
                }`} />
                <span className={`text-[12px] truncate ${
                  client.id === selectedClient?.id
                    ? 'text-[#F5F0E8] font-medium'
                    : 'text-[rgba(245,240,232,0.60)]'
                }`}>
                  {client.name}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mx-5 border-t border-[rgba(245,240,232,0.08)] mb-5" />

      {/* Navigation */}
      <nav className="flex-1 px-3 overflow-y-auto">
        {/* Results */}
        <p className="px-2 mb-2 text-[8px] font-normal uppercase tracking-[0.09em] text-[rgba(245,240,232,0.28)]">
          Results
        </p>
        <ul className="space-y-0.5 mb-6">
          {NAV_RESULTS.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className={[
                  'flex items-center px-2 py-[6px] rounded-[6px] text-[12px] transition-colors',
                  isActive(item.href)
                    ? 'bg-[rgba(245,240,232,0.08)] border-l-2 border-brand-green-accent text-[#F5F0E8] font-medium'
                    : 'text-[rgba(245,240,232,0.50)] hover:bg-[rgba(245,240,232,0.04)] hover:text-[rgba(245,240,232,0.75)]',
                ].join(' ')}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>

        {/* Strategy */}
        <p className="px-2 mb-2 text-[8px] font-normal uppercase tracking-[0.09em] text-[rgba(245,240,232,0.28)]">
          Strategy
        </p>
        <ul className="space-y-0.5 mb-6">
          {NAV_STRATEGY.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className={[
                  'flex items-center px-2 py-[6px] rounded-[6px] text-[12px] transition-colors',
                  isActive(item.href)
                    ? 'bg-[rgba(245,240,232,0.08)] border-l-2 border-brand-green-accent text-[#F5F0E8] font-medium'
                    : 'text-[rgba(245,240,232,0.50)] hover:bg-[rgba(245,240,232,0.04)] hover:text-[rgba(245,240,232,0.75)]',
                ].join(' ')}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>

        {/* Operator only — amber-tinted to visually distinguish from client nav */}
        <p className="px-2 mb-2 text-[8px] font-normal uppercase tracking-[0.09em] text-brand-amber opacity-60">
          Operator only
        </p>
        <ul className="space-y-0.5">
          {NAV_OPERATOR.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className={[
                  'flex items-center px-2 py-[6px] rounded-[6px] text-[12px] transition-colors',
                  isActive(item.href)
                    ? 'bg-[rgba(239,159,39,0.10)] border-l-2 border-brand-amber text-brand-amber font-medium'
                    : 'text-brand-amber opacity-60 hover:opacity-100 hover:bg-[rgba(239,159,39,0.07)]',
                ].join(' ')}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {/* Compact client list */}
      <div className="px-5 py-5 border-t border-[rgba(245,240,232,0.08)]">
        <p className="text-[8px] font-normal uppercase tracking-[0.09em] text-[rgba(245,240,232,0.28)] mb-3">
          All clients
        </p>
        {clients.length === 0 ? (
          <p className="text-[11px] text-[rgba(245,240,232,0.28)] leading-relaxed">
            No clients yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {clients.slice(0, 5).map((client) => {
              const status = clientStatus(client)
              return (
                <li key={client.id}>
                  <button
                    onClick={() => selectClient(client.id)}
                    className="w-full flex items-center gap-2 text-left hover:bg-[rgba(245,240,232,0.04)] rounded-[4px] px-1 py-0.5 transition-colors"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      status === 'active'
                        ? 'bg-brand-green-success'
                        : 'bg-[rgba(245,240,232,0.28)]'
                    }`} />
                    <span className="text-[11px] text-[rgba(245,240,232,0.60)] truncate flex-1">
                      {client.name}
                    </span>
                    <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-[4px] shrink-0 ${
                      status === 'active'
                        ? 'text-brand-green-success bg-[rgba(59,109,17,0.15)]'
                        : 'text-[rgba(245,240,232,0.40)] bg-[rgba(245,240,232,0.06)]'
                    }`}>
                      {status === 'active' ? 'Live' : 'Setup'}
                    </span>
                  </button>
                </li>
              )
            })}
            {clients.length > 5 && (
              <li className="text-[10px] text-[rgba(245,240,232,0.28)] px-1">
                +{clients.length - 5} more
              </li>
            )}
          </ul>
        )}
      </div>
    </aside>
  )
}
