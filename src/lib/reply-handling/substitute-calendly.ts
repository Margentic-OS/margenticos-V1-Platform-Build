// src/lib/reply-handling/substitute-calendly.ts
//
// Deterministic Calendly link substitution.
// Replaces all occurrences of {calendly_link} in the body with the provided URL.
// Returns a result struct so the caller can distinguish "no placeholder" (not a failure)
// from "placeholder present but link missing" (send_failed).

export interface SubstituteCalendlyResult {
  body: string
  missing: boolean     // true when placeholder present but link is null/empty
  substituted: boolean // true when at least one replacement was made
}

const PLACEHOLDER = '{calendly_link}'

export function substituteCalendly(
  body: string,
  calendlyLink: string | null,
): SubstituteCalendlyResult {
  if (!body.includes(PLACEHOLDER)) {
    // No placeholder — not a failure regardless of whether a link was supplied.
    return { body, missing: false, substituted: false }
  }

  if (!calendlyLink || !calendlyLink.trim()) {
    // Placeholder present but no link — caller must treat as send_failed.
    return { body, missing: true, substituted: false }
  }

  const substituted = body.split(PLACEHOLDER).join(calendlyLink)
  return { body: substituted, missing: false, substituted: true }
}
