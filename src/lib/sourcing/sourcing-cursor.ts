// Reading and advancing a client's position in the provider result set.
//
// See supabase/migrations/20260915220000_sourcing_cursor_per_client.sql for the measurement
// that motivated this, and src/lib/sourcing/record-position.ts for the arithmetic.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE OFFSET COUNTS RECORDS READ, NOT PROSPECTS WRITTEN
//
// This is the distinction that makes the cursor work, and getting it wrong would be silent.
//
// The handler applies post-filters AFTER fetching: rows without an email, excluded job
// titles, excluded company keywords. On the 2026-09-15 runs those dropped 6 of 30 records in
// the first run alone. Dedupe then drops more, later, in the orchestrator.
//
// So three different numbers describe one run:
//
//     records READ       what the provider handed over. The cursor advances by this.
//     candidates KEPT    survivors of the handler's post-filters.
//     prospects WRITTEN  survivors of dedupe.
//
// An offset advanced by anything but the first would re-read the dropped records on every
// subsequent run, forever, and each re-read would be dropped again for the same reason. The
// cursor would crawl while appearing to move.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

export interface SourcingCursor {
  /** 0-based count of provider records already consumed for this client. */
  recordOffset: number
  /** The ICP document the offset indexes against, or null when never set. */
  icpDocumentId: string | null
  /**
   * True when the stored offset was discarded because the ICP changed.
   *
   * Surfaced rather than silently handled: a reset means this client starts reading from
   * the top again, and a reader looking at a run that suddenly produced duplicates should
   * be able to see why in one log line.
   */
  wasReset: boolean
}

/**
 * Where this client's next run should start.
 *
 * ── A MISSING ROW AND A FAILED READ ARE NOT THE SAME THING ──
 *
 * No row means this client has never been sourced with a cursor, and 0 is the right answer.
 * A read ERROR means the position is UNKNOWN, and 0 is then the most expensive possible
 * guess: it silently re-reads from the top and hands the whole problem back to dedupe, which
 * is the behaviour this module exists to remove. So a failed read throws.
 *
 * This is the same shape as the verification trigger's daily-budget read, which refuses to
 * run when the usage count cannot be read rather than assuming zero used.
 */
export async function readCursor(
  supabase: SupabaseClient,
  organisationId: string,
  icpDocumentId: string | null,
): Promise<SourcingCursor> {
  const { data, error } = await supabase
    .from('sourcing_cursors')
    .select('record_offset, icp_document_id')
    .eq('organisation_id', organisationId)
    .maybeSingle()

  if (error) {
    throw new Error(
      `Sourcing cursor could not be read for organisation ${organisationId}: ${error.message}. ` +
      'Refusing to start from zero, because that would silently re-read the whole result set.',
    )
  }

  if (!data) {
    return { recordOffset: 0, icpDocumentId, wasReset: false }
  }

  const storedOffset = typeof data.record_offset === 'number' ? data.record_offset : 0
  const storedDocument = (data.icp_document_id as string | null) ?? null

  // AN ICP CHANGE INVALIDATES THE POSITION. The offset indexes into one result set, and a new
  // spec is a different query, so carrying it over would skip the first N records of a set
  // nobody has read. Only reset when BOTH sides are known: a null on either side means we
  // cannot tell whether the query changed, and resetting on "don't know" would quietly
  // restart a client at the top.
  if (storedDocument !== null && icpDocumentId !== null && storedDocument !== icpDocumentId) {
    logger.info('sourcing cursor: ICP changed, position reset', {
      organisation_id: organisationId,
      previous_offset: storedOffset,
      previous_icp_document_id: storedDocument,
      new_icp_document_id: icpDocumentId,
      consequence: 'This run reads from the start of the new result set.',
    })
    return { recordOffset: 0, icpDocumentId, wasReset: true }
  }

  return { recordOffset: storedOffset, icpDocumentId: storedDocument ?? icpDocumentId, wasReset: false }
}

/**
 * Record where this run finished.
 *
 * `recordsRead` is what the provider actually handed over, so the new offset is
 * `startOffset + recordsRead`. A run that read nothing leaves the offset where it was.
 *
 * A FAILED WRITE IS LOGGED AT ERROR AND DOES NOT THROW. The prospects are already written by
 * the time this runs, and throwing here would fail a run that succeeded. The cost of a lost
 * write is one repeated window on the next run, which dedupe absorbs. That is the correct
 * trade only because dedupe is still there, which is the other half of why it stays.
 */
export async function advanceCursor(
  supabase: SupabaseClient,
  organisationId: string,
  icpDocumentId: string | null,
  startOffset: number,
  recordsRead: number,
): Promise<number> {
  const newOffset = startOffset + Math.max(0, recordsRead)

  const { error } = await supabase
    .from('sourcing_cursors')
    .upsert(
      {
        organisation_id: organisationId,
        icp_document_id: icpDocumentId,
        record_offset: newOffset,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organisation_id' },
    )

  if (error) {
    logger.error('sourcing cursor: could not record the new position', {
      organisation_id: organisationId,
      start_offset: startOffset,
      records_read: recordsRead,
      attempted_offset: newOffset,
      error: error.message,
      consequence:
        'The next run repeats this window. Dedupe absorbs it, so no prospect is duplicated, ' +
        'but the run produces nothing new.',
    })
    return startOffset
  }

  logger.info('sourcing cursor: position advanced', {
    organisation_id: organisationId,
    from_offset: startOffset,
    records_read: recordsRead,
    to_offset: newOffset,
  })

  return newOffset
}
