'use client'

export function OperatorRepliesSkeleton() {
  return (
    <div className="px-7 py-6">
      <div className="space-y-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="bg-white border border-[#E8E2D8] rounded-[10px] p-5 animate-pulse"
          >
            <div className="flex items-start justify-between gap-4 mb-3">
              <div className="flex-1">
                <div className="h-3 bg-secondary-text/10 rounded w-32 mb-2" />
                <div className="h-2.5 bg-secondary-text/10 rounded w-24" />
              </div>
              <div className="flex gap-2">
                <div className="h-6 bg-light-green/30 rounded w-28 shrink-0" />
              </div>
            </div>
            <div className="space-y-2 mb-3">
              <div className="h-2.5 bg-secondary-text/10 rounded w-full" />
              <div className="h-2.5 bg-secondary-text/10 rounded w-5/6" />
            </div>
            <div className="flex justify-between">
              <div className="h-2 bg-secondary-text/10 rounded w-16" />
              <div className="h-2 bg-secondary-text/10 rounded w-20" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
