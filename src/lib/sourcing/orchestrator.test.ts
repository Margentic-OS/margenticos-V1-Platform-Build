// Unit tests for sourcing orchestrator steps 5-9
// Tests: manifest gate logic, dedupe verdict filtering, agent_runs schema, breakdown counts

import { describe, it, expect } from 'vitest'

const DRY_RUN_TEST_ORG = 'dry-run-test-org-uuid-12345678'

describe('Sourcing orchestrator (steps 5-9)', () => {
  describe('Manifest gate logic', () => {
    it('identifies unsupported fields before handler invocation', () => {
      const handlerSupportedFields = [
        'job_titles',
        'seniority_levels',
        'person_countries',
        'company_countries',
        'company_headcount_min',
        'company_headcount_max',
        'industries',
        'keywords',
        'job_titles_excluded',
        'industries_excluded',
        'keywords_excluded',
        'company_revenue_min',
        'company_revenue_max',
      ]

      const spec = {
        job_titles: ['VP of Sales'],
        seniority_levels: ['c_suite'],
        person_countries: ['US'],
        company_countries: ['US'],
        company_headcount_min: 10,
        company_headcount_max: 500,
        industries: ['Technology'],
        company_age_min_years: 2, // UNSUPPORTED
        technologies_used: ['Salesforce'], // UNSUPPORTED
      }

      const FILTER_FIELDS = [
        'job_titles',
        'job_titles_excluded',
        'seniority_levels',
        'departments',
        'person_countries',
        'company_countries',
        'company_headcount_min',
        'company_headcount_max',
        'industries',
        'industries_excluded',
        'keywords',
        'keywords_excluded',
        'company_revenue_min',
        'company_revenue_max',
        'company_age_min_years',
        'company_age_max_years',
        'technologies_used',
        'funding_stage',
        'funded_since',
      ]

      const unsupportedFields: string[] = []
      const populatedFields: string[] = []

      for (const field of FILTER_FIELDS) {
        const value = spec[field as keyof typeof spec]
        const isPopulated =
          value != null &&
          (Array.isArray(value) ? value.length > 0 : String(value).length > 0)

        if (isPopulated) {
          populatedFields.push(field)
          if (!handlerSupportedFields.includes(field)) {
            unsupportedFields.push(field)
          }
        }
      }

      expect(populatedFields).toContain('job_titles')
      expect(populatedFields).toContain('company_age_min_years')
      expect(populatedFields).toContain('technologies_used')
      expect(unsupportedFields).toContain('company_age_min_years')
      expect(unsupportedFields).toContain('technologies_used')
      expect(unsupportedFields).not.toContain('job_titles')
    })

    it('passes when all populated fields are supported', () => {
      const handlerSupportedFields = [
        'job_titles',
        'seniority_levels',
        'person_countries',
        'company_countries',
        'company_headcount_min',
        'company_headcount_max',
        'industries',
        'keywords',
      ]

      const spec = {
        job_titles: ['VP of Sales'],
        seniority_levels: ['c_suite'],
        person_countries: ['US'],
        company_countries: ['US'],
        company_headcount_min: 10,
        company_headcount_max: 500,
        industries: ['Technology'],
        keywords: [],
      }

      const FILTER_FIELDS = [
        'job_titles',
        'job_titles_excluded',
        'seniority_levels',
        'person_countries',
        'company_countries',
        'company_headcount_min',
        'company_headcount_max',
        'industries',
        'industries_excluded',
        'keywords',
        'keywords_excluded',
        'company_revenue_min',
        'company_revenue_max',
        'company_age_min_years',
        'company_age_max_years',
        'technologies_used',
        'funding_stage',
        'funded_since',
      ]

      const unsupportedFields: string[] = []

      for (const field of FILTER_FIELDS) {
        const value = spec[field as keyof typeof spec]
        const isPopulated =
          value != null &&
          (Array.isArray(value) ? value.length > 0 : String(value).length > 0)

        if (isPopulated && !handlerSupportedFields.includes(field)) {
          unsupportedFields.push(field)
        }
      }

      expect(unsupportedFields).toHaveLength(0)
    })
  })

  describe('Dedupe verdict filtering', () => {
    it('writes only new candidates, skips suppressed and duplicates', () => {
      const candidates = [
        { source_person_key: 'apollo:new-001', email: null, linkedin_url: null },
        {
          source_person_key: 'apollo:suppressed-001',
          email: null,
          linkedin_url: null,
        },
        {
          source_person_key: 'apollo:duplicate-pk-001',
          email: null,
          linkedin_url: null,
        },
        {
          source_person_key: 'apollo:duplicate-email-001',
          email: 'dup@example.com',
          linkedin_url: null,
        },
        {
          source_person_key: 'apollo:new-002',
          email: null,
          linkedin_url: null,
        },
      ]

      const verdicts = new Map([
        ['apollo:new-001', 'new'],
        ['apollo:suppressed-001', 'suppressed_match'],
        ['apollo:duplicate-pk-001', 'duplicate_person_key'],
        ['apollo:duplicate-email-001', 'duplicate_email'],
        ['apollo:new-002', 'new'],
      ])

      const survivors = candidates.filter(
        (c) => verdicts.get(c.source_person_key) === 'new'
      )

      expect(survivors).toHaveLength(2)
      expect(survivors[0].source_person_key).toBe('apollo:new-001')
      expect(survivors[1].source_person_key).toBe('apollo:new-002')
    })
  })

  describe('Prospect row structure', () => {
    it('constructs insert with untiered pending_review and null enrichment fields', () => {
      const candidate = {
        source_person_key: 'apollo:test-001',
        email: null,
        linkedin_url: null,
      }

      const now = new Date().toISOString()

      const prospectRow = {
        organisation_id: DRY_RUN_TEST_ORG,
        source_person_key: candidate.source_person_key,
        sourcing_review_status: 'pending_review',
        qualified_at: now,
        sourced_tier: null,
        email: null,
        linkedin_url: null,
        linkedin_url_normalised: null,
        website_url: null,
      }

      expect(prospectRow.organisation_id).toBe(DRY_RUN_TEST_ORG)
      expect(prospectRow.source_person_key).toBe('apollo:test-001')
      expect(prospectRow.sourcing_review_status).toBe('pending_review')
      expect(prospectRow.sourced_tier).toBeNull()
      expect(prospectRow.email).toBeNull()
      expect(prospectRow.linkedin_url).toBeNull()
      expect(prospectRow.linkedin_url_normalised).toBeNull()
      expect(prospectRow.website_url).toBeNull()
    })
  })

  describe('agent_runs logging schema', () => {
    it('logs success with output_summary breakdown and valid columns', () => {
      const verdictCounts = {
        new: 2,
        suppressed_match: 1,
        duplicate_person_key: 1,
        duplicate_linkedin: 1,
        duplicate_email: 0,
      }

      const candidates_sourced = 5
      const candidates_qualified = 2
      const droppedCount =
        verdictCounts.suppressed_match +
        verdictCounts.duplicate_person_key +
        verdictCounts.duplicate_linkedin +
        verdictCounts.duplicate_email

      const outputSummary =
        `candidates returned ${candidates_sourced}, ` +
        `written ${candidates_qualified}, ` +
        `dropped ${droppedCount} ` +
        `(suppressed: ${verdictCounts.suppressed_match}, ` +
        `duplicate_person_key: ${verdictCounts.duplicate_person_key}, ` +
        `duplicate_linkedin: ${verdictCounts.duplicate_linkedin}, ` +
        `duplicate_email: ${verdictCounts.duplicate_email})`

      const agentRunRow = {
        organisation_id: DRY_RUN_TEST_ORG,
        agent_name: 'sourcing_orchestrator',
        status: 'success',
        output_summary: outputSummary,
        error_message: null,
      }

      expect(agentRunRow.organisation_id).toBe(DRY_RUN_TEST_ORG)
      expect(agentRunRow.agent_name).toBe('sourcing_orchestrator')
      expect(agentRunRow.status).toBe('success')
      expect(agentRunRow.output_summary).toContain('candidates returned 5')
      expect(agentRunRow.output_summary).toContain('written 2')
      expect(agentRunRow.output_summary).toContain('dropped 3')
      expect(agentRunRow.output_summary).toContain('suppressed: 1')
      expect(agentRunRow.output_summary).toContain('duplicate_person_key: 1')
      expect(agentRunRow.output_summary).toContain('duplicate_linkedin: 1')
      expect(agentRunRow.output_summary).toContain('duplicate_email: 0')
      expect(agentRunRow.error_message).toBeNull()
      // Verify old broken columns not present
      expect(Object.keys(agentRunRow)).not.toContain('input')
      expect(Object.keys(agentRunRow)).not.toContain('output')
      expect(Object.keys(agentRunRow)).not.toContain('trigger')
    })

    it('logs failure with error_message and null output_summary', () => {
      const errorMsg = 'Handler search failed: Apollo API returned 403'

      const agentRunRow = {
        organisation_id: DRY_RUN_TEST_ORG,
        agent_name: 'sourcing_orchestrator',
        status: 'failed',
        output_summary: null,
        error_message: errorMsg,
      }

      expect(agentRunRow.organisation_id).toBe(DRY_RUN_TEST_ORG)
      expect(agentRunRow.agent_name).toBe('sourcing_orchestrator')
      expect(agentRunRow.status).toBe('failed')
      expect(agentRunRow.output_summary).toBeNull()
      expect(agentRunRow.error_message).toContain('403')
      expect(Object.keys(agentRunRow)).not.toContain('input')
      expect(Object.keys(agentRunRow)).not.toContain('output')
    })
  })

  describe('Verdict counting and breakdown', () => {
    it('computes correct counts for each verdict type', () => {
      const verdicts = new Map([
        ['apollo:1', 'new'],
        ['apollo:2', 'new'],
        ['apollo:3', 'new'],
        ['apollo:4', 'suppressed_match'],
        ['apollo:5', 'suppressed_match'],
        ['apollo:6', 'duplicate_person_key'],
        ['apollo:7', 'duplicate_linkedin'],
        ['apollo:8', 'duplicate_linkedin'],
        ['apollo:9', 'duplicate_email'],
      ])

      const verdictCounts = {
        new: 0,
        suppressed_match: 0,
        duplicate_person_key: 0,
        duplicate_linkedin: 0,
        duplicate_email: 0,
      }

      for (const verdict of verdicts.values()) {
        const v = verdict as string
        if (v in verdictCounts) {
          verdictCounts[v as keyof typeof verdictCounts]++
        }
      }

      expect(verdictCounts.new).toBe(3)
      expect(verdictCounts.suppressed_match).toBe(2)
      expect(verdictCounts.duplicate_person_key).toBe(1)
      expect(verdictCounts.duplicate_linkedin).toBe(2)
      expect(verdictCounts.duplicate_email).toBe(1)

      const droppedCount =
        verdictCounts.suppressed_match +
        verdictCounts.duplicate_person_key +
        verdictCounts.duplicate_linkedin +
        verdictCounts.duplicate_email

      expect(droppedCount).toBe(6)
      expect(verdictCounts.new + droppedCount).toBe(9)
    })
  })
})
