// A QUOTED SPAN THE RESEARCH ACTUALLY FOUND COUNTS AS ONE UNIT.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY. A title is not prose the writer chose. It is a fixed string with its own punctuation
// and its own length, and the writer cannot shorten it or take the colon out of it without
// misquoting.
//
// MEASURED 2026-09-24. One prospect's selected candidate was a blog post titled "The sales
// bottleneck: why your business stopped scaling the day you became its best salesperson".
// Carried into an observation it produced TWO sentences, because of the colon inside the
// title, and a NINETEEN-word sentence against an 18-word cap. Both gates fired on one
// legitimate sentence, and the writer lost the email on every attempt because there was
// nothing it could do: shortening the title would have been a misquote.
//
// THE EXEMPTION IS EARNED, NOT ASSUMED. A span counts as one unit only when it appears
// VERBATIM in the research findings. Anything else would let the writer evade the cap by
// quoting its own prose: put quotes round a long clause and the cap stops applying. That
// is why the findings corpus is a required argument and not an optional one.
//
// TWO OTHER PROSPECTS FAILED THE SAME GATES IN THE SAME RUN AND ARE NOT HELPED BY THIS,
// which is the point of checking rather than assuming: their copy carried no quotation at
// all, and their sentences were genuinely two sentences and genuinely too long.
// ═════════════════════════════════════════════════════════════════════════════

/** One word, no punctuation, so a collapsed span counts as a single token everywhere. */
const UNIT = 'QUOTEDSPAN'

/**
 * Straight and curly, single and double. A title may be quoted with any of them.
 *
 * FOUR ALTERNATIVES, NOT A BACKREFERENCE. A curly pair OPENS and CLOSES with different
 * characters, so requiring the same delimiter at both ends matched straight quotes and
 * silently missed every curly one, which is the form a title copied off a web page usually
 * carries. Caught by the test that tries all three pairs rather than one.
 */
const QUOTED = /"([^"]{8,300})"|\u201c([^\u201d]{8,300})\u201d|'([^']{8,300})'|\u2018([^\u2019]{8,300})\u2019/g

function normalise(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()
}

/**
 * Replaces each quoted span that appears verbatim in `findings` with a single token.
 *
 * Returns the text unchanged when there is no findings corpus, which is the conservative
 * direction: no corpus means nothing can be verified, so nothing is exempt.
 */
export function collapseVerbatimQuotes(text: string, findings: string): string {
  if (!text || !findings) return text
  const haystack = normalise(findings)
  return text.replace(QUOTED, (whole, straightDouble, curlyDouble, straightSingle, curlySingle) => {
    const inner = (straightDouble ?? curlyDouble ?? straightSingle ?? curlySingle ?? '').trim()
    // A SHORT QUOTE IS NOT A TITLE. Two words in quotes is a turn of phrase, and exempting
    // it would buy the writer a loophole for the price of a pair of apostrophes.
    if (inner.split(/\s+/).filter(Boolean).length < 3) return whole
    return haystack.includes(normalise(inner)) ? UNIT : whole
  })
}
