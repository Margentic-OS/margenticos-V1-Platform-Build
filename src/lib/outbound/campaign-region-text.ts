// What the upload panel says about each campaign: which prospects it takes, and when it
// sends. Pure, so the wording is tested once and the panel stays a renderer.

/** A campaign's send window, read from the outbound provider and translated to canonical names. */
export interface CampaignSendWindow {
  /** Canonical IANA zone, e.g. Europe/London. */
  timezone: string
  /** HH:MM, the provider's own wall-clock strings. */
  from: string
  to: string
  /** 0 = Sunday ... 6 = Saturday, ascending. */
  days: number[]
}

export interface CampaignSendSettings {
  windows: CampaignSendWindow[]
  dailyLimit: number | null
  senderCount: number
}

export function describeRegion(regionName: string | null, regionCountries: string[] | null): string {
  if (regionCountries === null) {
    const label = regionName ?? 'All countries'
    return `${label}: every country no other campaign names, and prospects with no known country`
  }
  return `${regionName ?? 'Region'}: ${regionCountries.join(', ')}`
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function describeDays(days: number[]): string {
  if (days.join() === '1,2,3,4,5') return 'Mon to Fri'
  if (days.length === 0) return 'no days'
  return days.map(d => DAY[d]).join(', ')
}

export function describeSendSettings(s: CampaignSendSettings): string {
  const windows = s.windows.length === 0
    ? 'no send window set'
    : s.windows.map(w => `${describeDays(w.days)} ${w.from} to ${w.to} ${w.timezone}`).join('; ')
  const limit = s.dailyLimit === null ? 'no daily limit read' : `${s.dailyLimit} a day`
  return `${windows} · ${limit} · ${s.senderCount} mailbox${s.senderCount === 1 ? '' : 'es'}`
}
