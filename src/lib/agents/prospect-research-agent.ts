// Prospect Research Agent
// Entry point: prospect-research-agent.ts
// Model: claude-haiku-4-5-20251001
// Prompt: /docs/prompts/prospect-research-agent.md
//
// Finds one business-relevant personalisation trigger per prospect using
// the Trigger-Bridge-Value (TBV) framework. Research sequence:
//   1. Apollo people enrichment (primary)
//   2. Web search for Google-indexed public content (secondary)
//   3. Company website fetch (tertiary)
//   4. Role-based pain proxy from client's ICP document (fallback)
//
// No LinkedIn scraping — see ADR-005.
// Client isolation enforced at DB + application level — see ADR-003.

import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { startAgentRun } from '@/lib/agents/log-agent-run'
import { webSearch } from '@/lib/agents/tools/webSearch'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TBVResult {
  trigger: string
  bridge: string
  value: string
  source: 'apollo' | 'web_search' | 'website_fetch' | 'pain_proxy'
  confidence: 'high' | 'medium' | 'low'
  research_notes: string
}

export interface ProspectResearchInput {
  prospect_id: string
  client_id: string
}

export interface BatchInput {
  prospect_ids: string[]
  client_id: string
  skip_existing?: boolean
}

export interface BatchSummary {
  total: number
  completed: number
  skipped: number
  failed: number
}

interface ProspectRecord {
  id: string
  first_name: string | null
  last_name: string | null
  company_name: string | null
  role: string | null
  linkedin_url: string | null
  personalisation_trigger: string | null
  organisation_id: string
}

// ─── Supabase service client ──────────────────────────────────────────────────
// Service role bypasses RLS — we still apply explicit organisation_id filters
// on every query (ADR-003 application-level enforcement).

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('prospect-research-agent: missing Supabase env vars')
  return createClient(url, key)
}

// ─── Apollo enrichment ────────────────────────────────────────────────────────

interface ApolloEmployment {
  title?: string
  organization_name?: string
  start_date?: string
  end_date?: string
  current?: boolean
}

interface ApolloOrganization {
  estimated_num_employees?: number
  industry?: string
  short_description?: string
  job_postings?: Array<{ title?: string }>
}

interface ApolloPerson {
  id?: string
  first_name?: string
  last_name?: string
  title?: string
  seniority?: string
  departments?: string[]
  employment_history?: ApolloEmployment[]
  organization?: ApolloOrganization
}

interface ApolloResponse {
  person?: ApolloPerson
  status?: string
}

async function callApolloEnrichment(prospect: ProspectRecord): Promise<string> {
  const apiKey = process.env.APOLLO_API_KEY
  if (!apiKey) throw new Error('APOLLO_API_KEY not set')

  const body: Record<string, unknown> = {
    reveal_personal_emails: false,
    reveal_phone_number: false,
  }
  if (prospect.first_name) body.first_name = prospect.first_name
  if (prospect.last_name) body.last_name = prospect.last_name
  if (prospect.company_name) body.organization_name = prospect.company_name
  if (prospect.linkedin_url) body.linkedin_url = prospect.linkedin_url

  const response = await fetch('https://api.apollo.io/api/v1/people/match', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
  })

  if (response.status === 429) throw new Error('Apollo API rate limit (429)')
  if (!response.ok) throw new Error(`Apollo API error: ${response.status}`)

  const data = await response.json() as ApolloResponse
  if (!data.person) return ''

  const p = data.person
  const org = p.organization

  const lines: string[] = []

  // Current role
  if (p.title) lines.push(`Current title: ${p.title}`)
  if (p.seniority) lines.push(`Seniority: ${p.seniority}`)
  if (p.departments?.length) lines.push(`Department: ${p.departments.join(', ')}`)

  // Employment history — detect title changes in last 12 months
  if (p.employment_history?.length) {
    const sorted = [...p.employment_history].sort((a, b) => {
      const da = a.start_date ? new Date(a.start_date).getTime() : 0
      const db = b.start_date ? new Date(b.start_date).getTime() : 0
      return db - da
    })
    const recent = sorted.slice(0, 3)
    lines.push('Recent employment history:')
    for (const job of recent) {
      const since = job.start_date ? ` (since ${job.start_date})` : ''
      const until = job.end_date ? ` to ${job.end_date}` : job.current ? ' – present' : ''
      lines.push(`  - ${job.title ?? 'Unknown title'} at ${job.organization_name ?? 'Unknown company'}${since}${until}`)
    }
  }

  // Company signals
  if (org) {
    if (org.estimated_num_employees) lines.push(`Company headcount: ~${org.estimated_num_employees}`)
    if (org.industry) lines.push(`Industry: ${org.industry}`)
    if (org.short_description) lines.push(`Company description: ${org.short_description}`)
    if (org.job_postings?.length) {
      lines.push(`Active job postings (${org.job_postings.length}):`)
      org.job_postings.slice(0, 5).forEach(j => {
        if (j.title) lines.push(`  - ${j.title}`)
      })
    }
  }

  return lines.join('\n')
}

// ─── Company website fetch ────────────────────────────────────────────────────

async function fetchCompanyWebsite(prospect: ProspectRecord): Promise<string> {
  // Build URL from company name as a fallback
  let url = ''
  if (prospect.company_name) {
    const slug = prospect.company_name.toLowerCase().replace(/[^a-z0-9]+/g, '')
    url = `https://www.${slug}.com`
  }
  if (!url) return ''

  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research-bot/1.0)' },
    signal: AbortSignal.timeout(8000),
  })

  if (!response.ok) throw new Error(`Website fetch failed: ${response.status}`)

  const html = await response.text()

  // Strip tags and collapse whitespace — keep first 3000 chars for the prompt
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000)

  return text
}

// ─── ICP pain proxy ───────────────────────────────────────────────────────────

async function fetchICPPainProxy(client_id: string): Promise<string> {
  const supabase = getServiceClient()
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('content')
    .eq('organisation_id', client_id)
    .eq('document_type', 'icp')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error || !data?.content) return ''

  // Navigate to tier_1.four_forces.push and tier_1.buyer_profile
  const content = data.content as Record<string, unknown>
  const tier1 = content.tier_1 as Record<string, unknown> | undefined
  if (!tier1) return ''

  const forces = tier1.four_forces as Record<string, unknown> | undefined
  const push: string[] = (forces?.push as string[] | undefined) ?? []
  const buyer = tier1.buyer_profile as Record<string, unknown> | undefined
  const buyerTitle = (buyer?.title as string | undefined) ?? 'decision-maker'
  const companyProfile = tier1.company_profile as Record<string, unknown> | undefined
  const companyType = (companyProfile?.stage as string | undefined) ?? 'B2B company'

  if (!push.length) return ''

  return [
    `ICP Tier 1 buyer title: ${buyerTitle}`,
    `ICP Tier 1 company type: ${companyType}`,
    `Top push forces (pain points):`,
    ...push.slice(0, 3).map(p => `  - ${p}`),
  ].join('\n')
}

// ─── Haiku synthesis ──────────────────────────────────────────────────────────
// Sends collected research findings to Haiku to extract the TBV JSON structure.
// Returns null if no valid business-relevant trigger can be derived.

async function synthesizeTrigger(
  researchContext: string,
  source: TBVResult['source'],
  systemPrompt: string,
): Promise<TBVResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const client = new Anthropic({ apiKey })

  const userMessage = `Here are the research findings for this prospect:\n\n${researchContext}\n\nExtract the best business-relevant personalisation trigger using the TBV framework. Set source to "${source}". Return valid JSON only.`

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  })

  const textBlock = response.content.find(b => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') return null

  const raw = textBlock.text.trim()

  // Strip accidental markdown code fences
  const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    logger.warn('prospect-research-agent: Haiku returned non-JSON', { raw })
    return null
  }

  const obj = parsed as Record<string, unknown>
  if (!obj.trigger || obj.trigger === 'NO_TRIGGER') return null

  return {
    trigger: String(obj.trigger),
    bridge: String(obj.bridge ?? ''),
    value: String(obj.value ?? ''),
    source,
    confidence: (['high', 'medium', 'low'].includes(String(obj.confidence))
      ? String(obj.confidence)
      : 'low') as TBVResult['confidence'],
    research_notes: String(obj.research_notes ?? ''),
  }
}

// ─── System prompt (loaded once per invocation) ───────────────────────────────

function buildSystemPrompt(): string {
  return `You are a B2B prospect research agent. Your job is to extract ONE business-relevant personalisation trigger for a prospect using the Trigger-Bridge-Value (TBV) framework.

## BUSINESS RELEVANCE FILTER — enforce strictly

ALLOWED triggers:
- Business pain signals (growth pressure, team scaling, revenue challenges)
- Role pressures (new title, new responsibilities, promotion or change in seniority)
- Company growth indicators (headcount increase, new hires, job postings)
- Strategic shifts (new initiative, product launch, expansion)
- Hiring patterns (roles being hired signal business priorities)
- Technology changes (new tools adopted, integrations)
- Funding events (seed, Series A, grant)
- Published business content (articles, interviews on business topics)
- Industry headwinds (sector-level pressures relevant to this buyer's role)

FORBIDDEN triggers (discard immediately if this is all you have):
- Personal interests, hobbies, sports teams, family life
- Personal social media activity not related to business
- Conference attendance unless the topic is directly business-relevant
- Anything that would feel surveillance-like to the recipient

Test: would the prospect feel this is relevant to their business situation, or would they feel watched? If the latter, discard and return NO_TRIGGER for that source.

## RULES — non-negotiable

1. Never fabricate a trigger. If you cannot find a specific, business-relevant observation, return NO_TRIGGER.
2. Never use generic compliments ("I loved your recent post", "Great work on X").
3. The trigger field must be one sentence maximum, present tense or recent past tense.
4. Never reference personal information.
5. The bridge must connect the trigger to a business problem, not a feature.
6. The value must describe the prospect's world improving, not the service being delivered.

## PAIN PROXY INSTRUCTIONS (when source is "pain_proxy")

When research findings include ICP push forces, use this framing:
"Most [ICP Tier 1 buyer title] at [ICP Tier 1 company type] [specific push force in buyer's language]."
Set confidence to "low".
Derive the buyer type, pain language, and company context entirely from the ICP data provided — never from assumptions.

## OUTPUT FORMAT — return valid JSON only, nothing else

{
  "trigger": "one specific business-relevant observation, max one sentence, present tense or recent past tense. If no valid trigger found, use the string NO_TRIGGER",
  "bridge": "one sentence connecting the trigger to the problem the client solves",
  "value": "outcome framed around the prospect's world improving, not the service being delivered",
  "source": "apollo | web_search | website_fetch | pain_proxy",
  "confidence": "high | medium | low",
  "research_notes": "brief internal note on what was found — for operator review only, never shown to prospects"
}`
}

// ─── Primary function ─────────────────────────────────────────────────────────

export async function runProspectResearchAgent({
  prospect_id,
  client_id,
}: ProspectResearchInput): Promise<TBVResult> {
  const agentRun = await startAgentRun({ client_id, agent_name: 'prospect-research' })
  const systemPrompt = buildSystemPrompt()
  const stepsAttempted: string[] = []

  try {
    // Fetch prospect — filter by both id and organisation_id (ADR-003)
    const supabase = getServiceClient()
    const { data: prospect, error: fetchError } = await supabase
      .from('prospects')
      .select('id, first_name, last_name, company_name, role, linkedin_url, personalisation_trigger, organisation_id')
      .eq('id', prospect_id)
      .eq('organisation_id', client_id)
      .single()

    if (fetchError || !prospect) {
      throw new Error(`Prospect not found: ${prospect_id} for client ${client_id}`)
    }

    const fullName = [prospect.first_name, prospect.last_name].filter(Boolean).join(' ')
    const company = prospect.company_name ?? 'Unknown company'

    // ── Step 1: Apollo enrichment ──────────────────────────────────────────────
    stepsAttempted.push('apollo')
    let result: TBVResult | null = null

    try {
      const apolloData = await callApolloEnrichment(prospect)
      if (apolloData.trim()) {
        const context = `Prospect: ${fullName} at ${company}\nRole: ${prospect.role ?? 'Unknown'}\n\n${apolloData}`
        result = await synthesizeTrigger(context, 'apollo', systemPrompt)
        if (result) {
          logger.debug('prospect-research-agent: trigger found via Apollo', { prospect_id, confidence: result.confidence })
        }
      }
    } catch (err) {
      logger.warn('prospect-research-agent: Apollo step failed', { prospect_id, error: String(err) })
    }

    // ── Step 2: Web search ─────────────────────────────────────────────────────
    if (!result) {
      stepsAttempted.push('web_search')
      try {
        const year = new Date().getFullYear()
        const primaryQuery = `${fullName} ${company} ${year}`
        const secondaryQuery = `${company} hiring growth funding announcement ${year}`

        const [primary, secondary] = await Promise.all([
          webSearch(primaryQuery),
          webSearch(secondaryQuery),
        ])

        const combined = [primary, secondary]
          .filter(r => !r.limited && r.synthesis.trim())
          .map(r => r.synthesis)
          .join('\n\n')

        if (combined.trim()) {
          const context = `Prospect: ${fullName} at ${company}\nRole: ${prospect.role ?? 'Unknown'}\n\nWeb search findings:\n${combined}`
          result = await synthesizeTrigger(context, 'web_search', systemPrompt)
          if (result) {
            logger.debug('prospect-research-agent: trigger found via web search', { prospect_id })
          }
        }
      } catch (err) {
        logger.warn('prospect-research-agent: web search step failed', { prospect_id, error: String(err) })
      }
    }

    // ── Step 3: Company website fetch ──────────────────────────────────────────
    if (!result) {
      stepsAttempted.push('website_fetch')
      try {
        const websiteText = await fetchCompanyWebsite(prospect)
        if (websiteText.trim()) {
          const context = `Prospect: ${fullName} at ${company}\nRole: ${prospect.role ?? 'Unknown'}\n\nCompany website content:\n${websiteText}`
          result = await synthesizeTrigger(context, 'website_fetch', systemPrompt)
          if (result) {
            logger.debug('prospect-research-agent: trigger found via website fetch', { prospect_id })
          }
        }
      } catch (err) {
        logger.warn('prospect-research-agent: website fetch step failed', { prospect_id, error: String(err) })
      }
    }

    // ── Fallback: Pain proxy from ICP document ─────────────────────────────────
    if (!result) {
      stepsAttempted.push('pain_proxy')
      try {
        const icpData = await fetchICPPainProxy(client_id)
        if (icpData.trim()) {
          const context = `Prospect: ${fullName} at ${company}\nRole: ${prospect.role ?? 'Unknown'}\n\nICP push force data for pain proxy:\n${icpData}`
          result = await synthesizeTrigger(context, 'pain_proxy', systemPrompt)
        }

        // If ICP is empty or Haiku still can't form a trigger, build a minimal proxy
        if (!result) {
          result = {
            trigger: `Most ${prospect.role ?? 'people in this role'} at ${company} are balancing similar priorities right now`,
            bridge: 'Making progress on the things that compound, without losing ground on what already works, is where most teams spend their effort',
            value: 'A clearer path to the outcomes that matter most, without adding complexity to what is already working',
            source: 'pain_proxy',
            confidence: 'low',
            research_notes: `Pain proxy used — no specific trigger found. Steps attempted: ${stepsAttempted.join(', ')}. ICP document ${icpData ? 'found' : 'not found or empty'}.`,
          }
        }
      } catch (err) {
        logger.warn('prospect-research-agent: pain proxy step failed', { prospect_id, error: String(err) })
        // Absolute last resort — should never reach here
        result = {
          trigger: `Teams at ${company} are working through the same kinds of decisions most organisations face at this stage`,
          bridge: 'The harder part is rarely the doing — it is having the right framing to know where effort pays back',
          value: 'A clearer view of where focus produces the most leverage over the next quarter',
          source: 'pain_proxy',
          confidence: 'low',
          research_notes: `Pain proxy fallback (ICP fetch failed). Steps attempted: ${stepsAttempted.join(', ')}. Error: ${String(err)}`,
        }
      }
    }

    // ── Write to prospects table ───────────────────────────────────────────────
    const { error: updateError } = await supabase
      .from('prospects')
      .update({
        personalisation_trigger: result.trigger,
        research_source: result.source,
        trigger_confidence: result.confidence,
        trigger_data: result,
        research_ran_at: new Date().toISOString(),
      })
      .eq('id', prospect_id)
      .eq('organisation_id', client_id)

    if (updateError) {
      logger.error('prospect-research-agent: failed to write trigger to prospects table', {
        prospect_id,
        error: updateError.message,
      })
    }

    const summaryVerb = result.source === 'pain_proxy' ? 'Pain proxy used' : `Trigger found via ${result.source}`
    const summaryLine = `${summaryVerb} — ${result.confidence} confidence. ${fullName} at ${company}.`

    if (result.source === 'pain_proxy') {
      await agentRun.complete(`No specific trigger found — pain proxy used. ${fullName} at ${company}. Steps attempted: ${stepsAttempted.join(', ')}.`)
    } else {
      await agentRun.complete(summaryLine)
    }

    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await agentRun.fail(`prospect-research-agent failed: ${message}`)
    throw err
  }
}

// ─── Batch function ───────────────────────────────────────────────────────────

export async function runProspectResearchAgentBatch({
  prospect_ids,
  client_id,
  skip_existing = true,
}: BatchInput): Promise<BatchSummary> {
  if (prospect_ids.length > 10) {
    logger.warn('prospect-research-agent batch: running >10 prospects may exhaust Apollo free plan credits', {
      count: prospect_ids.length,
    })
  }

  const summary: BatchSummary = { total: prospect_ids.length, completed: 0, skipped: 0, failed: 0 }

  if (skip_existing) {
    // Fetch existing trigger state for all prospects in one query
    const supabase = getServiceClient()
    const { data: existing } = await supabase
      .from('prospects')
      .select('id, personalisation_trigger')
      .in('id', prospect_ids)
      .eq('organisation_id', client_id)

    const populated = new Set(
      (existing ?? [])
        .filter(p => p.personalisation_trigger)
        .map(p => p.id)
    )

    for (const prospect_id of prospect_ids) {
      if (populated.has(prospect_id)) {
        summary.skipped++
        continue
      }

      try {
        await runProspectResearchAgent({ prospect_id, client_id })
        summary.completed++
      } catch (err) {
        logger.error('prospect-research-agent batch: prospect failed', { prospect_id, error: String(err) })
        summary.failed++
      }

      if (summary.completed + summary.failed < prospect_ids.length - populated.size) {
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
  } else {
    for (let i = 0; i < prospect_ids.length; i++) {
      const prospect_id = prospect_ids[i]
      try {
        await runProspectResearchAgent({ prospect_id, client_id })
        summary.completed++
      } catch (err) {
        logger.error('prospect-research-agent batch: prospect failed', { prospect_id, error: String(err) })
        summary.failed++
      }

      if (i < prospect_ids.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
  }

  return summary
}
