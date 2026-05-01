/**
 * One-off script: replace the two compound-filter Sentry alert rules with four
 * single-filter rules so they can actually fire.
 *
 * Root cause: Sentry issue alert `filters` use AND logic. A rule with two
 * message-contains filters requires BOTH strings in one event simultaneously —
 * impossible when each filter targets a different error message from a different
 * code path. The rules existed and appeared configured but could never trigger.
 *
 * Fix: delete 553483 (reply-send-failed) and 553534 (polling-failures-sustained),
 * replace with four single-filter rules — one per target message string.
 *
 * Usage: npx tsx scripts/fix-sentry-alert-rules.ts
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
const BASE = 'https://sentry.io'

const RULES_TO_DELETE = [553483, 553534]

const EMAIL_ACTION = {
  id: 'sentry.mail.actions.NotifyEmailAction',
  targetType: 'Member',
  targetIdentifier: MEMBER_ID,
}

const FIRST_SEEN  = { id: 'sentry.rules.conditions.first_seen_event.FirstSeenEventCondition' }
const REGRESSION  = { id: 'sentry.rules.conditions.regression_event.RegressionEventCondition' }

const msgFilter = (value: string) => ({
  id: 'sentry.rules.filters.event_attribute.EventAttributeFilter',
  attribute: 'message',
  match: 'co',
  value,
})

const freqCondition = {
  id: 'sentry.rules.conditions.event_frequency.EventFrequencyCondition',
  value: 2,
  interval: '1h',
}

// Four single-filter rules replacing the two broken compound-filter rules.
const NEW_RULES = [
  // ── Replacing 553483 (reply-send-failed) ──────────────────────────────────
  {
    name: 'reply-send-failed-runtime',
    actionMatch: 'any',
    filterMatch: 'all',
    frequency: 5,
    conditions: [FIRST_SEEN, REGRESSION],
    filters: [msgFilter('sendThreadReply failed')],
    actions: [EMAIL_ACTION],
  },
  {
    name: 'reply-send-failed-on-retry',
    actionMatch: 'any',
    filterMatch: 'all',
    frequency: 5,
    conditions: [FIRST_SEEN, REGRESSION],
    filters: [msgFilter('send_reply API failed on previous run')],
    actions: [EMAIL_ACTION],
  },
  // ── Replacing 553534 (polling-failures-sustained) ─────────────────────────
  {
    name: 'polling-fetch-failed',
    actionMatch: 'all',
    filterMatch: 'all',
    frequency: 60,
    conditions: [freqCondition],
    filters: [msgFilter('Instantly poll: reply fetch failed')],
    actions: [EMAIL_ACTION],
  },
  {
    name: 'polling-uncaught-throw',
    actionMatch: 'all',
    filterMatch: 'all',
    frequency: 60,
    conditions: [freqCondition],
    filters: [msgFilter('Instantly poll: reply polling threw')],
    actions: [EMAIL_ACTION],
  },
]

async function deleteRule(id: number): Promise<void> {
  const res = await fetch(`${BASE}/api/0/projects/${ORG}/${PROJECT}/rules/${id}/`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok && res.status !== 404) {
    const body = await res.text()
    throw new Error(`HTTP ${res.status} deleting rule ${id}: ${body}`)
  }
}

async function createRule(rule: (typeof NEW_RULES)[0]): Promise<{ id: string; name: string }> {
  const res = await fetch(`${BASE}/api/0/projects/${ORG}/${PROJECT}/rules/`, {
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
  console.log('Step 1 — Deleting broken compound-filter rules...\n')
  for (const id of RULES_TO_DELETE) {
    try {
      await deleteRule(id)
      console.log(`✓  Deleted rule ${id}`)
    } catch (err) {
      console.error(`✗  Rule ${id}: ${(err as Error).message}`)
      process.exit(1)
    }
  }

  console.log('\nStep 2 — Creating four single-filter replacement rules...\n')
  const created: Array<{ id: string; name: string }> = []
  for (const rule of NEW_RULES) {
    try {
      const result = await createRule(rule)
      created.push(result)
      console.log(`✓  ${result.name}  →  rule ID: ${result.id}`)
    } catch (err) {
      console.error(`✗  ${rule.name}: ${(err as Error).message}`)
      process.exit(1)
    }
  }

  console.log('\nAll done. New rule IDs:')
  for (const r of created) console.log(`  ${r.id}  ${r.name}`)
}

main()
