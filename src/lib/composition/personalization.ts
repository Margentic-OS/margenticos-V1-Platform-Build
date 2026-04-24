// Haiku-powered bridge sentence + personalized CTA for Email 1.
// Called by compose-sequence.ts after trigger is applied.
// Bridge: Tier 1 only. CTA: all tiers.
// Both scrubbed through scrubAITells() before return.
// On any Haiku failure: returns null bridge + generic CTA (never throws).

import Anthropic from '@anthropic-ai/sdk'
import type { TextBlock } from '@anthropic-ai/sdk/resources/messages'
import { logger } from '@/lib/logger'
import { scrubAITells } from '@/lib/style/customer-facing-style-rules'

const PERSONALIZATION_MODEL = 'claude-haiku-4-5-20251001'

export interface PersonalizationInput {
  tier: string
  triggerText: string
  prospectRole: string | null
  prospectCompany: string | null
  clientValueHook: string
}

export interface PersonalizationOutput {
  bridge: string | null
  cta: string
}

export async function generatePersonalization(
  input: PersonalizationInput,
): Promise<PersonalizationOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    logger.error('personalization: ANTHROPIC_API_KEY not set')
    return { bridge: null, cta: FALLBACK_CTA }
  }

  const isTier1 = input.tier === 'tier1'
  const client  = new Anthropic({ apiKey })

  const systemPrompt = `You write short personalization sentences for B2B cold email.
Rules: no em dashes, no "leverage", no "seamless", no "robust", no assumption language.
Every sentence must be defensible — only state what the trigger actually established.
Never start a sentence with I or We.`

  const bridgeInstruction = isTier1
    ? `"bridge": one sentence (10-20 words) connecting the specific observation in the trigger to the pain the sender solves. Only state what the trigger established — no new claims, no numbers or benchmarks unless the trigger stated them.`
    : null

  const userMessage = `Trigger sentence in this email: "${input.triggerText}"
Prospect role: ${input.prospectRole ?? 'not provided'}
Prospect company: ${input.prospectCompany ?? 'not provided'}
What the sender solves: ${input.clientValueHook}

Generate this exact JSON:
{${isTier1 ? `\n  "bridge": "[10-20 word sentence connecting trigger to pain — defensible, no new claims]",` : ''}
  "cta": "[8-12 word question personalizing the ask — uses company or role if known]"
}

Return only the JSON object. No other text.`

  try {
    const response = await client.messages.create({
      model: PERSONALIZATION_MODEL,
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    })

    const textBlock = response.content.find((b): b is TextBlock => b.type === 'text')
    if (!textBlock) throw new Error('no text block in response')

    const text  = textBlock.text.trim()
    const start = text.indexOf('{')
    const end   = text.lastIndexOf('}')
    if (start === -1 || end === -1) throw new Error(`no JSON object in response: ${text.slice(0, 100)}`)

    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>

    const rawBridge = isTier1 && typeof parsed.bridge === 'string' ? parsed.bridge.trim() : null
    const rawCta    = typeof parsed.cta === 'string' ? parsed.cta.trim() : null

    const bridge = rawBridge ? scrubAITells(rawBridge, 'composition/bridge') : null
    const cta    = rawCta    ? scrubAITells(rawCta,    'composition/cta')    : FALLBACK_CTA

    logger.debug('personalization: generated', {
      tier: input.tier,
      has_bridge: !!bridge,
      cta_preview: cta.slice(0, 60),
    })

    return { bridge, cta }

  } catch (err) {
    logger.error('personalization: Haiku call failed', {
      error: String(err),
      tier: input.tier,
      company: input.prospectCompany,
    })
    return { bridge: null, cta: FALLBACK_CTA }
  }
}

const FALLBACK_CTA = 'Worth a quick call to see if it fits?'

// ─── Word count helper ────────────────────────────────────────────────────────

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}
