'use client'

export function ClientRepliesSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="bg-white border border-[#E8E2D8] rounded-[10px] p-5 animate-pulse"
        >
          <div className="flex items-start justify-between gap-4 mb-3">
            <div className="flex-1">
              <div className="h-3 bg-secondary-text/10 rounded w-32 mb-2" />
              <div className="h-2.5 bg-secondary-text/10 rounded w-24" />
            </div>
            <div className="h-6 bg-light-green/30 rounded w-24 shrink-0" />
          </div>
          <div className="space-y-2 mb-3">
            <div className="h-2.5 bg-secondary-text/10 rounded w-full" />
            <div className="h-2.5 bg-secondary-text/10 rounded w-5/6" />
          </div>
          <div className="h-2 bg-secondary-text/10 rounded w-16" />
        </div>
      ))}
    </div>
  )
}
