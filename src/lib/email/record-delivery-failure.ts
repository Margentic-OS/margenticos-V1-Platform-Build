// A durable record of an email that did not go out.
//
// ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// sendTransactionalEmail RETURNS { success: false }. It does not throw. That is
// deliberate and correct: a notification must never be able to fail the run it is
// reporting on. The cost of it is that every caller has to remember to check a return
// value, and on 2026-09-05 not one of the twenty-one call sites did.
//
// So on 2026-09-05 an operator alert about a failed agent was rejected by the content
// validator one millisecond after the failure, and nothing anywhere noticed. The route
// that sent it wraps the call in try/catch, and a returned value does not enter a catch.
//
// A log line and a Sentry event already existed at that moment. Both fired. The failure
// still went unnoticed for two days, because both are channels somebody has to go and
// look at, and neither is read on a schedule.
//
// This module is the third channel and the only one that is watched without being
// remembered: a row lands here, MON-030 reads the table on every monitor sweep, and the
// operator dashboard turns red. See CLAUDE.md, "a query in a markdown file is not a
// control" — the same reason the commit gate had to become a hook.
//
// ─── THE TWO RULES THIS MODULE MUST NOT BREAK ────────────────────────────────
//
// 1. It must never throw. It is called from inside the failure path of the notification
//    system. An exception here converts a failed notification into a failed request, and
//    the whole point of the returned-rather-than-thrown contract is that that cannot
//    happen.
//
// 2. It must never send an email. Reporting a failed email by email is a loop, and the
//    channel it would use is the one already known to be broken.

import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

// 'recipient_refused' added 2026-09-07 alongside the two recipient guards in send.ts: a
// staging override found in production, and an operator-only email addressed to a client
// user. Neither is a content fault and neither reached the provider, so folding them into
// content_validation would misreport both. MON-030 counts every unresolved row for its
// verdict, so a new stage is counted; only its n_validation breakdown excludes it, which
// is correct.
export type EmailFailureStage = 'content_validation' | 'provider_send' | 'recipient_refused'

export interface EmailDeliveryFailure {
  to: string
  subject: string
  stage: EmailFailureStage
  error: string
  audience: 'operator' | 'customer'
}

export async function recordEmailDeliveryFailure(
  failure: EmailDeliveryFailure,
): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  // No credentials means unit tests, or a misconfigured environment. Either way the log
  // line below is all that is available, and it is better than throwing out of a path
  // whose entire job is to not throw.
  if (!url || !serviceKey) {
    logger.warn('recordEmailDeliveryFailure: no service credentials, failure not persisted', {
      stage: failure.stage,
      subject: failure.subject,
    })
    return
  }

  try {
    const supabase = createClient(url, serviceKey)
    const { error } = await supabase.from('email_delivery_failures').insert({
      recipient: failure.to,
      subject: failure.subject,
      stage: failure.stage,
      error_message: failure.error,
      audience: failure.audience,
    })

    if (error) {
      // Deliberately warn rather than throw. If this insert is failing, the monitor that
      // reads the table is already the wrong instrument and the log is the fallback.
      logger.warn('recordEmailDeliveryFailure: insert failed', {
        stage: failure.stage,
        subject: failure.subject,
        error: error.message,
      })
    }
  } catch (err) {
    logger.warn('recordEmailDeliveryFailure: threw, swallowed', {
      stage: failure.stage,
      subject: failure.subject,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
