// src/lib/sourcing/handlers/adapter-bouncer.ts
//
// Bouncer email verification handler. Capability: can_validate_email (second pass).
//
// Endpoint:    GET https://api.usebouncer.com/v1.1/email/verify?email=...&timeout=...
// Credentials: BOUNCER_API_KEY, sent in the x-api-key header. Never in the URL.
// Rate limit:  1,000 requests per minute by default.
// Price:       $8 per 1,000, pay as you go, credits do not expire, no block minimum.
//
// Endpoint shape, parameters, status and reason vocabularies confirmed against
// docs.usebouncer.com/api-reference/real-time/verify-email on 2026-08-25, not from memory.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY A SECOND VENDOR AT ALL, given the first one is not wrong
//
// MyEmailVerifier is being honest when it reports "Catch All". A catch-all domain accepts
// mail for every address by design, so an SMTP probe cannot distinguish a real mailbox from
// an invented one. Detection of a catch-all signals RISK, not a defect in the verifier.
//
// Bouncer's specific claim is provider-level resolution for catch-alls hosted on Google and
// Microsoft, which is a different mechanism, not a better probe. Measured on 10 real
// catch-alls from the live organisation on 2026-08-25: 8 resolved deliverable, 2 risky, 0
// undeliverable. Bouncer returned domain.acceptAll "yes" on all ten, so it AGREES the
// domains are catch-all and resolved the individual addresses anyway.
//
// Treat 80% as close to a BEST case, not a forecast. n=10, the 95% interval runs roughly
// 44-97%, and every domain in the cohort was inside the vendor's stated sweet spot.
//
// THIS HANDLER DOES NOT DECIDE WHETHER TO SEND. It returns a verdict and nothing else.
// The equivalent decision baked into adapter-myemailverifier.ts (`send_eligible: status ===
// 'Valid' && !catch_all`) is what made send policy a property of a vendor handler, and it is
// deliberately not repeated here. Policy lives in send-eligibility-resolver.ts.

import { logger } from '@/lib/logger'
// TYPE-ONLY IMPORT, AND IT HAS TO STAY THAT WAY.
//
// verification-verdict.ts imports BOUNCER_VERDICT_MAP from this file to build its registry.
// A VALUE import back the other way closes the cycle, and at runtime the two modules
// initialise in an order where one of them reads the other's const before it is assigned:
//
//     ReferenceError: Cannot access 'f' before initialization
//     Build error: Failed to collect page data for /api/cron/verify-catch-all
//
// That is a real failure, and note what did NOT catch it: `tsc --noEmit` passed and the full
// vitest suite passed, because vitest's module graph tolerates the cycle. Only `npm run
// build` failed. It is the reason a local production build is part of the receipts and not
// an optional extra.
//
// A type-only import is erased at compile time, so it creates no runtime edge and no cycle.
// The handler translating with its OWN map is also simply more correct: it owns its
// vocabulary, and calling back into the shared registry to read its own words was a detour.
import type { CanonicalVerdict } from '@/lib/sourcing/verification-verdict'

/**
 * How long to let one probe run.
 *
 * TWO TIMEOUTS, AND THEY ARE NOT THE SAME THING. `timeout` is a Bouncer query parameter
 * telling the vendor how long to spend on its own SMTP conversation (default 10s, maximum
 * 30s). VERIFY_FETCH_TIMEOUT_MS aborts our HTTP request regardless of what the vendor does.
 *
 * The vendor timeout is set BELOW the fetch timeout on purpose. If they were equal, a probe
 * that hit the vendor's limit would race our abort, and we would sometimes throw away an
 * answer the vendor had already paid to produce and was about to return. Giving the fetch
 * five extra seconds means the vendor's own timeout is what fires, and a timeout comes back
 * as a verdict we can record rather than an exception we can only count.
 *
 * The lesson itself is inherited from the first-pass handler: verification is an SMTP probe
 * behind an HTTP call, and without an abort one unresponsive mail server consumes the entire
 * serverless invocation no matter how small the batch.
 */
const BOUNCER_VENDOR_TIMEOUT_SECONDS = 15
const VERIFY_FETCH_TIMEOUT_MS = 20_000

/** Canonical provider key. Also the value written to prospects.second_pass_provider. */
export const BOUNCER_PROVIDER_KEY = 'bouncer'

/**
 * THIS VENDOR'S VOCABULARY, owned by this vendor's handler. Confirmed against
 * docs.usebouncer.com on 2026-08-25: deliverable, risky, undeliverable, unknown.
 *
 * They happen to be identical to the canonical set, and they are still mapped EXPLICITLY
 * rather than passed through. A vendor whose vocabulary coincides today is exactly the vendor
 * that adds a fifth word tomorrow, and a pass-through would carry it into shared policy
 * unnoticed.
 */
export const BOUNCER_VERDICT_MAP = {
  'deliverable': 'deliverable',
  'undeliverable': 'undeliverable',
  'risky': 'risky',
  'unknown': 'unknown',
} as const

export interface SecondPassResult {
  email: string
  /** The vendor's own word, stored verbatim as the audit trail. */
  raw_status: string
  /** The vendor's word translated into the shared vocabulary. Policy reads this. */
  verdict: CanonicalVerdict
  /** Vendor reason code, e.g. accepted_email, low_deliverability. Stored, never gated on. */
  reason: string | null
  /** 0-100. RECORDED SO A THRESHOLD CAN BE DERIVED LATER. Gated on by nothing. */
  score: number | null
  /**
   * Whether the vendor agrees the DOMAIN is catch-all.
   *
   * Worth storing because it is the evidence for the whole approach. On the 2026-08-25
   * sample this was "yes" on all ten while eight still resolved deliverable, which is the
   * provider-specific claim doing exactly what it says. If this ever starts coming back
   * "no" on addresses the first pass called catch-all, the two vendors disagree about the
   * DOMAIN, which is a different and more worrying problem than disagreeing about a mailbox.
   */
  accept_all: boolean | null
  /** Vendor's mail host detection, e.g. google, outlook. Diagnostic only. */
  provider: string | null
  verified_at: string
}

export const bouncerHandler = {
  name: 'Bouncer',
  capability: 'can_validate_email',
  providerKey: BOUNCER_PROVIDER_KEY,

  execute: async (email: string): Promise<SecondPassResult> => {
    const apiKey = process.env.BOUNCER_API_KEY
    if (!apiKey) {
      const msg = 'BOUNCER_API_KEY not set in environment'
      logger.error('bouncer handler: missing API key', { error: msg })
      throw new Error(`Second-pass verification failed: ${msg}`)
    }

    try {
      const url =
        `https://api.usebouncer.com/v1.1/email/verify` +
        `?email=${encodeURIComponent(email)}` +
        `&timeout=${BOUNCER_VENDOR_TIMEOUT_SECONDS}`

      // THE KEY GOES IN A HEADER, NOT THE PATH. The first-pass vendor requires it in the
      // URL, which puts a live credential into every log line, proxy record and error
      // message that carries a URL. This vendor supports a header, so it gets one.
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(VERIFY_FETCH_TIMEOUT_MS),
      })

      if (!response.ok) {
        const text = await response.text()
        // 402 is out of credits and is worth naming, because it is the failure that looks
        // like a bug and is actually a billing state. It is not retryable by waiting.
        const hint =
          response.status === 402 ? ' (out of credits: top up the pay-as-you-go balance)'
          : response.status === 429 ? ' (rate limited: 1,000/min)'
          : ''
        logger.error('bouncer handler: API error', {
          status: response.status,
          email,
          response: text.substring(0, 200),
        })
        throw new Error(`Bouncer API returned ${response.status}${hint}`)
      }

      const data = await response.json() as {
        email?: string
        status?: string
        reason?: string
        score?: number
        provider?: string
        domain?: { acceptAll?: string | boolean }
      }

      const rawStatus = typeof data.status === 'string' ? data.status.trim() : ''
      if (!rawStatus) {
        throw new Error('Bouncer API returned no status field')
      }

      // Translated with this handler's own map. An unrecognised word degrades to 'unknown'
      // rather than to anything mailable: a vendor changing its vocabulary underneath us must
      // never result in an address being sent to on the strength of a word nobody has read.
      const verdict: CanonicalVerdict =
        (BOUNCER_VERDICT_MAP as Record<string, CanonicalVerdict>)[rawStatus] ?? 'unknown'

      if (!(rawStatus in BOUNCER_VERDICT_MAP)) {
        logger.warn('bouncer handler: unrecognised status value, treated as unknown', {
          email,
          raw_status: rawStatus,
          consequence: 'Add it to BOUNCER_VERDICT_MAP in this file.',
        })
      }

      const result: SecondPassResult = {
        email,
        raw_status: rawStatus,
        verdict,
        reason: typeof data.reason === 'string' ? data.reason : null,
        score: typeof data.score === 'number' ? data.score : null,
        accept_all: parseYesNo(data.domain?.acceptAll),
        provider: typeof data.provider === 'string' ? data.provider : null,
        verified_at: new Date().toISOString(),
      }

      logger.info('bouncer handler: second-pass verification complete', {
        email,
        raw_status: rawStatus,
        verdict,
        reason: result.reason,
        score: result.score,
        accept_all: result.accept_all,
      })

      return result
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Second-pass verification failed')) {
        throw err
      }
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('bouncer handler: fetch failed', { email, error: msg })
      throw new Error(`Second-pass verification failed: ${msg}`)
    }
  },
}

/**
 * Bouncer reports its booleans as the strings "yes" and "no".
 *
 * An unrecognised value returns null rather than false, because these fields are recorded
 * as evidence and "we did not get an answer" must not be stored as "the answer was no".
 */
function parseYesNo(value: string | boolean | null | undefined): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  if (v === 'yes' || v === 'true') return true
  if (v === 'no' || v === 'false') return false
  return null
}
