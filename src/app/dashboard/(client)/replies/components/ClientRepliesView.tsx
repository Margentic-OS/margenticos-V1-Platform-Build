'use client'

import type { ClientVisibleReply } from '@/lib/reply-handling/get-client-visible-replies'
import { RepliesList } from './RepliesList'
import { RepliesEmptyState } from './RepliesEmptyState'

export function ClientRepliesView({
  replies,
  outreachStarted,
}: {
  replies: ClientVisibleReply[]
  outreachStarted: boolean
}) {
  if (replies.length === 0) {
    return <RepliesEmptyState outreachStarted={outreachStarted} />
  }

  return <RepliesList replies={replies} />
}
