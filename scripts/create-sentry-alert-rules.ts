/**
 * One-off script: create the two Phase 1 reply-handling Sentry alert rules.
 * Run once, capture rule IDs, then keep as reference or delete.
 *
 * Usage: npx tsx scripts/create-sentry-alert-rules.ts
 * Requires SENTRY_ALERTS_TOKEN in .env.local (scopes: alerts:write, project:read, org:read)
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env.local without a full dotenv dependency
function loadEnv(): Record<string, string> {
  const envPath = resolve(process.cwd(), '.env.local');
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  const env: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

const env = loadEnv();
const token = env['SENTRY_ALERTS_TOKEN'];
if (!token) {
  console.error('SENTRY_ALERTS_TOKEN not found in .env.local');
  process.exit(1);
}

const ORG = 'margentic-os';
const PROJECT = 'margenticos';
// User ID 4469242 = Doug Pettit (doug@margenticos.com) — confirmed via Sentry MCP whoami
const MEMBER_ID = 4469242;

const BASE_URL = 'https://sentry.io';

const EMAIL_ACTION = {
  id: 'sentry.mail.actions.NotifyEmailAction',
  targetType: 'Member',
  targetIdentifier: MEMBER_ID,
};

// Sentry's current API separates trigger conditions from event filters.
// Conditions = what kind of activity triggers the rule (e.g. new issue, regression).
// Filters = narrow which events actually fire the action (e.g. message contains X).
// EventAttributeCondition is deprecated — message matching now belongs in filters.

const FIRST_SEEN = { id: 'sentry.rules.conditions.first_seen_event.FirstSeenEventCondition' };
const REGRESSION = { id: 'sentry.rules.conditions.regression_event.RegressionEventCondition' };

const msgFilter = (value: string) => ({
  id: 'sentry.rules.filters.event_attribute.EventAttributeFilter',
  attribute: 'message',
  match: 'co',
  value,
});

const rules = [
  {
    name: 'reply-send-failed',
    // Fire when a new issue is seen OR a resolved one regresses — covers every distinct failure.
    // filterMatch "any" means: message contains A OR message contains B.
    actionMatch: 'any',
    filterMatch: 'any',
    frequency: 5,
    conditions: [FIRST_SEEN, REGRESSION],
    filters: [
      msgFilter('send_reply API failed on previous run'),
      msgFilter('sendThreadReply failed'),
    ],
    actions: [EMAIL_ACTION],
  },
  {
    name: 'reply-classifier-permanently-failed',
    actionMatch: 'any',
    filterMatch: 'all',
    frequency: 5,
    conditions: [FIRST_SEEN, REGRESSION],
    filters: [msgFilter('classifier retry limit reached')],
    actions: [EMAIL_ACTION],
  },
];

async function createRule(rule: (typeof rules)[0]): Promise<{ id: string; name: string }> {
  const url = `${BASE_URL}/api/0/projects/${ORG}/${PROJECT}/rules/`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(rule),
  });

  const body = await res.json() as Record<string, unknown>;

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} creating "${rule.name}": ${JSON.stringify(body)}`);
  }

  return { id: String(body['id']), name: String(body['name']) };
}

async function main() {
  console.log(`Creating ${rules.length} Sentry alert rules in ${ORG}/${PROJECT}...\n`);

  for (const rule of rules) {
    try {
      const result = await createRule(rule);
      console.log(`✓  ${result.name}  →  rule ID: ${result.id}`);
    } catch (err) {
      console.error(`✗  ${rule.name}: ${(err as Error).message}`);
    }
  }
}

main();
