// Haiku-powered bridge sentence for Email 1.
// Called by compose-sequence.ts after the trigger is applied.
//
// The bridge is ADDITIVE: it inserts one sentence after the trigger. It never
// overwrites client-approved template copy.
//
// The CTA rewrite that used to live here was removed. It replaced the approved
// template CTA on every prospect and produced worse copy than the line it
// overwrote, even when a genuine researched trigger was available. Along with it
// went normalizeCompanyReference, which existed only to decide whether a company
// name was safe to drop into that CTA.
//
// Gated by the caller on has_dateable_signal + signal_relevance = 'use_as_hook'.
// On any Haiku failure: returns a null bridge (never throws), so composition
// falls through to the approved template unchanged.

import Anthropic from '@anthropic-ai/sdk'
import type { TextBlock } from '@anthropic-ai/sdk/resources/messages'
import { logger } from '@/lib/logger'
import { scrubAITells } from '@/lib/style/customer-facing-style-rules'

const PERSONALIZATION_MODEL = 'claude-haiku-4-5-20251001'

export interface BridgeInput {
  triggerText: string
  prospectRole: string | null
  prospectFirstName: string | null
  clientValueHook: string
}

export interface BridgeOutput {
  bridge: string | null
}

export async function generateBridge(input: BridgeInput): Promise<BridgeOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    logger.error('personalization: ANTHROPIC_API_KEY not set')
    return { bridge: null }
  }

  const client = new Anthropic({ apiKey })

  const systemPrompt = `You write short personalization sentences for B2B cold email.
Rules: no em dashes, no "leverage", no "seamless", no "robust", no assumption language.
Every sentence must be defensible. Only state what the trigger actually established.
Never start a sentence with I or We.`

  const userMessage = `Trigger sentence in this email: "${input.triggerText}"
Prospect role: ${input.prospectRole ?? 'not provided'}
What the sender solves: ${input.clientValueHook}

Generate this exact JSON:
{
  "bridge": "[10-20 word sentence connecting the trigger to the pain the sender solves. Defensible, no new claims, no numbers or benchmarks unless the trigger stated them.]"
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

    const rawBridge = typeof parsed.bridge === 'string' ? parsed.bridge.trim() : null
    const bridge = rawBridge ? scrubAITells(rawBridge, 'composition/bridge') : null

    logger.debug('personalization: bridge generated', {
      has_bridge: !!bridge,
      bridge_preview: bridge?.slice(0, 60),
    })

    return { bridge }

  } catch (err) {
    logger.error('personalization: Haiku bridge call failed', { error: String(err) })
    return { bridge: null }
  }
}

// ─── Word count helper ────────────────────────────────────────────────────────

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}
