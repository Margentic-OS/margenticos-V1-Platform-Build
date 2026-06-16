'use client'

import type { ClientVisibleReply } from '@/lib/reply-handling/get-client-visible-replies'
import { RepliesList } from './RepliesList'
import { RepliesEmptyState } from './RepliesEmptyState'

export function ClientRepliesView({ replies }: { replies: ClientVisibleReply[] }) {
  if (replies.length === 0) {
    return <RepliesEmptyState />
  }

  return <RepliesList replies={replies} />
}
