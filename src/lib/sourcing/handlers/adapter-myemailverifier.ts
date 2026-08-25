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

interface MyEmailVerifierResponse {
  Address: string
  Status: string
  catch_all: string // "true" or "false" as string
  Disposable_Domain: string
  Role_Based: string
  Free_Domain: string
  Greylisted: string
  Diagnosis: string
}

/** Abort an individual verification probe. See the comment at the fetch below. */
const VERIFY_FETCH_TIMEOUT_MS = 20_000

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
      const catchAll = parseBooleanString(data.catch_all)
      const sendEligible = status === 'Valid' && !catchAll

      const result: VerificationResult = {
        email,
        status,
        catch_all: catchAll,
        disposable_domain: parseBooleanString(data.Disposable_Domain),
        role_based: parseBooleanString(data.Role_Based),
        free_domain: parseBooleanString(data.Free_Domain),
        greylisted: parseBooleanString(data.Greylisted),
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

// Parse MyEmailVerifier's boolean strings ("true" / "false") to boolean
function parseBooleanString(value: string | boolean | null | undefined): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return value.toLowerCase().trim() === 'true'
  }
  return false
}
