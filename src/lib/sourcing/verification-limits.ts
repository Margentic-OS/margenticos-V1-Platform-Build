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
//
// ═════════════════════════════════════════════════════════════════════════════
// THE PER-MINUTE RATE LIMIT LIVES HERE TOO, FOR THE SAME REASON AND ON THE SAME ROW
//
// `rate_limit_per_minute` was seeded onto that registry row on 2026-09-04 and the seeding
// migration says so in as many words: "seeded and read by nothing today". It stayed unread
// for seventeen days while `const RATE_LIMIT_PER_MINUTE = 30` in verification-trigger.ts
// governed the actual pace.
//
// That is the same shape as the daily limit above, one step earlier: a number the vendor
// owns, compiled into our source, where raising it costs a deploy. The validator's own
// documentation says the single-validation limit is customisable on request, so the day it
// is raised is a day somebody edits a row, not a day somebody edits TypeScript.
//
// A config value that is read by nothing is worse than no config value. It reads as a knob,
// and turning it does nothing at all.

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
 * The compiled pace used when the registry cannot be read.
 *
 * The validator's documented default single-validation allowance, and the value the
 * registry row is seeded with. Exported for the same reason as the daily fallback: a test
 * that restated the number would stop failing on the day the number changed.
 */
export const FALLBACK_RATE_LIMIT_PER_MINUTE = 30

/** The registry key holding the editable per-minute pace. */
export const RATE_LIMIT_PER_MINUTE_KEY = 'rate_limit_per_minute'

export interface VerificationRateLimit {
  limitPerMinute: number
  source: DailyVerificationLimitSource
  /** Why the fallback was used. Absent when source is 'config'. */
  reason?: string
}

/**
 * ONE READ OF ONE ROW, SHARED BY BOTH LIMITS.
 *
 * The obvious way to add a second limit is to copy the query and change the key. That gives
 * two places that each decide, separately, which registry row counts as the active
 * validator: two `capability` filters, two `is_active` filters, two `maybeSingle` calls. The
 * day the capability is renamed or a second active row appears, one of them is updated.
 *
 * That is the parallel-arrays shape from CLAUDE.md with the lists one level up, and this
 * codebase has already paid for it in the monitor sweep and in `removed_count`. So the row
 * is read once, here, and the two callers differ only in which key they pull out of it.
 *
 * Anything that is not a positive, finite integer is rejected rather than coerced. A config
 * value of 0, null, "100", -5 or 12.5 all mean somebody edited the row wrongly, and silently
 * accepting any of them turns a typo into either a stalled sweep or an overrun.
 */
async function readPositiveIntegerFromRegistry(
  supabase: SupabaseClient,
  key: string,
): Promise<{ value: number } | { reason: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from('integrations_registry')
      .select('config')
      .eq('capability', 'can_validate_email')
      .eq('is_active', true)
      .maybeSingle()

    if (error) return { reason: `registry read failed: ${error.message}` }
    if (!data) return { reason: 'no active can_validate_email row in integrations_registry' }

    const raw = (data as { config?: Record<string, unknown> })?.config?.[key]

    if (raw === undefined || raw === null) {
      return { reason: `config.${key} is not set on the active row` }
    }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
      return { reason: `config.${key} is ${JSON.stringify(raw)}, which is not a positive integer` }
    }

    return { value: raw }
  } catch (err) {
    return { reason: `exception reading registry: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * Read the daily verification budget from the active email-validation registry row.
 */
export async function getDailyVerificationLimit(
  supabase: SupabaseClient,
): Promise<DailyVerificationLimit> {
  const result = await readPositiveIntegerFromRegistry(supabase, DAILY_VERIFICATION_LIMIT_KEY)

  if ('reason' in result) {
    logger.warn('verification-limits: falling back to the compiled default', {
      reason: result.reason,
      fallback_limit: FALLBACK_DAILY_VERIFICATION_LIMIT,
    })
    return { limit: FALLBACK_DAILY_VERIFICATION_LIMIT, source: 'fallback', reason: result.reason }
  }

  return { limit: result.value, source: 'config' }
}

/**
 * Read the provider's per-minute allowance from the same row.
 *
 * THE FALLBACK IS THE SMALL NUMBER, in the same direction of caution as the daily one. An
 * unreadable config must never hand the sweep a FASTER pace than it had: being throttled is
 * recoverable on the next sweep, and tripping the provider's limit is not, because the
 * addresses refused there each burn a retry attempt against MAX_RETRY_ATTEMPTS and a
 * prospect that runs out of attempts is not picked up again without being asked.
 */
export async function getVerificationRateLimit(
  supabase: SupabaseClient,
): Promise<VerificationRateLimit> {
  const result = await readPositiveIntegerFromRegistry(supabase, RATE_LIMIT_PER_MINUTE_KEY)

  if ('reason' in result) {
    logger.warn('verification-limits: falling back to the compiled pace', {
      reason: result.reason,
      fallback_rate_limit_per_minute: FALLBACK_RATE_LIMIT_PER_MINUTE,
    })
    return {
      limitPerMinute: FALLBACK_RATE_LIMIT_PER_MINUTE,
      source: 'fallback',
      reason: result.reason,
    }
  }

  return { limitPerMinute: result.value, source: 'config' }
}
