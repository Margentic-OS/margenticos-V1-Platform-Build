// The client's OWN sentences, pulled from their tone of voice document for the writer to
// imitate. DEMONSTRATION, NOT INSTRUCTION.
//
// WHY SAMPLES AND NOT RULES. The writer has never seen a sentence this client wrote. It gets
// the client name, the offer line, the approved closing question and the buyer's job title,
// and nothing else, which is why its copy reads like nobody in particular. This writer
// imitates what it is shown far more reliably than it follows what it is told, so the tone of
// voice document's EVIDENCE is worth passing and its RULES are not.
//
// WHAT COUNTS AS A SAMPLE, and why the rest is excluded. Only quoted spans inside
// voice_characteristics[].evidence, what_this_voice_never_does[].evidence and
// sentence_mechanics. Those quote messages the client actually sent. Everything else in that
// document was written by the document generator imitating them: example_correct, before,
// after, writing_rules, do_dont_list and vocabulary. Passing those would teach the writer the
// generated register rather than the client's.
//
// NOTHING IS HARDCODED. No default set, no fallback text, no sample sentence anywhere in this
// file. A client whose document carries no quoted evidence yields an empty array, and the
// caller omits the block entirely.

/** A span shorter than this is a fragment or a label, not a sentence worth imitating. */
export const VOICE_SAMPLE_MIN_WORDS = 5

/**
 * Quoted spans in one field.
 *
 * DOUBLE QUOTES FIRST, because that is how the document quotes a whole sentence. Single quotes
 * are matched only where one plainly opens and closes a span, since an apostrophe inside a
 * contraction is the same character: a looser pattern cut "You're doing 5 to 11k a month" down
 * to "re doing 5 to 11k a month" when this was first written.
 *
 * NO FALLBACK TO THE WHOLE FIELD. A field with no quoted span carries the document generator's
 * own prose about the client, not the client's words.
 */
function quotedSpans(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/["“]([^"“”]{10,})["”]/g)) out.push(m[1])
  for (const m of text.matchAll(/(?:^|[\s(])'([^']{10,}?)'(?=[\s),.;]|$)/g)) out.push(m[1])
  return out
    .map(s => s.trim())
    .filter(s => s.split(/\s+/).length >= VOICE_SAMPLE_MIN_WORDS)
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

/**
 * Every verbatim client sentence in a tone of voice document, longest form kept.
 *
 * Returns [] for a missing document, a document of another shape, or one with no quoted
 * evidence. The caller must treat [] as "this client has no samples", never as an error.
 */
export function extractVoiceSamples(tovContent: unknown): string[] {
  if (typeof tovContent !== 'object' || tovContent === null) return []
  const doc = tovContent as Record<string, unknown>
  const found: string[] = []

  const evidenceOf = (section: unknown) => {
    if (!Array.isArray(section)) return
    for (const entry of section) {
      const ev = (entry as { evidence?: unknown })?.evidence
      if (typeof ev === 'string') found.push(...quotedSpans(ev))
    }
  }
  evidenceOf(doc.voice_characteristics)
  evidenceOf(doc.what_this_voice_never_does)

  const mechanics = doc.sentence_mechanics
  if (typeof mechanics === 'object' && mechanics !== null) {
    for (const value of Object.values(mechanics as Record<string, unknown>)) {
      if (typeof value === 'string') found.push(...quotedSpans(value))
    }
  }

  // The same sentence is often quoted twice, once whole and once clipped. Keep the longest
  // form of each, so the writer sees the full sentence rather than a piece of it.
  const kept = found.filter((s, i) => {
    const n = normalise(s)
    return !found.some((other, j) => {
      const o = normalise(other)
      return j !== i && o.includes(n) && (o.length > n.length || j < i)
    })
  })
  return kept
}
