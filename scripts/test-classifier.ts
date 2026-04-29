/**
 * Synthetic classifier test — all 8 intents + 3 edge cases.
 * Operator-only script. Not deployed. Run once to eyeball output.
 *
 * Usage: npx tsx scripts/test-classifier.ts
 * Requires ANTHROPIC_API_KEY in .env.local.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'

// Load .env.local before importing the classifier (it reads process.env at call time)
const envPath = resolve(process.cwd(), '.env.local')
const lines = readFileSync(envPath, 'utf-8').split('\n')
for (const line of lines) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eq = trimmed.indexOf('=')
  if (eq === -1) continue
  process.env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
}

import { classifyReply } from '../src/lib/agents/reply-classifier'

interface TestCase {
  label: string
  subject?: string
  body: string
}

const cases: TestCase[] = [
  // ── Core 8 intents ───────────────────────────────────────────────────────────
  {
    label: 'opt_out — standard refusal',
    body: 'Stop emailing me, not interested.',
  },
  {
    label: 'opt_out — hostile phrasing',
    body: 'Take me off your list now. This is the second time.',
  },
  {
    label: 'out_of_office — dated return',
    subject: 'Out of Office: Auto-Reply',
    body: `Hi, I'm out of office until Nov 12. For urgent matters please contact my colleague Sarah at sarah@company.com. I'll respond to your email when I return.`,
  },
  {
    label: 'positive_direct_booking — explicit ask',
    body: "Yes, send me your calendar — happy to chat next week. What timezone are you in?",
  },
  {
    label: 'positive_passive — warm but non-committal',
    body: "Sounds interesting, tell me more about how it works. We've been looking at options in this space.",
  },
  {
    label: 'information_request_generic — FAQ-scope question',
    body: "Do you work with companies under 50 employees? Most of what I've seen is geared toward larger teams.",
  },
  {
    label: 'information_request_commercial — pricing / contract',
    body: "What does this typically cost for a team our size? We have 8 people and are comparing a few options.",
  },
  {
    label: 'objection_mild — soft deferral',
    body: "Not the right time for us — maybe circle back next quarter. Things are pretty hectic right now.",
  },
  {
    label: 'unclear — ambiguous forward',
    body: "Forwarded to my colleague.",
  },

  // ── Edge cases ───────────────────────────────────────────────────────────────
  {
    label: 'edge — mixed: positive interest + pricing question',
    body: `Thanks for reaching out — this does look relevant and I'd love to learn more.
Quick question though: what does pricing look like? We're a 12-person team and have a fairly tight budget this quarter. If the numbers work I'd definitely be open to a call.`,
  },
  {
    label: 'edge — opt_out implicit (no explicit "stop" but clear refusal)',
    body: "We already have a vendor handling this and we're happy with them. Please don't reach out again.",
  },
  {
    label: 'edge — OOO with no return date',
    subject: 'Automatic reply: Re: Quick question',
    body: `Thank you for your email. I am currently out of the office with limited access to email. I will respond upon my return.`,
  },
]

async function main() {
  const width = 80
  const divider = '─'.repeat(width)

  console.log('\n' + '═'.repeat(width))
  console.log('  CLASSIFIER SYNTHETIC TEST — ' + new Date().toISOString())
  console.log('═'.repeat(width))

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i]
    console.log(`\n${divider}`)
    console.log(`[${i + 1}/${cases.length}] ${tc.label}`)
    console.log(divider)

    if (tc.subject) {
      console.log(`Subject : ${tc.subject}`)
    }
    const bodyPreview = tc.body.replace(/\n/g, ' ').slice(0, 120)
    console.log(`Body    : ${bodyPreview}${tc.body.length > 120 ? '…' : ''}`)
    console.log()

    const result = await classifyReply(tc.body, tc.subject)

    if (!result) {
      console.log('RESULT  : null — classifier call failed (API error or bad JSON)')
    } else {
      const confidenceBar = '█'.repeat(Math.round(result.confidence * 10))
        + '░'.repeat(10 - Math.round(result.confidence * 10))
      console.log(`Intent  : ${result.intent}`)
      console.log(`Confidence: ${result.confidence.toFixed(3)}  ${confidenceBar}`)
      console.log(`Reasoning: ${result.reasoning}`)
    }
  }

  console.log('\n' + '═'.repeat(width))
  console.log('  DONE')
  console.log('═'.repeat(width) + '\n')
}

main().catch(err => {
  console.error('Test script failed:', err)
  process.exit(1)
})
