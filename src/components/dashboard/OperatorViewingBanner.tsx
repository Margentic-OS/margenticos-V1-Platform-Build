'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ClientSwitcher } from './ClientSwitcher'

interface OperatorViewingBannerProps {
  clients: { id: string; name: string }[]
}

export function OperatorViewingBanner({ clients }: OperatorViewingBannerProps) {
  const searchParams = useSearchParams()
  const clientParam = searchParams.get('client')
  const match = clientParam ? clients.find(c => c.id === clientParam) : null

  return (
    <div className="flex items-center justify-between px-7 py-2 bg-[#FEF7E6] border-b border-[#F0D080] shrink-0">
      <div className="flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-brand-amber shrink-0" />

        {match ? (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-[#7A4800]">You are viewing</span>
            <ClientSwitcher
              clients={clients}
              currentClientId={clientParam}
              buttonClassName="text-[11px] font-medium text-[#7A4800] hover:underline inline-flex items-center gap-1"
            />
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
