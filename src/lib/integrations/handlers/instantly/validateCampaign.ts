// Validates that an Instantly campaign UUID exists and is accessible in the
// operator's Instantly account.
//
// Called synchronously at form submit when the operator registers a campaign.
// No retries — the operator UI calls this once and surfaces any error inline.
//
// Return value fields are chosen to give the operator enough context to confirm
// "this is the right campaign" without pulling every field from the Instantly response.

import { resolveInstantlyBaseUrl } from './constants'
import { getInstantlyApiKey, getInstantlyApiActive } from './auth'

export interface CampaignValidationResult {
  name: string
  status: string
  schedulingStatus: string | null
}

export async function validateCampaign(
  organisationId: string,
  campaignUuid: string
): Promise<CampaignValidationResult> {
  const apiKey = await getInstantlyApiKey(organisationId)
  const isActive = await getInstantlyApiActive()
  const baseUrl = resolveInstantlyBaseUrl(isActive)

  let response: Response
  try {
    response = await fetch(`${baseUrl}/campaigns/${campaignUuid}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    })
  } catch (err) {
    throw new Error(`Instantly is currently unreachable — try again in a moment. (${String(err)})`)
  }

  if (response.status === 404) {
    throw new Error(
      'Instantly campaign not found in this account — verify the UUID and that you\'re using the right Instantly account.'
    )
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Instantly API key invalid or missing — check integration credentials.')
  }

  if (response.status >= 500) {
    throw new Error('Instantly is currently unreachable — try again in a moment.')
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '(unreadable)')
    throw new Error(`Instantly returned an unexpected error (${response.status}): ${body.slice(0, 200)}`)
  }

  let data: Record<string, unknown>
  try {
    data = await response.json() as Record<string, unknown>
  } catch {
    throw new Error('Instantly returned a response that could not be parsed.')
  }

  return {
    name:             (data.name as string)              ?? '(unnamed)',
    status:           (data.status as string)            ?? 'unknown',
    schedulingStatus: (data.scheduling_status as string) ?? null,
  }
}
