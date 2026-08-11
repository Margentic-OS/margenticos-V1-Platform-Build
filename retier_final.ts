import { createClient } from '@supabase/supabase-js';
import { tierEnrichedBatch } from '@/lib/sourcing/tiering-trigger';

async function retiering() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key);

  const organisationId = '0ed34697-0fa9-4f08-ac15-d3504ac45caf';
  
  console.log('Starting re-tiering for org:', organisationId);
  const result = await tierEnrichedBatch(supabase, organisationId, 100);
  console.log('Re-tiering complete:', result);
  
  // Fetch all prospects
  console.log('\nFetching all prospects...');
  const { data: allProspects, error } = await supabase
    .from('prospects')
    .select('first_name, last_name, company_industry, company_headcount, job_title, sourced_tier, fit_score, tiering_reason')
    .eq('organisation_id', organisationId)
    .order('sourced_tier', { ascending: true, nullsFirst: true })
    .order('fit_score', { ascending: false });

  if (error) {
    console.error('Error fetching prospects:', error);
    return;
  }

  // Display results
  console.log('\n=== RE-TIERING RESULTS ===\n');
  console.log('Name (30) | Industry (35) | HC | Job Title (30) | Tier | Score | Reason');
  console.log('-'.repeat(160));
  
  if (allProspects) {
    allProspects.forEach(p => {
      const name = `${p.first_name} ${p.last_name}`.substring(0, 29);
      const industry = (p.company_industry || 'N/A').substring(0, 34);
      const headcount = (p.company_headcount || '-').toString().padEnd(2);
      const title = (p.job_title || 'N/A').substring(0, 29);
      const tier = p.sourced_tier ? p.sourced_tier.padEnd(6) : 'REMOVED';
      const score = p.fit_score !== null ? String(p.fit_score).padEnd(5) : '---';
      const reason = (p.tiering_reason || '').substring(0, 50);
      console.log(`${name.padEnd(30)} | ${industry.padEnd(35)} | ${headcount} | ${title.padEnd(30)} | ${tier} | ${score} | ${reason}`);
    });
  }

  // Summary
  if (allProspects) {
    const tiered = allProspects.filter(p => p.sourced_tier !== null);
    const tier1 = allProspects.filter(p => p.sourced_tier === 'tier_1').length;
    const tier2 = allProspects.filter(p => p.sourced_tier === 'tier_2').length;
    const tier3 = allProspects.filter(p => p.sourced_tier === 'tier_3').length;
    const removed = allProspects.filter(p => p.sourced_tier === null).length;
    console.log(`\n\nSUMMARY:`);
    console.log(`Total prospects: ${allProspects.length}`);
    console.log(`Tiered: ${tiered.length}`);
    console.log(`  - Tier 1: ${tier1}`);
    console.log(`  - Tier 2: ${tier2}`);
    console.log(`  - Tier 3: ${tier3}`);
    console.log(`Removed: ${removed}`);
  }
}

retiering().catch(console.error);
