// What we actually sent, written down.
//
// TWO WRITES, ONE PURPOSE, AND THEY ARE DELIBERATELY NOT THE SAME SHAPE.
//
//   sent_sequences   APPEND-ONLY. One row per composition that reached the sending tool.
//                    A prospect can be composed more than once, because a failed upload
//                    reclaims it to 'pending' and it is composed again, so a column set
//                    would overwrite the record of what went out the first time, which is
//                    the thing being kept.
//
//   prospects.followup_arm / followup_mode
//                    THE CURRENT STATE, overwritten, because that is what a query asking
//                    "which arm is this prospect in" wants to read without joining.
//
// Both are written here rather than in composeSequence, because composeSequence is called
// by the judge loop and by diagnostics on copy that may never ship, and a record of a send
// must only exist for something actually handed over.

import type { getComposeServiceClient, ComposedSequence } from './compose-sequence'
import { logger } from '@/lib/logger'

type ServiceClient = ReturnType<typeof getComposeServiceClient>

/**
 * Record one composed sequence against its prospect.
 *
 * THE MODE COLUMNS AND THE ROW ARE WRITTEN FROM THE SAME OBJECT, in one call, so they
 * cannot disagree about which arm a prospect was in or what it received. Two call sites
 * writing the same two facts is the parallel-lists shape, and the failure would be a
 * prospect whose row says one thing and whose table row says another, with no way to tell
 * which was right.
 */
export async function recordSentSequence(
  supabase: ServiceClient,
  organisationId: string,
  prospectId: string,
  composed: ComposedSequence,
): Promise<void> {
  const { followups } = composed

  const { error: insertError } = await supabase.from('sent_sequences').insert({
    organisation_id: organisationId,
    prospect_id: prospectId,
    variant_id: composed.variant_id,
    messaging_doc_id: composed.messaging_doc_id,
    followup_arm: followups.arm,
    followup_mode: followups.mode,
    // The bodies exactly as handed over: footer appended, merge tag NOT resolved, because
    // that is the form composition produces and the form a later reader can re-render.
    // Resolving it here would bake one prospect's name into a record of the copy.
    emails: composed.emails.map(e => ({
      position: e.sequence_position,
      subject: e.subject_line ?? null,
      body: e.body,
    })),
    email1_fingerprint: followups.email1_fingerprint,
  })

  if (insertError) {
    // Thrown, not swallowed. The CALLER decides that a missing diagnostic row must not
    // stop a send; that decision belongs at the call site where the trade-off is visible,
    // not buried in a helper where a future caller would inherit it without knowing.
    throw new Error(`sent_sequences insert failed: ${insertError.message}`)
  }

  const { error: updateError } = await supabase
    .from('prospects')
    .update({ followup_arm: followups.arm, followup_mode: followups.mode })
    .eq('id', prospectId)
    .eq('organisation_id', organisationId)

  if (updateError) {
    // The row landed and the columns did not. Worth a distinct message: the send record
    // exists and is authoritative, and the columns can be rebuilt from it.
    logger.warn('record-sent-sequence: the sequence was recorded but the mode columns were not', {
      prospect_id: prospectId,
      error: updateError.message,
    })
  }
}
