import Link from 'next/link'

interface WaitingItem {
  type: 'suggestion' | 'revision' | 'approval'
  id: string
  title: string
  description?: string
  href: string
}

interface WaitingOnYouBlockProps {
  items: WaitingItem[]
}

export function WaitingOnYouBlock({ items }: WaitingOnYouBlockProps) {
  if (items.length === 0) {
    return (
      <div className="bg-surface-card border border-border-card rounded-[10px] p-6">
        <p className="text-[13px] font-medium text-text-primary mb-1">All caught up</p>
        <p className="text-xs text-text-secondary">No pending actions required from you.</p>
      </div>
    )
  }

  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] overflow-hidden">
      <div className="px-6 py-4 border-b border-border-card bg-surface-shell">
        <h3 className="text-[13px] font-medium text-text-primary">Waiting on you</h3>
        <p className="text-[11px] text-text-secondary mt-1">{items.length} item{items.length === 1 ? '' : 's'} requiring action</p>
      </div>
      <div className="divide-y divide-border-card">
        {items.map(item => (
          <Link
            key={item.id}
            href={item.href}
            className="block px-6 py-3 hover:bg-surface-shell transition-colors group"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-[12px] font-medium text-text-primary group-hover:text-brand-blue transition-colors">
                  {item.title}
                </p>
                {item.description && (
                  <p className="text-[11px] text-text-secondary mt-0.5 line-clamp-2">
                    {item.description}
                  </p>
                )}
              </div>
              <svg className="w-4 h-4 text-text-secondary shrink-0 mt-0.5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
