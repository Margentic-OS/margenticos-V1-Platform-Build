#!/usr/bin/env npx tsx
/**
 * Grade prospects from the research evidence already on file, and WRITE NOTHING.
 *
 *   npx tsx --env-file=.env.local scripts/grade-from-evidence.ts --org <uuid> --ids <id,id,...> --max-usd <n> [--out <file.json>]
 *
 * Each prospect is graded from the newest research record that holds evidence
 * (src/lib/agents/research/evidence-record.ts), not from its current record, which a reuse run
 * may have left empty. No source is fetched, no copy is touched and no grade is stored: the
 * results are printed, and written to --out when it is given. Point --out at a gitignored path
 * such as logs/, because the output names real prospects.
 *
 * --max-usd is a hard ceiling. Before each call the script reserves the largest call seen so
 * far, and it stops starting calls once the next one could cross the ceiling.
 */

import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { writeFileSync } from 'node:fs'
import { gradeFromEvidence, type EvidenceGrade } from '@/lib/agents/research/grade-from-evidence'

// Sonnet 4.6 list prices per million tokens; the cache write is the 5-minute rate.
const PRICE = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function usage(message: string): never {
  console.error(`\n${message}\n\nUsage: npx tsx --env-file=.env.local scripts/grade-from-evidence.ts --org <uuid> --ids <id,id,...> --max-usd <n> [--out <file.json>]\n`)
  process.exit(1)
}

async function main() {
  const orgId = arg('org') ?? usage('Missing --org.')
  const ids = (arg('ids') ?? usage('Missing --ids.')).split(',').map(s => s.trim()).filter(Boolean)
  const cap = Number(arg('max-usd') ?? usage('Missing --max-usd.'))
  if (!(cap > 0)) usage('--max-usd must be a positive number.')
  const out = arg('out')

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  // 600s, the SDK default and what production's synthesis client runs with. An answer runs to
  // 16,000 tokens and was measured taking six and a half minutes; the 240s this script first
  // used timed out on the seventh of twelve. ONE retry, not three: a timed-out request may
  // still have been billed, so every retry is possibly a second charge for the same prospect.
  const real = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 600_000, maxRetries: 1 })

  let spent = 0, largest = 0.25, calls = 0, failed = 0
  // Wraps the client only to meter it. The grader sees an ordinary messages.create.
  const metered = {
    messages: {
      create: async (params: Parameters<Anthropic['messages']['create']>[0]) => {
        const msg = await real.messages.create(params as never) as Anthropic.Message
        const u = msg.usage
        const cost = (u.input_tokens * PRICE.input + u.output_tokens * PRICE.output +
          (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite + (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead) / 1e6
        spent += cost; calls++; largest = Math.max(largest, cost)
        return msg
      },
    },
  }

  const results: Array<EvidenceGrade | { prospect_id: string; skipped?: string; error?: string }> = []
  // Saved after EVERY prospect. The first run saved only at the end, and when its seventh call
  // timed out, the six grades already paid for survived only in the terminal.
  const save = (partial: boolean) => {
    if (out) writeFileSync(out, JSON.stringify({ partial, calls, failed, spent_usd: Number(spent.toFixed(4)), cap_usd: cap, results }, null, 1))
  }
  for (const id of ids) {
    if (spent + largest > cap) { results.push({ prospect_id: id, skipped: 'spend cap' }); save(true); continue }
    try {
      const r = await gradeFromEvidence({ supabase, anthropic: metered as never, prospect_id: id, client_id: orgId })
      results.push(r)
      const s = r.synthesis
      const checks = s ? Object.entries(s.fit_checks).map(([k, v]) => `${k}=${v.result}`).join(' ') : ''
      console.log(`${id.slice(0, 8)}  ${s ? s.icp_fit.padEnd(11) : 'NO GRADE   '} from ${r.evidence_record_id?.slice(0, 8) ?? '-'} (${r.evidence_from?.slice(0, 16) ?? '-'})  ${checks}  ${s?.icp_fit_missing ?? r.reason ?? ''}`)
    } catch (e) {
      // Recorded, not fatal. A failed call is NOT in the spend tally and may still have been
      // billed, which the summary line says out loud.
      failed++
      const message = e instanceof Error ? e.message : String(e)
      results.push({ prospect_id: id, error: message })
      console.log(`${id.slice(0, 8)}  FAILED     ${message}`)
    } finally {
      save(true)
    }
  }

  // A spend tally that saw no call when calls were expected is a broken tally, not a zero.
  if (calls === 0 && results.some(r => 'synthesis' in r && r.synthesis)) throw new Error('graded without the meter seeing a call')
  save(false)
  console.log(`\n${calls} calls, $${spent.toFixed(4)} of $${cap} cap, ${results.filter(r => 'synthesis' in r && r.synthesis).length} graded, ${failed} failed (a failed call is not in the tally and may have been billed)`)
}

main().then(() => process.exit(0)).catch(e => { console.error('FAILED: ' + (e instanceof Error ? e.message : e)); process.exit(1) })
