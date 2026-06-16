'use client'

export function OperatorRepliesEmptyState({ clientName }: { clientName: string }) {
  return (
    <div className="px-7 py-6">
      <div className="bg-white border border-[#E8E2D8] rounded-[10px] p-8 text-center">
        <p className="text-[13px] text-primary-text mb-1">
          No replies yet for {clientName}
        </p>
        <p className="text-[12px] text-secondary-text">
          Replies will appear here once their campaigns have sent to prospects.
        </p>
      </div>
    </div>
  )
}
