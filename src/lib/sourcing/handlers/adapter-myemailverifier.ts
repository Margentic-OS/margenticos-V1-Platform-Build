// src/lib/sourcing/handlers/adapter-myemailverifier.ts
//
// MyEmailVerifier email validation handler.
// Endpoint: GET https://client.myemailverifier.com/verifier/validate_single/[email]/API_KEY
// Credentials: API key in URL path (MYEMAILVERIFIER_API_KEY env var)
// Rate limit: 30 emails per minute (enforced by trigger)
// Free tier: 100 verifications per day
//
// Verdict values: "Valid", "Invalid", "Unknown", "Catch All", "Grey-listed"
// Send-eligible rule: Status = "Valid" AND catch_all = false

import { logger } from '@/lib/logger'

export interface VerificationResult {
  email: string
  status: 'Valid' | 'Invalid' | 'Unknown' | 'Catch All' | 'Grey-listed'
  catch_all: boolean
  disposable_domain: boolean
  role_based: boolean
  free_domain: boolean
  greylisted: boolean
  send_eligible: boolean // Computed: status === 'Valid' && !catch_all
  verified_at: string // ISO timestamp
  diagnosis?: string
}

/**
 * The vendor's boolean fields, as they really arrive. The live API returns INTEGERS 0 and 1
 * (measured 2026-09-15 from validate_single). The strings "true" and "false" were the shape this
 * handler was written against, and they are kept as accepted input so the handler tolerates a
 * vendor change back to them.
 */
type VendorBoolean = boolean | string | number | null | undefined

interface MyEmailVerifierResponse {
  Address: string
  Status: string
  catch_all: VendorBoolean
  Disposable_Domain: VendorBoolean
  Role_Based: VendorBoolean
  Free_Domain: VendorBoolean
  Greylisted: VendorBoolean
  Diagnosis: string
}

/** Abort an individual verification probe. See the comment at the fetch below. */
const VERIFY_FETCH_TIMEOUT_MS = 20_000

/** Canonical provider key. Matches prospects.verification_provider for first-pass rows. */
export const MYEMAILVERIFIER_PROVIDER_KEY = 'myemailverifier'

/**
 * THIS VENDOR'S VOCABULARY, owned by this vendor's handler.
 *
 * CLAUDE.md: a handler owns its tool's translation table and nothing upstream sees
 * tool-specific names. The shared module at src/lib/sourcing/verification-verdict.ts composes
 * a registry from the maps each handler exports, so adding a vendor is a new handler plus one
 * registry line and no shared file learns a new word.
 *
 * "Catch All" maps to risky rather than undeliverable, and that single choice is the business
 * case for the second pass: the domain accepts mail for every address, so this probe cannot
 * confirm the specific mailbox. It is an unconfirmable address, not a dead one.
 *
 * "Grey-listed" maps to unknown rather than risky: greylisting is a temporary rejection that
 * a retry usually clears, so it means "ask again", not "this is dubious".
 */
export const MYEMAILVERIFIER_VERDICT_MAP = {
  'Valid': 'deliverable',
  'Invalid': 'undeliverable',
  'Catch All': 'risky',
  'Unknown': 'unknown',
  'Grey-listed': 'unknown',
} as const

export const myemailverifierHandler = {
  name: 'MyEmailVerifier',
  capability: 'can_validate_email',

  // Execute: verify single email and return normalized result
  execute: async (email: string): Promise<VerificationResult> => {
    const apiKey = process.env.MYEMAILVERIFIER_API_KEY
    if (!apiKey) {
      const msg = 'MYEMAILVERIFIER_API_KEY not set in environment'
      logger.error('myemailverifier handler: missing API key', { error: msg })
      throw new Error(`Email verification failed: ${msg}`)
    }

    try {
      const endpoint = `https://client.myemailverifier.com/verifier/validate_single/${encodeURIComponent(email)}/${apiKey}`

      // A TIMEOUT IS NOT OPTIONAL HERE. Verification is an SMTP probe behind an HTTP call,
      // and a probe against an unresponsive mail server can hang for as long as the far end
      // keeps the socket open. Without this, one bad address consumes the whole serverless
      // invocation regardless of batch size, and no batch number is safe.
      //
      // 20s is chosen against the caller's rate limit rather than the network: the trigger
      // sleeps 2s between addresses, so a batch of 40 already budgets ~80s of deliberate
      // waiting inside a 300s route. Anything slower than 20s is not worth the slot it
      // occupies, and the address is retried on a later sweep.
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(VERIFY_FETCH_TIMEOUT_MS),
      })

      if (!response.ok) {
        const text = await response.text()
        logger.error('myemailverifier handler: API error', {
          status: response.status,
          email,
          response: text.substring(0, 200),
        })
        throw new Error(`MyEmailVerifier API returned ${response.status}`)
      }

      const data: MyEmailVerifierResponse = await response.json()

      // Normalize verdict values
      const status = normaliseStatus(data.Status)
      // FAIL CLOSED on catch-all. A value we cannot read counts as a catch-all, so an address is
      // only send-eligible on a positive "0" or "false" from the vendor. Before this, an integer
      // answer parsed to false, which made a catch-all read as deliverable (D2b, 5 Oct 2026).
      const catchAll = parseVendorBoolean(data.catch_all) !== false
      const sendEligible = status === 'Valid' && !catchAll

      const result: VerificationResult = {
        email,
        status,
        catch_all: catchAll,
        disposable_domain: parseVendorBoolean(data.Disposable_Domain) === true,
        role_based: parseVendorBoolean(data.Role_Based) === true,
        free_domain: parseVendorBoolean(data.Free_Domain) === true,
        greylisted: parseVendorBoolean(data.Greylisted) === true,
        send_eligible: sendEligible,
        verified_at: new Date().toISOString(),
        diagnosis: data.Diagnosis,
      }

      logger.info('myemailverifier handler: verification complete', {
        email,
        status,
        catch_all: catchAll,
        send_eligible: sendEligible,
      })

      return result
    } catch (err) {
      if (err instanceof Error && err.message.includes('verification failed')) {
        throw err
      }
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('myemailverifier handler: fetch failed', {
        email,
        error: msg,
      })
      throw new Error(`Email verification failed: ${msg}`)
    }
  },
}

// Normalize MyEmailVerifier's verdict values to our canonical set
function normaliseStatus(
  status: string,
): 'Valid' | 'Invalid' | 'Unknown' | 'Catch All' | 'Grey-listed' {
  const normalised = status?.trim?.()?.toLowerCase?.() ?? ''

  if (normalised === 'valid') return 'Valid'
  if (normalised === 'invalid') return 'Invalid'
  if (normalised === 'unknown') return 'Unknown'
  if (normalised.includes('catch') && normalised.includes('all')) return 'Catch All'
  if (normalised === 'grey-listed' || normalised === 'greylisted') return 'Grey-listed'

  // Fallback
  logger.warn('myemailverifier handler: unknown status value', {
    status,
    normalised,
  })
  return 'Unknown'
}

/**
 * Read one of the vendor's boolean fields. Returns null when the value is not one we recognise,
 * and never guesses: the caller decides what "unreadable" means for its field. The catch-all
 * flag treats null as a catch-all; the informational flags treat it as not set.
 */
function parseVendorBoolean(value: VendorBoolean): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
    return null
  }
  if (typeof value === 'string') {
    const normalised = value.toLowerCase().trim()
    if (normalised === 'true' || normalised === '1') return true
    if (normalised === 'false' || normalised === '0') return false
  }
  return null
}
