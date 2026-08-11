// Apollo industry tags to ICP spec consulting verticals mapping
// Apollo uses broad sectors; spec uses consulting-specific names
// This layer normalizes Apollo tags to spec industries with fail-closed behavior

const APOLLO_TO_SPEC: Record<string, string> = {
  'human resources': 'Human Resources Consulting',
  'information technology & services': 'Information Technology Consulting',
  'financial services': 'Financial Advisory Services',
  'professional training & coaching': 'Business Coaching',
  'management consulting': 'Management Consulting',
  'marketing & advertising': 'Marketing Consulting',
  'digital marketing': 'Marketing Consulting',
  'marketing consulting': 'Marketing Consulting',
  'operations consulting': 'Operations Consulting',
  'strategy consulting': 'Strategy Consulting',
  'sales consulting': 'Sales Consulting',
  'change management': 'Change Management Consulting',
  'supply chain': 'Supply Chain Consulting',
  'procurement': 'Procurement Consulting',
  'risk management': 'Risk Management Consulting',
  'compliance': 'Compliance Consulting',
  'data analytics': 'Data Analytics Consulting',
  'business coaching': 'Business Coaching',
  'executive coaching': 'Business Coaching',
  'organizational development': 'Change Management Consulting',
  'hr consulting': 'Human Resources Consulting',
  'it consulting': 'Information Technology Consulting',
}

export function mapApolloToSpecIndustry(apolloIndustry: string | null): string | null {
  if (!apolloIndustry) return null

  const normalised = apolloIndustry.toLowerCase().trim()

  // Direct match in mapping
  if (APOLLO_TO_SPEC[normalised]) {
    return APOLLO_TO_SPEC[normalised]
  }

  // Partial match: if the Apollo tag contains one of our mapping keys
  for (const [key, value] of Object.entries(APOLLO_TO_SPEC)) {
    if (normalised.includes(key)) {
      return value
    }
  }

  // No match found - fail closed, return null (will be flagged)
  return null
}

export function getIndustryMappingNote(apolloIndustry: string | null): string {
  if (!apolloIndustry) return 'no_industry_data'

  const mapped = mapApolloToSpecIndustry(apolloIndustry)
  if (mapped) {
    return `mapped: ${apolloIndustry} -> ${mapped}`
  }

  return `unmapped: ${apolloIndustry}`
}
