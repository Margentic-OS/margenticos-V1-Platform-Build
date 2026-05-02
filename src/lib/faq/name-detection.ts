// Deterministic name detector for FAQ extraction post-processing.
// Per ADR-018: no LLM. Pure heuristic — flags for human review, not auto-action.
// False positives are acceptable. Missing a real name leak is not.
//
// Used by faq-extraction-agent to populate potential_names_flagged in results.
// The curation UI surfaces these to the operator before any FAQ is published.

// Common business abbreviations, acronyms, and month/day names that start
// with a capital letter but are not personal names.
const WHITELIST = new Set([
  'UK', 'EU', 'US', 'CEO', 'CFO', 'COO', 'CTO', 'ICP', 'B2B', 'SaaS', 'AI',
  'KPI', 'CRM', 'ROI', 'Q1', 'Q2', 'Q3', 'Q4', 'API', 'SEO', 'CTA', 'NDA',
  'SLA', 'KYC', 'AML', 'GDPR',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
])

// Punctuation that ends a sentence — a capitalised word immediately following
// one of these is a sentence-start capitalisation, not a proper name.
const SENTENCE_END = /[.?!]$/

export function detectPotentialNames(text: string): string[] {
  const rawTokens = text.split(/\s+/).filter(Boolean)
  const found = new Set<string>()

  for (let i = 0; i < rawTokens.length; i++) {
    const token = rawTokens[i]

    // Strip leading and trailing punctuation to get the bare word.
    const stripped = token.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '')
    if (!stripped) continue

    // Must start with an uppercase letter.
    if (!/^[A-Z]/.test(stripped)) continue

    // Position 0 is always a sentence start — skip.
    if (i === 0) continue

    // If the previous token ends with sentence-ending punctuation, this word
    // is capitalised because it opens a new sentence, not because it's a name.
    if (SENTENCE_END.test(rawTokens[i - 1])) continue

    // Known business terms, acronyms, and calendar words are not names.
    if (WHITELIST.has(stripped)) continue

    found.add(stripped)
  }

  return Array.from(found)
}
