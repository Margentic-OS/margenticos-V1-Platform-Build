'use client'

import type { OperatorRepliesForOrg } from '@/lib/reply-handling/get-operator-replies'
import { OperatorRepliesList } from './OperatorRepliesList'
import { OperatorRepliesEmptyState } from './OperatorRepliesEmptyState'

export function OperatorRepliesView({
  replies,
  clientName,
}: {
  replies: OperatorRepliesForOrg
  clientName: string
}) {
  if (replies.total === 0) {
    return <OperatorRepliesEmptyState clientName={clientName} />
  }

  const { total, hiddenFromClientCount, groups } = replies

  return (
    <div className="p-6">
      {/* The summary line the operator opens this page for. The hidden count is the
          number that says whether anything here needs attention: those replies exist
          in the product and appear on no client screen anywhere. */}
      <div className="bg-surface-card border border-border-card rounded-[10px] px-5 py-4 mb-5">
        <div className="flex items-baseline gap-6 flex-wrap">
          <div>
            <p className="text-[22px] font-medium text-primary-text leading-none">{total}</p>
            <p className="text-[11px] text-secondary-text mt-1">
              {total === 1 ? 'reply' : 'replies'} in total
            </p>
          </div>
          <div>
            <p className={[
              'text-[22px] font-medium leading-none',
              hiddenFromClientCount > 0 ? 'text-brand-amber' : 'text-primary-text',
            ].join(' ')}>
              {hiddenFromClientCount}
            </p>
            <p className="text-[11px] text-secondary-text mt-1">
              hidden from the client
            </p>
          </div>
          <div>
            <p className="text-[22px] font-medium text-primary-text leading-none">{groups.length}</p>
            <p className="text-[11px] text-secondary-text mt-1">
              {groups.length === 1 ? 'intent' : 'intents'}
            </p>
          </div>
        </div>
      </div>

      {/* One block per intent, each with its own count. */}
      <div className="space-y-6">
        {groups.map((group) => (
          <section key={group.intent}>
            <div className="flex items-center gap-2 mb-2.5">
              <h2 className="text-[13px] font-medium text-primary-text">{group.label}</h2>
              <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-[#F0ECE4] text-[11px] font-medium text-secondary-text">
                {group.count}
              </span>
              {!group.client_visible && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] bg-[rgba(239,159,39,0.12)] text-[10px] font-medium text-[#7A4800]">
                  Hidden from client
                </span>
              )}
            </div>
            <OperatorRepliesList replies={group.replies} />
          </section>
        ))}
      </div>
    </div>
  )
}
