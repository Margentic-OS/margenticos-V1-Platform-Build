'use client'

import type { ClientVisibleReply } from '@/lib/reply-handling/get-client-visible-replies'
import { ReplyCard } from './ReplyCard'

export function RepliesList({ replies }: { replies: ClientVisibleReply[] }) {
  return (
    <div className="space-y-3">
      {replies.map((reply) => (
        <ReplyCard key={reply.id} reply={reply} />
      ))}
    </div>
  )
}
