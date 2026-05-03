/**
 * One-off script: create 3 Sentry alert rules for send-approved-draft failures.
 * Run once after deploy, capture rule IDs in BACKLOG.md, then keep as reference.
 *
 * Rules created:
 *   1. send-failed-individual   — new/regression issue mentioning sendApprovedDraft, 5m re-alert
 *   2. send-failed-sustained    — >2 events in 1h window, 60m re-alert
 *   3. db-update-failed-after-send — CRITICAL: any issue with db_update_failed_after_send, 5m re-alert
 *
 * Usage: npx tsx scripts/create-sentry-send-alert-rules.ts
 * Requires SENTRY_ALERTS_TOKEN in .env.local (scopes: alerts:write, project:read, org:read)
 *
 * ADR note: one filter per rule (multiple filters AND together — not OR across rules).
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'

function loadEnv(): Record<string, string> {
  const envPath = resolve(process.cwd(), '.env.local')
  const lines = readFileSync(envPath, 'utf-8').split('\n')
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
// User ID 4469242 = Doug Pettit (doug@margenticos.com) — confirmed via Sentry MCP whoami
const MEMBER_ID = 4469242

const BASE_URL = 'https://sentry.io'

const EMAIL_ACTION = {
  id: 'sentry.mail.actions.NotifyEmailAction',
  targetType: 'Member',
  targetIdentifier: MEMBER_ID,
}

const FIRST_SEEN = { id: 'sentry.rules.conditions.first_seen_event.FirstSeenEventCondition' }
const REGRESSION = { id: 'sentry.rules.conditions.regression_event.RegressionEventCondition' }

const msgFilter = (value: string) => ({
  id: 'sentry.rules.filters.event_attribute.EventAttributeFilter',
  attribute: 'message',
  match: 'co',
  value,
})

// EventFrequencyCondition fires when event count exceeds threshold within interval.
// comparisonType: 'count' → absolute count (not % change)
const freqCondition = (count: number, interval: string) => ({
  id: 'sentry.rules.conditions.event_frequency.EventFrequencyCondition',
  value: count,
  comparisonType: 'count',
  interval,
})

const rules = [
  {
    name: 'send-failed-individual',
    // New or regressed issue that mentions sendApprovedDraft — catches every distinct send failure.
    actionMatch: 'any',
    filterMatch: 'all',
    frequency: 5,
    conditions: [FIRST_SEEN, REGRESSION],
    filters: [msgFilter('sendApprovedDraft')],
    actions: [EMAIL_ACTION],
  },
  {
    name: 'send-failed-sustained',
    // Any issue mentions send-approved-draft and fires more than 2 times in 1 hour.
    // Catches a failure that is recurring but not generating new issues (e.g. same retry).
    actionMatch: 'all',
    filterMatch: 'all',
    frequency: 60,
    conditions: [freqCondition(2, '1h')],
    filters: [msgFilter('send-approved-draft')],
    actions: [EMAIL_ACTION],
  },
  {
    name: 'db-update-failed-after-send-CRITICAL',
    // CRITICAL: email is in prospect's inbox but DB row not updated.
    // Requires manual reconciliation. 5m re-alert so it stays loud until resolved.
    actionMatch: 'any',
    filterMatch: 'all',
    frequency: 5,
    conditions: [FIRST_SEEN, REGRESSION],
    filters: [msgFilter('db_update_failed_after_send')],
    actions: [EMAIL_ACTION],
  },
]

async function createRule(rule: (typeof rules)[0]): Promise<{ id: string; name: string }> {
  const url = `${BASE_URL}/api/0/projects/${ORG}/${PROJECT}/rules/`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(rule),
  })

  const body = await res.json() as Record<string, unknown>

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} creating "${rule.name}": ${JSON.stringify(body)}`)
  }

  return { id: String(body['id']), name: String(body['name']) }
}

async function main() {
  console.log(`Creating ${rules.length} Sentry alert rules in ${ORG}/${PROJECT}...\n`)

  for (const rule of rules) {
    try {
      const result = await createRule(rule)
      console.log(`✓  ${result.name}  →  rule ID: ${result.id}`)
    } catch (err) {
      console.error(`✗  ${rule.name}: ${(err as Error).message}`)
    }
  }

  console.log('\nRecord rule IDs in docs/BACKLOG.md under [monitoring].')
}

main()
