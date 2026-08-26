'use client'

import type { OperatorReply } from '@/lib/reply-handling/get-operator-replies'
import { OperatorReplyCard } from './OperatorReplyCard'

// Padding lives on the view now, because the list renders once per intent group and each
// group would otherwise indent again inside its own heading.
export function OperatorRepliesList({ replies }: { replies: OperatorReply[] }) {
  return (
    <div className="space-y-3">
      {replies.map((reply) => (
        <OperatorReplyCard key={reply.id} reply={reply} />
      ))}
    </div>
  )
}
