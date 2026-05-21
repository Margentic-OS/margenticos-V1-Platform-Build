// Orders DFY email accounts via POST /api/v2/dfy-email-account-orders.
// Two-step flow: simulate=true returns a quote and validity check without
// placing a real order; simulate=false places the real order (real money).
//
// TLD restriction: Instantly accepts .com and .org only. Any domain outside
// INSTANTLY_DFY_ALLOWED_TLDS is rejected before the API call.
//
// Safety: real orders (simulate=false) are blocked when instantly_api_active=false
// and the URL is production — same defence-in-depth pattern as uploadLeads.

import * as Sentry from '@sentry/nextjs'
import { logger } from '@/lib/logger'
import { getInstantlyApiBaseUrl, INSTANTLY_DFY_ALLOWED_TLDS } from './constants'
import { getInstantlyApiKey, getInstantlyApiActive } from './auth'
import type { DfyOrderItem, DfyOrderResponse, DfyOrderResult } from './types'
import {
  InstantlyFlagError,
  InstantlyNetworkError,
  InstantlyRateLimitError,
  InstantlyValidationError,
  InstantlyServerError,
  InstantlyApiError,
} from './types'

function isProductionUrl(url: string): boolean {
  return url.includes('api.instantly.ai') && !url.includes('_mock')
}

function extractTld(domain: string): string {
  const lastDot = domain.lastIndexOf('.')
  return lastDot === -1 ? '' : domain.slice(lastDot)
}

export async function orderMailboxes(
  organisationId: string,
  domains: string[],
  simulate: boolean,
): Promise<DfyOrderResult> {
  // Validate TLDs before any network call.
  const invalidDomains = domains.filter(
    d => !(INSTANTLY_DFY_ALLOWED_TLDS as readonly string[]).includes(extractTld(d))
  )
  if (invalidDomains.length > 0) {
    throw new InstantlyValidationError(
      `Domain TLD not supported by Instantly DFY ordering: ${invalidDomains.join(', ')}. ` +
      `Allowed TLDs: ${INSTANTLY_DFY_ALLOWED_TLDS.join(', ')}`
    )
  }

  const apiKey = await getInstantlyApiKey(organisationId)
  const baseUrl = getInstantlyApiBaseUrl()
  const isActive = await getInstantlyApiActive()

  // Real orders require the feature flag to be active in production.
  if (!simulate && !isActive && isProductionUrl(baseUrl)) {
    throw new InstantlyFlagError(
      'Cannot place real DFY orders while instantly_api_active is false'
    )
  }

  const items: DfyOrderItem[] = domains.map(domain => ({ domain }))

  const requestBody = {
    items,
    order_type: 'dfy',
    simulate,
  }

  let response: Response
  try {
    response = await fetch(`${baseUrl}/dfy-email-account-orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    })
  } catch (err) {
    throw new InstantlyNetworkError(`Instantly is unreachable: ${String(err)}`)
  }

  if (response.status === 429) {
    throw new InstantlyRateLimitError('Instantly rate limit hit — retry in a moment')
  }

  if (response.status === 400 || response.status === 422) {
    const body = await response.text().catch(() => '(unreadable)')
    throw new InstantlyValidationError(
      `DFY order rejected (${response.status}): ${body.slice(0, 400)}`
    )
  }

  if (response.status >= 500) {
    const errMsg = `Instantly transient outage (${response.status}) — try again later`
    Sentry.captureException(new Error(errMsg), { level: 'warning' })
    throw new InstantlyServerError(errMsg)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '(unreadable)')
    throw new InstantlyApiError(
      `Unexpected Instantly error (${response.status}): ${body.slice(0, 400)}`
    )
  }

  let data: DfyOrderResponse
  try {
    data = await response.json() as DfyOrderResponse
  } catch {
    throw new InstantlyApiError('Instantly DFY response could not be parsed as JSON')
  }

  // Safety net: simulate=true but order placed (unexpected real charge).
  if (simulate && data.order_placed) {
    const msg = 'orderMailboxes: simulate was true but order_placed=true — unexpected real charge'
    logger.warn(msg, { domains, organisation_id: organisationId })
    Sentry.captureException(new Error(msg), { level: 'error' })
  }

  // Safety net: simulate=false but no order placed (unexpected silent failure).
  if (!simulate && !data.order_placed) {
    const msg = 'orderMailboxes: simulate was false but order_placed=false — unexpected silent failure'
    logger.warn(msg, { domains, organisation_id: organisationId })
    Sentry.captureException(new Error(msg), { level: 'warning' })
  }

  logger.info('instantly/orderMailboxes: DFY order call complete', {
    simulate,
    order_placed: data.order_placed,
    order_is_valid: data.order_is_valid,
    domains,
    organisation_id: organisationId,
  })

  return {
    order_placed: data.order_placed,
    order_is_valid: data.order_is_valid,
    total_price: data.total_price ?? data.price ?? null,
    simulated: simulate,
  }
}
