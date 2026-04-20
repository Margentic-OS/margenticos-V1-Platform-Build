// Agent run logger — call this at the start of every agent invocation.
// Writes to agent_runs via service role (no RLS INSERT policy for authenticated users).
// Usage:
//   const run = await startAgentRun({ client_id, agent_name })
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
  client_id,
  agent_name,
}: {
  client_id: string
  agent_name: string
}): Promise<AgentRunHandle> {
  const supabase = getServiceClient()
  const started_at = new Date()

  const { data, error } = await supabase
    .from('agent_runs')
    .insert({ client_id, agent_name, status: 'running', started_at: started_at.toISOString() })
    .select('id')
    .single()

  if (error || !data) {
    logger.error('startAgentRun: failed to insert agent_runs row', { agent_name, client_id, error: error?.message })
    // Return a no-op handle so the agent can continue without crashing on a logging failure
    return {
      run_id: 'unknown',
      complete: async () => {},
      fail:     async () => {},
    }
  }

  const run_id = data.id

  async function complete(output_summary?: string) {
    const completed_at = new Date()
    const duration_ms = completed_at.getTime() - started_at.getTime()
    const { error: updateError } = await supabase
      .from('agent_runs')
      .update({ status: 'completed', completed_at: completed_at.toISOString(), duration_ms, output_summary: output_summary ?? null })
      .eq('id', run_id)
    if (updateError) {
      logger.error('startAgentRun.complete: failed to update agent_runs row', { run_id, error: updateError?.message })
    }
  }

  async function fail(error_message: string) {
    const completed_at = new Date()
    const duration_ms = completed_at.getTime() - started_at.getTime()
    const { error: updateError } = await supabase
      .from('agent_runs')
      .update({ status: 'failed', completed_at: completed_at.toISOString(), duration_ms, error_message })
      .eq('id', run_id)
    if (updateError) {
      logger.error('startAgentRun.fail: failed to update agent_runs row', { run_id, error: updateError?.message })
    }
  }

  return { run_id, complete, fail }
}
