// Agent run logger — call this at the start of every agent invocation.
// Writes to agent_runs via service role (no RLS INSERT policy for authenticated users).
// Usage:
//   const run = await startAgentRun({ organisation_id, agent_name })
//   // ... do work ...
//   await run.complete('Processed 12 prospects')
//   // or on failure:
//   await run.fail('Apollo API returned 429')

import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('log-agent-run: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.')
  }
  return createClient(url, key)
}

export interface AgentRunHandle {
  run_id: string
  complete: (output_summary?: string) => Promise<void>
  fail: (error_message: string) => Promise<void>
}

export async function startAgentRun({
  organisation_id,
  agent_name,
}: {
  organisation_id: string
  agent_name: string
}): Promise<AgentRunHandle> {
  const supabase = getServiceClient()
  const started_at = new Date()

  const { data, error } = await supabase
    .from('agent_runs')
    .insert({ organisation_id, agent_name, status: 'running', started_at: started_at.toISOString() })
    .select('id')
    .single()

  if (error || !data) {
    logger.error('startAgentRun: failed to insert agent_runs row', { agent_name, organisation_id, error: error?.message })
    // Return a no-op handle so the agent can continue without crashing on a logging failure
    return {
      run_id: 'unknown',
      complete: async () => {},
      fail:     async () => {},
    }
  }

  const run_id = data.id

  // FIRST TERMINAL WRITE WINS. This is the whole point of the guard below.
  //
  // THE DEFECT THIS FIXES, measured on a real row 2026-08-19: complete() and fail() wrote
  // DISJOINT column sets on the SAME row. complete() set status and output_summary; fail()
  // set status and error_message. Neither cleared the other's column and both were
  // last-write-wins, so a messaging run whose 240s guard fired at 240s and whose work then
  // finished at 543s ended up as:
  //
  //   status        = 'completed'
  //   duration_ms   = 543614
  //   output_summary= 'Generated 3/4 variants... Total API calls: 19.'
  //   error_message = '...exceeded 240s timeout guard...'
  //
  // A row asserting success while carrying its own failure message. Two runs recorded
  // that shape. It is the validate-one-thing-return-another family: the status column was
  // set independently of the outcome, so nothing downstream could tell the two apart.
  //
  // This is NOT messaging-specific. ICP, positioning and TOV all use this helper and all
  // have the same 240s guard, so all three could produce the same row.
  //
  // WHY THE FLAG AND NOT JUST clearTimeout BEFORE complete(). Clearing the timer first
  // NARROWS the race; it does not remove it. The timer can fire while complete()'s UPDATE
  // is already in flight, and clearTimeout cannot recall a callback that has already been
  // entered. It also does nothing about a second terminal call arriving from anywhere
  // else, such as a catch block running after an abort. The flag is set SYNCHRONOUSLY,
  // before any await, so exactly one caller can ever pass it whatever the interleaving.
  let terminal: 'completed' | 'failed' | null = null

  function claimTerminal(next: 'completed' | 'failed', detail: string): boolean {
    if (terminal !== null) {
      logger.warn('startAgentRun: ignoring second terminal write on an already-terminal run', {
        run_id,
        agent_name,
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

  async function complete(output_summary?: string) {
    if (!claimTerminal('completed', output_summary ?? '')) return
    const completed_at = new Date()
    const duration_ms = completed_at.getTime() - started_at.getTime()
    const { error: updateError } = await supabase
      .from('agent_runs')
      .update({
        status: 'completed',
        completed_at: completed_at.toISOString(),
        duration_ms,
        output_summary: output_summary ?? null,
        // Written explicitly rather than left alone, so the row cannot carry a stale
        // failure message from any other writer. A completed run has no error.
        error_message: null,
      })
      .eq('id', run_id)
    if (updateError) {
      logger.error('startAgentRun.complete: failed to update agent_runs row', { run_id, error: updateError?.message })
    }
  }

  async function fail(error_message: string) {
    if (!claimTerminal('failed', error_message)) return
    const completed_at = new Date()
    const duration_ms = completed_at.getTime() - started_at.getTime()
    const { error: updateError } = await supabase
      .from('agent_runs')
      .update({
        status: 'failed',
        completed_at: completed_at.toISOString(),
        duration_ms,
        error_message,
        // Same reasoning in the other direction: a failed run does not claim output.
        output_summary: null,
      })
      .eq('id', run_id)
    if (updateError) {
      logger.error('startAgentRun.fail: failed to update agent_runs row', { run_id, error: updateError?.message })
    }
  }

  return { run_id, complete, fail }
}
