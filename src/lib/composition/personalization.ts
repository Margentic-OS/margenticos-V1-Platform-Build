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
  prospectFirstName: string | null
  prospectLastName: string | null
  clientValueHook: string
}

export interface PersonalizationOutput {
  bridge: string | null
  cta: string
}

// ─── Company reference normaliser ─────────────────────────────────────────────
// Returns a clean, abbreviated company reference for use in the Haiku CTA prompt.
// Returns null when the company name should not be used (personal-name overlap,
// URL-only input, all-generic-suffix, or too short after normalisation).
//
// Cases handled in order:
//   1. Empty/null input → null
//   2. URL artifact stripping (https://, www., known TLDs: .com, .io, .co.uk, etc.)
//   3. Hyphen/underscore → spaces
//   4. Generic suffix words stripped from the right repeatedly (Ltd, Marketing, etc.)
//      Trailing "and"/"&" connectors are stripped after each suffix removal
//   5. Abbreviate: first distinctive word; skip leading qualifiers (The/A/An)
//      Heuristic: single first word. "Bold Clarity" → "Bold" is acceptable.
//      Future tuning: keep two words if single-word results drop meaningful context.
//   6. Personal-name overlap: word-boundary check against prospect first + last name → null
//   7. Sanity: empty or single-character result → null

const SUFFIX_WORDS: ReadonlySet<string> = new Set([
  'ltd', 'limited', 'inc', 'llc', 'corp', 'corporation',
  'consulting', 'consultants', 'solutions', 'services',
  'group', 'marketing', 'coaching', 'business', 'strategic',
  'advisors', 'advisory', 'partners', 'studio', 'agency',
  'and', '&',
])

const LEADING_QUALIFIERS: ReadonlySet<string> = new Set(['the', 'a', 'an'])

const URL_TLD_RE = /\.(com|co\.uk|io|ai|net|org|co|biz|info|co\.nz|com\.au)$/i

export function normalizeCompanyReference(
  companyName: string | null,
  firstName: string | null,
  lastName: string | null,
): string | null {
  if (!companyName || companyName.trim().length === 0) return null

  let name = companyName.trim()

  // Strip URL artifacts — protocol prefix, www., and known TLD suffixes.
  if (/^https?:\/\//i.test(name) || /^www\./i.test(name) || URL_TLD_RE.test(name)) {
    name = name
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(URL_TLD_RE, '')
      .replace(/[-_]/g, ' ')
      .trim()
  }

  // Normalise remaining hyphens/underscores to spaces.
  name = name.replace(/[-_]/g, ' ').trim()

  // Strip generic suffix words from the right, one at a time, until no more remain.
  const words = name.split(/\s+/).filter(w => w.length > 0)
  let changed = true
  while (changed && words.length > 0) {
    changed = false
    const last = words[words.length - 1].toLowerCase().replace(/[.,;:]/g, '')
    if (SUFFIX_WORDS.has(last)) {
      words.pop()
      changed = true
    }
  }

  if (words.length === 0) return null

  // Abbreviate to first distinctive word; skip leading article qualifiers.
  let startIdx = 0
  if (LEADING_QUALIFIERS.has(words[0].toLowerCase()) && words.length > 1) startIdx = 1

  // Capitalize first letter — handles URL-derived lowercase (e.g. "ascend" from "ascend.com").
  let ref = words[startIdx]
  ref = ref.charAt(0).toUpperCase() + ref.slice(1)

  if (ref.length <= 1) return null

  // Personal-name overlap: if the abbreviated reference IS the prospect's first or last name,
  // using it in a CTA reads as third-person about the person ("How does Helen Cox handle...").
  // Return null to force second-person phrasing instead.
  const refLower = ref.toLowerCase()
  const firstLower = firstName?.toLowerCase() ?? ''
  const lastLower  = lastName?.toLowerCase()  ?? ''
  if (firstLower && new RegExp(`\\b${escapeRegex(firstLower)}\\b`).test(refLower)) return null
  if (lastLower  && new RegExp(`\\b${escapeRegex(lastLower)}\\b`).test(refLower))  return null

  return ref
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

  const company_reference = normalizeCompanyReference(
    input.prospectCompany,
    input.prospectFirstName,
    input.prospectLastName,
  )

  const systemPrompt = `You write short personalization sentences for B2B cold email.
Rules: no em dashes, no "leverage", no "seamless", no "robust", no assumption language.
Every sentence must be defensible — only state what the trigger actually established.
Never start a sentence with I or We.`

  const bridgeInstruction = isTier1
    ? `"bridge": one sentence (10-20 words) connecting the specific observation in the trigger to the pain the sender solves. Only state what the trigger established — no new claims, no numbers or benchmarks unless the trigger stated them.`
    : null

  // CTA instruction is set by code, not Haiku — normaliser already decided whether to use a
  // company reference or fall back to second person. Haiku gets a clear directive, not a judgment.
  const ctaNote = company_reference
    ? `CTA: use "${company_reference}" naturally in the question.`
    : `CTA: second person only — use "you" or "your". Do not reference any company name.`

  const userMessage = `Trigger sentence in this email: "${input.triggerText}"
Prospect role: ${input.prospectRole ?? 'not provided'}
Company reference: ${company_reference ?? 'none'}
What the sender solves: ${input.clientValueHook}

${ctaNote}

Generate this exact JSON:
{${isTier1 ? `\n  "bridge": "[10-20 word sentence connecting trigger to pain — defensible, no new claims]",` : ''}
  "cta": "[8-12 word question]"
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
      company_reference,
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
