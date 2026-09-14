'use client'

// The two buttons, and the honest reporting of what happened to the answer.
//
// IT NEVER THANKS ANYBODY FOR AN ANSWER THAT WAS NOT WRITTEN. The old confirm route told a
// client "Meeting confirmation already recorded" while writing nothing at all, because a
// client's update matched zero rows under RLS. The route now says plainly whether it
// recorded the answer, in a `recorded` field, and this component shows the route's own
// message rather than assuming success from an HTTP 200.

import { useState } from 'react'

type Decision = 'held' | 'no_show'

interface ConfirmMeetingButtonsProps {
  token: string
  /** Which button the client pressed in the email. A hint for highlighting, never an action. */
  hint: Decision | null
}

export function ConfirmMeetingButtons({ token, hint }: ConfirmMeetingButtonsProps) {
  const [sending, setSending] = useState<Decision | null>(null)
  const [answer, setAnswer] = useState<{ recorded: boolean; message: string } | null>(null)

  async function send(decision: Decision) {
    setSending(decision)
    try {
      const response = await fetch('/api/meetings/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, decision }),
      })
      const body = await response.json()
      setAnswer({
        recorded: body.recorded === true,
        message: String(body.message ?? 'We could not tell whether that was recorded. Please reply to the email.'),
      })
    } catch {
      setAnswer({
        recorded: false,
        message: 'Your answer did not reach us, so nothing was recorded. Please try again, or just reply to the email.',
      })
    } finally {
      setSending(null)
    }
  }

  if (answer) {
    return (
      <div
        className={`rounded-[6px] px-4 py-3 border ${
          answer.recorded
            ? 'bg-[#EAF3DE] border-[#3B6D11]'
            : 'bg-[#FDF0EE] border-[#7A2E2E]'
        }`}
      >
        <p className={`text-[14px] ${answer.recorded ? 'text-[#1A1916]' : 'text-[#7A2E2E]'}`}>
          {answer.message}
        </p>
        {!answer.recorded && (
          <p className="text-[13px] text-[#4A4A4A] mt-2">
            Nothing has changed at our end. Replying to the email reaches a person.
          </p>
        )}
      </div>
    )
  }

  const emphasis = 'ring-2 ring-brand-amber'

  return (
    <div className="flex flex-wrap gap-3">
      <button
        onClick={() => send('held')}
        disabled={sending !== null}
        className={`px-5 py-2.5 rounded-[6px] text-[14px] font-medium bg-brand-green-operator text-[#F5F0E8] hover:opacity-90 disabled:opacity-50 ${hint === 'held' ? emphasis : ''}`}
      >
        {sending === 'held' ? 'Recording...' : 'It happened'}
      </button>
      <button
        onClick={() => send('no_show')}
        disabled={sending !== null}
        className={`px-5 py-2.5 rounded-[6px] text-[14px] font-medium bg-white border border-[#E8E2D8] text-[#1A1916] hover:bg-[#F5F0E8] disabled:opacity-50 ${hint === 'no_show' ? emphasis : ''}`}
      >
        {sending === 'no_show' ? 'Recording...' : 'It did not happen'}
      </button>
    </div>
  )
}
