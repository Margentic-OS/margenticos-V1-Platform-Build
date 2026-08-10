import { createClient } from '@supabase/supabase-js'
import { apolloHandler } from '@/lib/sourcing/handlers/adapter-apollo'

async function main() {
  const apiKey = process.env.APOLLO_API_KEY
  if (!apiKey) {
    console.error('APOLLO_API_KEY not set')
    process.exit(1)
  }

  const spec = {
    job_titles: ['Founder'],
    job_titles_excluded: [],
    seniority_levels: ['founder'],
    person_countries: ['GB'],
    company_countries: ['GB'],
    company_headcount_min: 1,
    company_headcount_max: 20,
    industries: ['Management Consulting'],
    industries_excluded: [],
    keywords: ['consulting'],
    keywords_excluded: [],
  }

  const request = apolloHandler.adapter(spec)
  const finalRequest = { ...request, page: 1, per_page: 1 }

  console.log('\n=== APOLLO LINKEDIN & ORG WEBSITE PROBE ===\n')

  const response = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(finalRequest),
  })

  if (!response.ok) {
    console.error(`Error ${response.status}:`, await response.text())
    process.exit(1)
  }

  const data = await response.json()

  if (data.people?.length) {
    const person = data.people[0]
    console.log('Person object keys:', Object.keys(person).sort().join(', '))

    if (person.organization) {
      console.log('Organization keys:', Object.keys(person.organization).sort().join(', '))
    }

    console.log('\nFull person object:')
    console.log(JSON.stringify(person, null, 2))

    console.log('\nChecking for fields:')
    console.log(`  linkedin_url: ${person.linkedin_url ? '✓ PRESENT' : '✗ MISSING'}`)
    console.log(`  organization.website_url: ${person.organization?.website_url ? '✓ PRESENT' : '✗ MISSING'}`)
    console.log(`  organization.primary_domain: ${person.organization?.primary_domain ? '✓ PRESENT' : '✗ MISSING'}`)
  } else {
    console.log('No people in response')
  }
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
