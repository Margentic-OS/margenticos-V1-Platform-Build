/**
 * One-off script: create Sentry alert for sustained Instantly polling failures.
 * Run once, capture rule ID, keep as reference or delete.
 *
 * Condition: the polling-failure issue has been seen more than 2 times in 1 hour
 * (= 3+ failures = 45 min of sustained breakage at the 15-min poll interval).
 * Filter: message contains either key polling failure string.
 *
 * Usage: npx tsx scripts/create-sentry-polling-alert.ts
 * Requires SENTRY_ALERTS_TOKEN in .env.local (scopes: alerts:write, project:read, org:read)
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'

function loadEnv(): Record<string, string> {
  const lines = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8').split('\n')
  const env: Record<string, string> = {}
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
  }
  return env
}

const env = loadEnv()
const token = env['SENTRY_ALERTS_TOKEN']
if (!token) {
  console.error('SENTRY_ALERTS_TOKEN not found in .env.local')
  process.exit(1)
}

const ORG = 'margentic-os'
const PROJECT = 'margenticos'
const MEMBER_ID = 4469242 // Doug Pettit — confirmed via Sentry MCP whoami

const payload = {
  name: 'polling-failures-sustained',
  // EventFrequencyCondition: fires when this issue has been seen more than N times
  // in the given window. value=2 means "more than 2" = 3+ events.
  // At the 15-min poll interval, 3 failures = 45 min of sustained breakage.
  actionMatch: 'all',
  filterMatch: 'any',
  conditions: [
    {
      id: 'sentry.rules.conditions.event_frequency.EventFrequencyCondition',
      value: 2,
      interval: '1h',
    },
  ],
  filters: [
    {
      id: 'sentry.rules.filters.event_attribute.EventAttributeFilter',
      attribute: 'message',
      match: 'co',
      value: 'Instantly poll: reply fetch failed',
    },
    {
      id: 'sentry.rules.filters.event_attribute.EventAttributeFilter',
      attribute: 'message',
      match: 'co',
      value: 'Instantly poll: reply polling threw',
    },
  ],
  actions: [
    {
      id: 'sentry.mail.actions.NotifyEmailAction',
      targetType: 'Member',
      targetIdentifier: MEMBER_ID,
    },
  ],
  // 60 min: don't re-alert while the issue is actively ongoing — one alert per hour is enough.
  frequency: 60,
}

async function main() {
  const url = `https://sentry.io/api/0/projects/${ORG}/${PROJECT}/rules/`
  console.log(`Creating alert rule in ${ORG}/${PROJECT}...\n`)

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const body = await res.json() as Record<string, unknown>

  if (!res.ok) {
    console.error(`✗  HTTP ${res.status}: ${JSON.stringify(body)}`)
    process.exit(1)
  }

  console.log(`✓  ${body['name']}  →  rule ID: ${body['id']}`)
}

main()
