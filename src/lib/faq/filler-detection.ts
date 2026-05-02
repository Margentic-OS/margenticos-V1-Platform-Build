// Deterministic skip gate for FAQ extraction.
// Per ADR-018: no LLM calls. Pure rules — cheap, fast, predictable.
// Called before any Haiku invocation in the faq-extraction-agent.
// Returns { skip: true, reason } on first matching rule, { skip: false } if all pass.

import { normaliseQuestion } from './normalise'

export interface SkipResult {
  skip: boolean
  reason?: string
}

// Patterns checked within the first 40 characters of the operator's answer.
// Trailing spaces on single-word entries ("ok ", "sure ") distinguish them from
// words that share the same prefix ("okay-ish", "surely").
const FILLER_PREFIXES = [
  'let me check',
  'let me get back',
  'let me come back',
  "i'll come back",
  "i'll get back",
  "i'll check",
  'good question',
  'great question',
  'thanks for',
  'thank you for',
  'got it',
  'noted',
  'received',
  'ok ',
  'okay ',
  'sure ',
  'right ',
]

export function shouldSkipExtraction({
  prospectQuestion,
  operatorAnswer,
  aiDraftBody,
}: {
  prospectQuestion: string
  operatorAnswer: string
  aiDraftBody: string
}): SkipResult {
  // ── Rule 1: word count ────────────────────────────────────────────────────
  const words = operatorAnswer.split(/\s+/).filter(Boolean)
  if (words.length < 20) {
    return { skip: true, reason: `answer_too_short_${words.length}_words` }
  }

  // ── Rule 2: filler-prefix in first 40 characters ─────────────────────────
  // Word-boundary regex prevents false positives like "great questions" matching "great question".
  const opening = operatorAnswer.trim().toLowerCase().slice(0, 40)
  for (const prefix of FILLER_PREFIXES) {
    const escaped = prefix.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Trailing-space entries (e.g. "ok ") act as their own boundary anchor — match literally.
    // Multi-word and non-space-terminated entries use \b on both ends.
    const pattern = prefix.endsWith(' ')
      ? new RegExp(escaped.trimEnd() + '(?:\\s|$)', 'i')
      : new RegExp(`\\b${escaped}\\b`, 'i')
    if (pattern.test(opening)) {
      const normalised = prefix.trim().replace(/\s+/g, '_')
      return { skip: true, reason: `filler_prefix_detected_${normalised}` }
    }
  }

  // ── Rule 3: question-dominated (operator replied with questions, not answers) ──
  const questionMarkCount = (operatorAnswer.match(/\?/g) || []).length
  const fullStopCount = (operatorAnswer.match(/\./g) || []).length
  if (questionMarkCount > fullStopCount && operatorAnswer.includes('?')) {
    return { skip: true, reason: 'operator_asked_clarifying_questions_not_answer' }
  }

  // ── Rule 4: Booking-link-only (URL or placeholder with minimal surrounding context) ──
  // Tool-agnostic: detects any https URL or the {calendly_link} template placeholder.
  // Both patterns indicate a booking link regardless of which tool is in use.
  const hasBookingLink =
    /https?:\/\/\S+/.test(operatorAnswer) ||
    operatorAnswer.includes('{calendly_link}')
  if (hasBookingLink) {
    const stripped = operatorAnswer
      .replace(/https?:\/\/\S+/g, '')      // strip all URLs
      .replace(/\{calendly_link\}/gi, '')   // strip the placeholder
      .trim()
    const strippedWords = stripped.split(/\s+/).filter(Boolean)
    if (strippedWords.length < 30) {
      return { skip: true, reason: 'booking_link_only_minimal_context' }
    }
  }

  // ── Rule 5: operator did not edit the AI draft ────────────────────────────
  // Extracting from an unedited AI draft treats AI content as curated knowledge.
  // The FAQ library must be operator-validated, not AI-generated.
  // Uses Jaccard on word tokens — same algorithm as matcher.ts for consistency.
  const similarity = jaccardSimilarity(operatorAnswer, aiDraftBody)
  if (similarity > 0.95) {
    return { skip: true, reason: 'operator_did_not_edit_ai_draft' }
  }

  // Unused parameter kept to satisfy the interface — prospectQuestion is available
  // for future rules without changing the function signature.
  void prospectQuestion

  return { skip: false }
}

// Jaccard similarity on normalised word tokens.
// Shared algorithm with matcher.ts — both use normaliseQuestion() from normalise.ts.
function jaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(normaliseQuestion(a))
  const tokensB = new Set(normaliseQuestion(b))
  if (tokensA.size === 0 || tokensB.size === 0) return 0

  let intersection = 0
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++
  }
  const union = tokensA.size + tokensB.size - intersection
  return union === 0 ? 0 : intersection / union
}
