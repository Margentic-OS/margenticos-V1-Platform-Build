// Normalises a question string into a token array for Jaccard similarity matching.
// Used by the FAQ matcher. Pure function — no I/O, no side effects.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would',
  'could', 'should', 'may', 'might', 'must', 'can',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by',
  'this', 'that', 'these', 'those', 'it', 'its',
  // Question words appear in virtually every FAQ question and add noise to
  // Jaccard scoring without helping discriminate between FAQs.
  'what', 'how', 'where', 'when', 'why', 'which', 'who',
])

export function normaliseQuestion(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(token => token.length > 0 && !STOPWORDS.has(token))
}
