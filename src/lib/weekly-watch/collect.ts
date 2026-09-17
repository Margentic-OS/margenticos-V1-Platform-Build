// Assembles the six readings into one report.
//
// The returned literal must name every key of WatchValues. That is not style: the mapped
// type makes an incomplete literal a COMPILE ERROR, and that error is the notification
// that a newly added source still needs collecting. Do not silence it with `as`.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import {
  collectAccounts,
  collectBounces,
  collectBurnPerWeek,
  collectInventory,
  collectLeadCapacity,
  collectWarmupCanary,
  fetchCampaign,
  findLiveCampaign,
  rampFrom,
  type CampaignShape,
} from './sources'
import {
  ok,
  unknown,
  type WatchProvider,
  type AccountStatuses,
  type Inventory,
  type LeadCapacity,
  type RampPosition,
  type Reading,
  type WarmupCanary,
  type WeeklyWatchReport,
} from './types'

export async function collectWeeklyWatch(
  db: SupabaseClient<Database>,
  provider: WatchProvider,
  now: Date = new Date(),
): Promise<WeeklyWatchReport> {
  // The campaign is the spine: it supplies both the daily limit and the sender list, so
  // three of the six readings depend on it. When it cannot be read they each say so in
  // their own words rather than inheriting a silent empty list — an empty sender list
  // would otherwise make "0 mailboxes, 0 spam" a perfectly clean-looking canary.
  const campaignRef = await findLiveCampaign(db)

  let campaign: Reading<CampaignShape>
  let cascade: string | null = null
  if (campaignRef.status === 'ok') {
    campaign = await fetchCampaign(provider, campaignRef.value.externalId)
    if (campaign.status === 'unknown') cascade = `campaign could not be read: ${campaign.reason}`
  } else {
    campaign = unknown(campaignRef.reason)
    cascade = `live campaign could not be identified: ${campaignRef.reason}`
  }

  const senders = campaign.status === 'ok' ? campaign.value.senders : null
  const noSenders = cascade ?? 'campaign carried no sender list'

  const burn = await collectBurnPerWeek(db, now)
  const burnValue = burn.status === 'ok' ? burn.value : null

  const warmupCanary: Promise<Reading<WarmupCanary>> = senders
    ? collectWarmupCanary(provider, senders)
    : Promise.resolve(unknown(noSenders))

  const accounts: Promise<Reading<AccountStatuses>> = senders
    ? collectAccounts(provider, senders)
    : Promise.resolve(unknown(noSenders))

  const leadCapacity: Promise<Reading<LeadCapacity>> = burn.status === 'unknown'
    ? Promise.resolve(unknown(`burn rate unavailable, so headroom cannot be derived: ${burn.reason}`))
    : collectLeadCapacity(provider, burnValue)

  const inventory: Promise<Reading<Inventory>> = burn.status === 'unknown'
    ? Promise.resolve(unknown(`burn rate unavailable, so inventory cannot be derived: ${burn.reason}`))
    : collectInventory(db, burnValue)

  const ramp: Reading<RampPosition> = campaign.status === 'ok'
    ? ok(rampFrom(campaign.value))
    : unknown(cascade ?? 'campaign unreadable')

  const [warmupCanaryR, accountsR, bouncesR, leadCapacityR, inventoryR] = await Promise.all([
    warmupCanary,
    accounts,
    collectBounces(db, now),
    leadCapacity,
    inventory,
  ])

  return {
    generatedAt: now.toISOString(),
    readings: {
      warmupCanary: warmupCanaryR,
      bounces:      bouncesR,
      accounts:     accountsR,
      ramp,
      leadCapacity: leadCapacityR,
      inventory:    inventoryR,
    },
  }
}
