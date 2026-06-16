'use client'

export function RepliesEmptyState() {
  return (
    <div className="bg-white border border-[#E8E2D8] rounded-[10px] p-8 text-center">
      <p className="text-[13px] text-primary-text mb-1">
        No replies yet
      </p>
      <p className="text-[12px] text-secondary-text">
        Replies from interested prospects will appear here once your campaigns launch.
      </p>
    </div>
  )
}
