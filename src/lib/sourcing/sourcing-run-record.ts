// The sourcing run record: created before the first prospect is written, closed once.
//
// WHY THIS IS A MODULE AND NOT INLINE IN THE ORCHESTRATOR. The orchestrator has seven exit
// paths that reach agent_runs, and every one of them writes its own insert by hand. Adding
// a second record with the same shape inline would double that, and the first terminal
// write has to win on both. One place, one set of columns.
//
// SHAPED AFTER startAgentRun, deliberately, including the first-terminal-write-wins guard.
// That guard exists because complete() and fail() once wrote DISJOINT column sets on the
// same agent_runs row and produced a row asserting success while carrying its own failure
// message. The same two writers exist here, so the same race does.
//
// THE RECORD IS CREATED BEFORE THE ICP IS READ. It could be created later, after the ICP
// gives it an icp_document_id, and then a run that failed on a missing or NULL filter spec
// would leave no record at all. Nine runs failed that way on 2026-08-09 and those are
// exactly the ones worth being able to see. So it is created first and the ICP is attached
// when it is known.

import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import { logger } from '@/lib/logger'

export interface SourcingRunCounts {
  candidates_returned: number
  prospects_written: number
  /**
   * How many were already known, keyed by dedupe verdict.
   *
   * DERIVED FROM THE VERDICT COUNTS, never hand-listed. A fifth verdict must not be able to
   * exist upstream and silently have nowhere to land here. See the jsonb column's comment
   * in the migration.
   */
  dropped_by_reason: Record<string, number>
}

export interface SourcingRunHandle {
  /** NULL when the insert failed. Callers must tolerate it; see startSourcingRun. */
  run_id: string | null
  attachIcpDocument: (icp_document_id: string) => Promise<void>
  complete: (counts: SourcingRunCounts) => Promise<void>
  fail: (error_message: string, counts?: Partial<SourcingRunCounts>) => Promise<void>
}

/** A handle that does nothing, for when the record could not be created. */
function inertHandle(): SourcingRunHandle {
  return {
    run_id: null,
    attachIcpDocument: async () => {},
    complete: async () => {},
    fail: async () => {},
  }
}

export async function startSourcingRun({
  supabase,
  organisation_id,
  target_batch_size,
  trigger_type,
  created_by,
  agent_run_id,
}: {
  supabase: ServiceRoleClient
  organisation_id: string
  target_batch_size: number
  trigger_type: string
  created_by?: string | null
  agent_run_id?: string | null
}): Promise<SourcingRunHandle> {
  const { data, error } = await supabase
    .from('sourcing_runs')
    .insert({
      organisation_id,
      status: 'running',
      target_batch_size,
      trigger_type,
      created_by: created_by ?? null,
      // startAgentRun returns the string 'unknown' rather than throwing when its own insert
      // fails, and that is not a uuid. Storing it would violate the foreign key and take the
      // whole sourcing run down over a logging failure.
      agent_run_id: agent_run_id && agent_run_id !== 'unknown' ? agent_run_id : null,
    })
    .select('id')
    .single()

  if (error || !data) {
    // FAIL SOFT, LOUDLY. A sourcing run spends vendor credits; refusing to run it because a
    // record could not be created would turn a bookkeeping failure into a lost batch. The
    // prospects are then written with a NULL run id and show as unattributed, which is a
    // visible state on the screen rather than a silent one.
    logger.error('startSourcingRun: could not create the run record, continuing unattributed', {
      organisation_id,
      error: error?.message,
    })
    return inertHandle()
  }

  const run_id = data.id as string

  // Set SYNCHRONOUSLY before any await, so exactly one caller passes it whatever the
  // interleaving. Clearing a timer first narrows this race; it does not remove it.
  let terminal: 'completed' | 'failed' | null = null

  function claimTerminal(next: 'completed' | 'failed', detail: string): boolean {
    if (terminal !== null) {
      logger.warn('sourcing-run-record: ignoring second terminal write', {
        run_id,
        organisation_id,
        already: terminal,
        attempted: next,
        attempted_detail: detail,
      })
      return false
    }
    terminal = next
    return true
  }

  async function write(patch: Record<string, unknown>, label: string) {
    const { error: updateError } = await supabase
      .from('sourcing_runs')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', run_id)
    if (updateError) {
      logger.error(`sourcing-run-record.${label}: update failed`, {
        run_id,
        organisation_id,
        error: updateError.message,
      })
    }
  }

  return {
    run_id,

    attachIcpDocument: async (icp_document_id: string) => {
      await write({ icp_document_id }, 'attachIcpDocument')
    },

    complete: async (counts: SourcingRunCounts) => {
      if (!claimTerminal('completed', `written ${counts.prospects_written}`)) return
      await write(
        {
          status: 'completed',
          completed_at: new Date().toISOString(),
          candidates_returned: counts.candidates_returned,
          prospects_written: counts.prospects_written,
          dropped_by_reason: counts.dropped_by_reason,
          // Written explicitly, not left alone, so a completed run cannot carry a stale
          // failure message from any other writer.
          error_message: null,
        },
        'complete',
      )
    },

    fail: async (error_message: string, counts?: Partial<SourcingRunCounts>) => {
      if (!claimTerminal('failed', error_message)) return
      // A failure keeps whatever counts it reached. A run that returned 25 candidates and
      // then died on the write loop having inserted 12 of them really did write 12, and
      // those 12 rows point at this record. Zeroing them here would make the record
      // disagree with the rows that reference it.
      await write(
        {
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message,
          ...(counts?.candidates_returned !== undefined
            ? { candidates_returned: counts.candidates_returned } : {}),
          ...(counts?.prospects_written !== undefined
            ? { prospects_written: counts.prospects_written } : {}),
          ...(counts?.dropped_by_reason !== undefined
            ? { dropped_by_reason: counts.dropped_by_reason } : {}),
        },
        'fail',
      )
    },
  }
}
