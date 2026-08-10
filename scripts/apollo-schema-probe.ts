import { createClient } from '@supabase/supabase-js'
import { apolloHandler } from '@/lib/sourcing/handlers/adapter-apollo'

async function main() {
  const apiKey = process.env.APOLLO_API_KEY
  if (!apiKey) {
    console.error('APOLLO_API_KEY not set')
    process.exit(1)
  }

  // Build a request for one result
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

  console.log('\n=== APOLLO API_SEARCH SCHEMA PROBE ===\n')
  console.log('Fetching 1 person from api_search...')

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
    console.log('\nFirst person object from api_search:')
    console.log(JSON.stringify(person, null, 2))
    console.log('\n\nColumns available on this person:')
    console.log(Object.keys(person).sort())
  } else {
    console.log('No people in response')
  }
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
