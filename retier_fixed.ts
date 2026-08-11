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
  
  // Fetch all prospects (tiered and untiered)
  console.log('\nFetching all prospects...');
  const { data: allProspects, error } = await supabase
    .from('prospects')
    .select('id, prospect_name, company_industry, company_headcount, job_title, sourced_tier, fit_score, tiering_reason')
    .eq('organisation_id', organisationId)
    .order('sourced_tier', { ascending: true, nullsFirst: true })
    .order('fit_score', { ascending: false });

  if (error) {
    console.error('Error fetching prospects:', error);
    return;
  }

  // Display results
  console.log('\n=== ALL PROSPECTS (TIERED AND UNTIERED) ===\n');
  console.log('Name'.padEnd(25) + ' | Status    | Score | Tier     | Reason');
  console.log('-'.repeat(100));
  
  if (allProspects) {
    allProspects.forEach(p => {
      const status = p.sourced_tier ? 'Tiered' : 'Removed';
      const tier = p.sourced_tier || '---';
      const score = p.fit_score !== null ? String(p.fit_score).padEnd(5) : '---';
      const reason = p.tiering_reason || '(none)';
      console.log(`${p.prospect_name.substring(0,24).padEnd(25)} | ${status.padEnd(9)} | ${score} | ${tier.padEnd(8)} | ${reason}`);
    });
  }

  // Summary
  if (allProspects) {
    const tiered = allProspects.filter(p => p.sourced_tier !== null);
    const tier1 = allProspects.filter(p => p.sourced_tier === 'tier_1').length;
    const tier2 = allProspects.filter(p => p.sourced_tier === 'tier_2').length;
    const tier3 = allProspects.filter(p => p.sourced_tier === 'tier_3').length;
    const removed = allProspects.filter(p => p.sourced_tier === null).length;
    console.log(`\nTotal: ${allProspects.length} | Tiered: ${tiered.length} (${tier1} tier_1, ${tier2} tier_2, ${tier3} tier_3) | Removed: ${removed}`);
  }
}

retiering().catch(console.error);
