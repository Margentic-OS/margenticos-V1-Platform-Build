// Counts the reads the client library retried after a 504, one row per day and method.
//
// WHY. patches/@supabase+postgrest-js+2.103.2.patch retries a read once when Supabase's
// gateway cuts it with a 504. Most retries succeed, so once the patch shipped the cuts
// stopped reaching our code as errors. That is the point of it, and also a loss: the fault
// was still getting worse when the retry went in, and a fault that surfaces nowhere cannot
// be watched. This keeps it visible as a number per day in gateway_retry_counts.
//
// NOT AN ALERT, deliberately. Nothing reads the table to notify anyone. It is a trend.
//
// HOW IT IS WIRED. The patched library calls globalThis.__postgrestGatewayRetryHook with
// { method } on every retry, when something has set it. installGatewayRetryCounter() sets
// it, once, from src/instrumentation.ts in the Node.js runtime. The hook starts the write
// and returns at once: it must never block the retry and never throw into the library.
//
// LIMITS, so the number is not over-read. It is a FLOOR:
//   - Node.js server only. Retries in the browser and in middleware are not counted.
//   - the write is fire-and-forget. If it fails, or the function ends before it lands,
//     that retry goes uncounted.
//   - the write is an RPC, which is a POST, and the patch never retries a POST. So
//     counting a retry can never itself be retried and counted: no loop is possible.

import { logger } from '@/lib/logger'
import { createServiceRoleClient } from '@/lib/supabase/service-role'

/** The global the patched library looks up. Must match the string in the patch. */
export const GATEWAY_RETRY_HOOK = '__postgrestGatewayRetryHook'

export interface GatewayRetryEvent {
  method: string
}

type HookHost = { [GATEWAY_RETRY_HOOK]?: (event: GatewayRetryEvent) => void }

/** Adds one to today's count for this method. Never throws; a failure is logged and lost. */
export async function recordGatewayRetry(event: GatewayRetryEvent): Promise<void> {
  try {
    const supabase = await createServiceRoleClient()
    const { error } = await supabase.rpc('record_gateway_retry', { p_method: event.method })
    if (error) {
      logger.warn('gateway-retry-counter: could not record a retry', {
        method: event.method,
        error: error.message,
      })
    }
  } catch (err) {
    logger.warn('gateway-retry-counter: recording a retry threw', {
      method: event.method,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Registers the hook the patched library calls on each 504 retry. */
export function installGatewayRetryCounter(host: HookHost = globalThis as HookHost): void {
  host[GATEWAY_RETRY_HOOK] = (event: GatewayRetryEvent) => {
    void recordGatewayRetry(event)
  }
}
