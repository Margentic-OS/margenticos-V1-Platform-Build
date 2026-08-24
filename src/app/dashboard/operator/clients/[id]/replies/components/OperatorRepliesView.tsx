'use client'

import type { OperatorVisibleReply } from '@/lib/reply-handling/get-client-visible-replies'
import { OperatorRepliesList } from './OperatorRepliesList'
import { OperatorRepliesEmptyState } from './OperatorRepliesEmptyState'

export function OperatorRepliesView({
  replies,
  clientName,
}: {
  replies: OperatorVisibleReply[]
  clientName: string
}) {
  if (replies.length === 0) {
    return <OperatorRepliesEmptyState clientName={clientName} />
  }

  return <OperatorRepliesList replies={replies} />
}
