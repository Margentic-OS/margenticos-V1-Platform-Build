'use client'

import type { OperatorVisibleReply } from '@/lib/reply-handling/get-client-visible-replies'
import { OperatorReplyCard } from './OperatorReplyCard'

export function OperatorRepliesList({ replies }: { replies: OperatorVisibleReply[] }) {
  return (
    <div className="px-7 py-6">
      <div className="space-y-3">
        {replies.map((reply) => (
          <OperatorReplyCard key={reply.id} reply={reply} />
        ))}
      </div>
    </div>
  )
}
