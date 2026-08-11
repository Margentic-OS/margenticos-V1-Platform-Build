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
  
  // Fetch the re-tiered prospects
  console.log('\nFetching re-tiered prospects...');
  const { data: prospects, error } = await supabase
    .from('prospects')
    .select('id, name, company_industry, company_headcount, job_title, sourced_tier, fit_score, tiering_reason')
    .eq('organisation_id', organisationId)
    .not('sourced_tier', 'is', null)
    .order('sourced_tier', { ascending: true })
    .order('fit_score', { ascending: false });

  if (error) {
    console.error('Error fetching prospects:', error);
    return;
  }

  // Display results
  console.log('\n=== RE-TIERING RESULTS ===\n');
  if (prospects) {
    prospects.forEach(p => {
      console.log(`${p.name.padEnd(25)} | ${p.sourced_tier.padEnd(7)} | Score: ${String(p.fit_score).padEnd(3)} | ${p.tiering_reason}`);
    });
  }

  // Summary
  if (prospects) {
    const tier1 = prospects.filter(p => p.sourced_tier === 'tier_1').length;
    const tier2 = prospects.filter(p => p.sourced_tier === 'tier_2').length;
    const tier3 = prospects.filter(p => p.sourced_tier === 'tier_3').length;
    console.log(`\nSummary: ${tier1} tier_1, ${tier2} tier_2, ${tier3} tier_3`);
  }
}

retiering().catch(console.error);
