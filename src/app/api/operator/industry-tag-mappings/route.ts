import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { logger } from '@/lib/logger'
import { clearIndustryMappingCache, loadIndustryTagMappings } from '@/lib/sourcing/industry-mapping'
import { classifyTier } from '@/lib/sourcing/tier-classification'
import type { Database } from '@/types/database'

type ICPFilterSpec = Database['public']['Tables']['strategy_documents']['Row']['icp_filter_spec']

export async function POST(request: NextRequest) {
  try {
    // Get user from session
    const cookieStore = await cookies()
    const sessionClient = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll() },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          },
        },
      }
    )

    // Verify authenticated
    const { data: { user }, error: authError } = await sessionClient.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    // Create service role client for admin operations
    const serviceClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Verify operator role
    const { data: userRow, error: userError } = await serviceClient
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    if (userError || !userRow || userRow.role !== 'operator') {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    }

    const { apollo_tag, canonical_industry } = await request.json()

    if (!apollo_tag || !canonical_industry) {
      return NextResponse.json(
        { error: 'Missing required fields: apollo_tag, canonical_industry' },
        { status: 400 },
      )
    }

    // 1. Insert/upsert the mapping
    const { error: upsertError } = await serviceClient
      .from('industry_tag_mappings')
      .upsert(
        {
          apollo_tag: apollo_tag.toLowerCase().trim(),
          canonical_industry,
          created_by: user.id,
        },
        { onConflict: 'apollo_tag' },
      )

    if (upsertError) {
      logger.error('Failed to insert industry tag mapping', {
        apollo_tag,
        canonical_industry,
        error: upsertError,
      })
      return NextResponse.json({ error: 'Failed to insert mapping' }, { status: 500 })
    }

    // Clear the cache so future classifications use the new mapping
    clearIndustryMappingCache()

    // 2. Find all flagged prospects with this Apollo tag across all orgs
    const { data: flaggedProspects, error: fetchError } = await serviceClient
      .from('prospects')
      .select('id, company_industry, email_status, job_title, company_headcount, sourced_tier, organisation_id, company_name')
      .eq('company_industry', apollo_tag)
      .is('sourced_tier', null)

    if (fetchError) {
      logger.error('Failed to fetch flagged prospects', {
        apollo_tag,
        error: fetchError,
      })
      return NextResponse.json({ error: 'Failed to fetch prospects' }, { status: 500 })
    }

    // 3. Re-tier these prospects
    const reTieredCount = await reTierProspectsWithMapping(
      serviceClient,
      flaggedProspects || [],
      apollo_tag,
      canonical_industry,
    )

    logger.info('Industry tag mapping created and prospects re-tiered', {
      apollo_tag,
      canonical_industry,
      prospects_retiered: reTieredCount,
      user_id: user.id,
    })

    return NextResponse.json({
      success: true,
      apollo_tag,
      canonical_industry,
      prospects_retiered: reTieredCount,
    })
  } catch (error) {
    logger.error('Error in industry tag mapping endpoint', { error })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

async function reTierProspectsWithMapping(
  supabase: any,
  prospects: any[],
  apollo_tag: string,
  canonical_industry: string,
): Promise<number> {
  if (prospects.length === 0) return 0

  // Load the new mapping
  const dbMappings = await loadIndustryTagMappings(supabase)
  dbMappings[apollo_tag.toLowerCase().trim()] = canonical_industry

  let reTieredCount = 0

  for (const prospect of prospects) {
    try {
      // Get the org's latest ICP filter spec
      const { data: icpDoc, error: icpError } = await supabase
        .from('strategy_documents')
        .select('icp_filter_spec')
        .eq('organisation_id', prospect.organisation_id)
        .eq('document_type', 'icp')
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      if (icpError || !icpDoc || !icpDoc.icp_filter_spec) {
        logger.warn('Failed to fetch ICP spec for prospect', {
          prospect_id: prospect.id,
          organisation_id: prospect.organisation_id,
        })
        continue
      }

      // Re-classify the prospect with the new mapping
      const enrichedProspect = {
        id: prospect.id,
        organisation_id: prospect.organisation_id,
        email_status: prospect.email_status,
        enrichment_status: null,
        job_title: prospect.job_title,
        company_headcount: prospect.company_headcount,
        company_industry: prospect.company_industry,
      } as any

      const result = await classifyTier(
        enrichedProspect,
        (icpDoc.icp_filter_spec || {}) as any,
        supabase,
      )

      if (result.sourced_tier) {
        // Update the prospect with the new tier
        const { error: updateError } = await supabase
          .from('prospects')
          .update({
            sourced_tier: result.sourced_tier,
            fit_score: result.fit_score,
            tiering_reason: result.tiering_reason,
          })
          .eq('id', prospect.id)

        if (updateError) {
          logger.warn('Failed to update prospect tier', {
            prospect_id: prospect.id,
            error: updateError,
          })
          continue
        }

        reTieredCount++
      }
    } catch (error) {
      logger.warn('Error re-tiering individual prospect', {
        prospect_id: prospect.id,
        error,
      })
      continue
    }
  }

  return reTieredCount
}
