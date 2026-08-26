// CACHE RECEIPT — makes REAL, PAID Anthropic calls, so it is OPT-IN and skipped by default.
//
//   RUN_CACHE_PROBE=1 npx vitest run src/lib/agents/research/__tests__/cache-receipt.test.ts
//
// WHY IT EXISTS. Prompt caching fails SILENTLY. One byte of per-prospect data anywhere in
// the prefix and every call quietly reverts to full input price: nothing errors, no test
// goes red, and the only symptom is the bill. The single honest check is
// usage.cache_read_input_tokens on the SECOND prospect of a run. Non-zero means the prefix
// held. Zero means it did not, and we want to know rather than assume.
//
// IT DELIBERATELY DOES NOT RUN THE RESEARCH AGENT. That would fetch paid sources and write
// to prospect_research_results, and re-running research over a prospect whose copy has
// already shipped overwrites it. This builds the same two system prompts the agent builds
// and sends them alongside two DIFFERENT per-prospect user messages, which is exactly the
// condition under test and nothing else.

import { describe, it, expect } from 'vitest'
import path from 'path'
import dotenv from 'dotenv'
import Anthropic from '@anthropic-ai/sdk'
import { buildSynthesisPrompt, buildSignalBlock } from '../prompts/synthesis-prompt'
import { buildWriterPrompt, buildWriterAssignment } from '../write-opening'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const MODEL = 'claude-sonnet-4-6'

// Stand-in client context, padded so the prefix clears Anthropic's ~1024-token minimum
// cacheable length the same way a real client's ICP and positioning documents do.
const CLIENT_CTX = {
  clientName: 'Probe Consulting',
  icpSummary: 'Tier 1 buyer: founder or managing partner. '.repeat(12),
  positioningSummary: 'Positioning: senior delivery without a hiring round. '.repeat(12),
  valuePropContext: 'Cold outreach hook: pipeline that does not depend on referrals. '.repeat(12),
  tovRules: 'Write plainly. No em dashes. No jargon. '.repeat(12),
}

interface Usage {
  input_tokens?: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

function line(label: string, prospect: number, u: Usage): number {
  const read = u.cache_read_input_tokens ?? 0
  console.log(
    `  prospect ${prospect} | ${label.padEnd(9)}` +
    ` input ${String(u.input_tokens ?? 0).padStart(6)}` +
    `  cache_write ${String(u.cache_creation_input_tokens ?? 0).padStart(6)}` +
    `  cache_read ${String(read).padStart(6)}`,
  )
  return read
}

describe.runIf(process.env.RUN_CACHE_PROBE)('prompt cache receipt (live API)', () => {
  it('reads from cache on the second prospect for both large prompts', async () => {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    const synthesisSystem = buildSynthesisPrompt(CLIENT_CTX)
    const writerSystem = buildWriterPrompt()
    const assignment = buildWriterAssignment({
      clientName: CLIENT_CTX.clientName,
      p3: 'We run outbound so the calls arrive without you touching it.',
      cta: 'Is this a gap you are looking to close?',
    })

    console.log(`\nsystem prompt chars — synthesis ${synthesisSystem.length}, writer ${writerSystem.length}\n`)

    let synthesisRead = 0
    let writerRead = 0

    for (const n of [1, 2]) {
      // Per-prospect content, different on every call. If any of it had leaked into a
      // system prompt, prospect 2 would miss, which is the whole point of the probe.
      const synthesisUser =
        `## Prospect\n\nName: Probe Person ${n}\nRole: Founder\nCompany: Probe Co ${n}\n\n` +
        `## Recency check\n\n${buildSignalBlock(`Prospect ${n} posted about opening a second office.`)}\n\n` +
        `## Research gathered\n\nNothing of note for probe ${n}.\n\nReply with the single word OK.`

      const s = await client.messages.create({
        model: MODEL,
        max_tokens: 16,
        // cache_control MUST TRACK THE SHIPPED CODE. This probe builds its own request rather
        // than calling synthesize.ts, so a change there does not propagate here. If these
        // drift, the probe measures a cache configuration nobody ships. Currently the
        // 5-minute default: the 1-hour TTL was tried and reverted on 2026-08-26.
        system: [{ type: 'text', text: synthesisSystem, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: synthesisUser }],
      })
      synthesisRead = line('synthesis', n, s.usage as Usage)

      const writerUser =
        `${assignment}\n\n## Findings\n\n1. Probe finding for prospect ${n}.\n\n` +
        `Reply with the single word OK.`

      const w = await client.messages.create({
        model: MODEL,
        max_tokens: 16,
        system: [{ type: 'text', text: writerSystem, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: writerUser }],
      })
      writerRead = line('writer', n, w.usage as Usage)
    }

    console.log(`\n  RECEIPT — synthesis cache_read ${synthesisRead}, writer cache_read ${writerRead}\n`)

    expect(synthesisRead).toBeGreaterThan(0)
    expect(writerRead).toBeGreaterThan(0)
  }, 120_000)
})
