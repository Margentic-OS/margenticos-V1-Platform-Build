// A RELATIVE TIME WORD IS CHECKED AGAINST THE DAY IT SENDS, NOT THE DAY IT WAS WRITTEN.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THE WRITING-TIME CHECK IS NOT ENOUGH. findRelativeTimeFaults already runs while the
// copy is being written, and it is correct there. The problem is that nothing sends at
// writing time:
//
//   email 1 goes out on the day of upload
//   email 2 three days later
//   email 3 ten days later
//   email 4 seventeen days later
//
// Copy written on a Monday saying "this week" about an event two days earlier is true when
// written and false by the time email 3 sends. One prospect shipped "this week" about a
// conference that had already happened, which is the same fault one step further on.
//
// THE INTERVAL IS NOT OURS. The sending tool owns the cadence, so the offsets come from the
// same schedule the shell sync writes, read through sendDayOffset. A second copy of "when
// does email 3 go out" would be the parallel-list shape, and the copy that drifts is the one
// nothing sends against.
//
// REPORT ONLY, and deliberately. What to DO about a stale phrase at upload is a separate
// decision with real cost: replacing that position with the template loses a personalised
// email, and holding the prospect loses four. Neither should be chosen before the rate is
// known, and the rate cannot be known until this has watched an upload.

import { findRelativeTimeFaults, type RelativeTimeFault } from './relative-time'
import { splitIntoSentences } from './sentence-count'
import { sendDayOffset } from '@/lib/integrations/handlers/instantly/syncSequenceShell'

export interface UploadTimeFault extends RelativeTimeFault {
  /** 1-based email position the phrase sits in. */
  position: number
  /** Days after upload that this position sends. */
  sendsInDays: number
  /** True when the phrase is fine on the day of upload and wrong on the day it sends. */
  onlyWrongAtSendTime: boolean
}

export interface UploadTimeRelativeInput {
  /** The composed emails, as they will be handed to the sending tool. */
  emails: ReadonlyArray<{ sequence_position: number; body: string | null }>
  /** The dated findings, for deciding which event a sentence is about. */
  candidates: ReadonlyArray<{ date?: string | null; observation?: string | null }>
  /** When the upload happens. Email 1 sends on this day. */
  uploadedAt: Date
  /**
   * How many steps the SEQUENCE has. Defaults to 4, the approved sequence length.
   *
   * NOT emails.length. A caller may pass one email or three; how many it passes says nothing
   * about when step 3 goes out, and deriving the offsets from it returned an earlier send
   * date and a more lenient check. Caught by a test asserting the offset rather than the
   * verdict, which is why that assertion is there.
   */
  stepCount?: number
}

/**
 * Every relative time word that will be wrong on the day its email sends.
 *
 * BOTH CLOCKS ARE RUN, and the difference is the point. A phrase already wrong at upload is
 * a writing-time fault that got through; a phrase wrong ONLY at send time is the fault this
 * exists for, and mixing them would make the count unreadable. onlyWrongAtSendTime says
 * which is which.
 */
export function findUploadTimeRelativeFaults(input: UploadTimeRelativeInput): UploadTimeFault[] {
  const out: UploadTimeFault[] = []
  const stepCount = input.stepCount ?? 4

  for (const email of input.emails) {
    const body = email.body ?? ''
    if (!body.trim()) continue

    const sendsInDays = sendDayOffset(email.sequence_position, stepCount)
    const sendDate = new Date(input.uploadedAt.getTime() + sendsInDays * 24 * 60 * 60 * 1000)

    const atUpload = findRelativeTimeFaults(body, input.candidates, input.uploadedAt, splitIntoSentences)
    const atSend = findRelativeTimeFaults(body, input.candidates, sendDate, splitIntoSentences)

    const alreadyWrong = new Set(atUpload.map(f => `${f.phrase}|${f.sentence}`))
    for (const f of atSend) {
      out.push({
        ...f,
        position: email.sequence_position,
        sendsInDays,
        onlyWrongAtSendTime: !alreadyWrong.has(`${f.phrase}|${f.sentence}`),
      })
    }
  }
  return out
}
