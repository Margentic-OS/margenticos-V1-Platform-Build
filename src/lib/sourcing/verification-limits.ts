// src/lib/sourcing/verification-limits.ts
//
// The daily verification budget, read from config rather than compiled in.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS IS NOT A CONSTANT ANY MORE
//
// The number lived in verification-trigger.ts as `const FREE_DAILY_LIMIT = 100`, and 100
// was the validator's FREE TIER allowance. The account left that tier on 2026-09-01 when
// pay-as-you-go credits were bought. The constant went on describing a plan the account no
// longer has, and every sweep since then capped its batch against it.
//
// Raising the constant would have fixed the number and left the shape: the next time the
// account's allowance changes, the fix is a code change, a review, a deploy, and a window
// where verification is throttled against a figure nobody can edit. A vendor's commercial
// terms are not a property of our source code.
//
// So the value moves to integrations_registry, the same table and the same shape as the
// enrichment_live flag, and the constant stays as a FALLBACK for the case where the row or
// the key cannot be read.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE FALLBACK IS DELIBERATELY THE OLD, SMALL NUMBER
//
// A config read that fails must not hand the sweep a bigger budget than it had before.
// Verification is resumable on the next sweep; an overrun is not resumable and costs money.
// So an unreadable config falls back to 100 and says so in the log, which is the same
// direction of caution the surrounding code already takes when it treats an unreadable
// daily-usage count as exhausted rather than as zero.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE LOOKUP IS BY CAPABILITY, NEVER BY TOOL NAME
//
// `capability = 'can_validate_email' AND is_active = true`. Two rows carry that capability
// and exactly one is active, so swapping validator is a registry edit and this file does
// not change. Naming the vendor here would put a tool name in the application layer, where
// CLAUDE.md allows it only inside a handler.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

/**
 * The value used when the registry cannot be read.
 *
 * Exported so tests can assert the fallback without restating the number, which is the
 * shape that lets a fixture and a source of truth drift apart.
 */
export const FALLBACK_DAILY_VERIFICATION_LIMIT = 100

/** The registry key holding the editable limit. */
export const DAILY_VERIFICATION_LIMIT_KEY = 'daily_verification_limit'

export type DailyVerificationLimitSource = 'config' | 'fallback'

export interface DailyVerificationLimit {
  limit: number
  source: DailyVerificationLimitSource
  /** Why the fallback was used. Absent when source is 'config'. */
  reason?: string
}

/**
 * Read the daily verification budget from the active email-validation registry row.
 *
 * Anything that is not a positive, finite integer is rejected rather than coerced. A
 * config value of 0, null, "100", -5 or 12.5 all mean somebody edited the row wrongly, and
 * silently accepting any of them turns a typo into either a stalled sweep or an overrun.
 */
export async function getDailyVerificationLimit(
  supabase: SupabaseClient,
): Promise<DailyVerificationLimit> {
  const fallback = (reason: string): DailyVerificationLimit => {
    logger.warn('verification-limits: falling back to the compiled default', {
      reason,
      fallback_limit: FALLBACK_DAILY_VERIFICATION_LIMIT,
    })
    return { limit: FALLBACK_DAILY_VERIFICATION_LIMIT, source: 'fallback', reason }
  }

  try {
    const { data, error } = await (supabase as any)
      .from('integrations_registry')
      .select('config')
      .eq('capability', 'can_validate_email')
      .eq('is_active', true)
      .maybeSingle()

    if (error) return fallback(`registry read failed: ${error.message}`)
    if (!data) return fallback('no active can_validate_email row in integrations_registry')

    const raw = (data as { config?: Record<string, unknown> })?.config?.[DAILY_VERIFICATION_LIMIT_KEY]

    if (raw === undefined || raw === null) {
      return fallback(`config.${DAILY_VERIFICATION_LIMIT_KEY} is not set on the active row`)
    }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
      return fallback(
        `config.${DAILY_VERIFICATION_LIMIT_KEY} is ${JSON.stringify(raw)}, which is not a positive integer`,
      )
    }

    return { limit: raw, source: 'config' }
  } catch (err) {
    return fallback(`exception reading registry: ${err instanceof Error ? err.message : String(err)}`)
  }
}
