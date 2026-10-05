import { describe, expect, it } from 'vitest'
import { describeRegion, describeSendSettings } from '../campaign-region-text'
import { parseCampaignSendSettings } from '@/lib/integrations/handlers/instantly/campaign-send-settings'

// The shape the provider returned for the UK/IE campaign on 2026-10-05, trimmed.
const UKIE = {
  daily_limit: 15,
  email_list: ['a@x.example', 'b@x.example', 'c@x.example', 'd@y.example', 'e@y.example', 'f@y.example'],
  campaign_schedule: {
    schedules: [{
      name: 'UK/IE working day',
      timing: { from: '08:00', to: '18:00' },
      days: { '1': true, '2': true, '3': true, '4': true, '5': true },
      timezone: 'Europe/Isle_of_Man',
    }],
  },
}

describe('parseCampaignSendSettings', () => {
  it('PLANTED: the provider stores UK time as Isle_of_Man; the operator is shown Europe/London', () => {
    const s = parseCampaignSendSettings(UKIE)
    expect(s.windows).toEqual([{ timezone: 'Europe/London', from: '08:00', to: '18:00', days: [1, 2, 3, 4, 5] }])
    expect(s.dailyLimit).toBe(15)
    expect(s.senderCount).toBe(6)
  })

  it('a zone with no translation passes through unchanged', () => {
    const s = parseCampaignSendSettings({ ...UKIE, campaign_schedule: { schedules: [{ ...UKIE.campaign_schedule.schedules[0], timezone: 'America/Detroit' }] } })
    expect(s.windows[0].timezone).toBe('America/Detroit')
  })

  it('days switched off are not counted as sending days', () => {
    const s = parseCampaignSendSettings({ ...UKIE, campaign_schedule: { schedules: [{ ...UKIE.campaign_schedule.schedules[0], days: { '0': false, '1': true, '6': true } }] } })
    expect(s.windows[0].days).toEqual([1, 6])
  })

  it('a campaign with no schedule and no limit says so, rather than inventing one', () => {
    const s = parseCampaignSendSettings({})
    expect(s).toEqual({ windows: [], dailyLimit: null, senderCount: 0 })
    expect(describeSendSettings(s)).toBe('no send window set · no daily limit read · 0 mailboxes')
  })
})

describe('describeSendSettings and describeRegion', () => {
  it('reads as the operator would say it', () => {
    expect(describeSendSettings(parseCampaignSendSettings(UKIE))).toBe('Mon to Fri 08:00 to 18:00 Europe/London · 15 a day · 6 mailboxes')
    expect(describeRegion('UK/IE', ['GB', 'IE'])).toBe('UK/IE: GB, IE')
    expect(describeRegion('US and everywhere else', null)).toBe('US and everywhere else: every country no other campaign names, and prospects with no known country')
    expect(describeRegion(null, null)).toMatch(/^All countries: /)
  })
})
