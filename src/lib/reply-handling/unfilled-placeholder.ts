// src/lib/reply-handling/unfilled-placeholder.ts
//
// The last check before a reply body leaves for the sending provider: no template token
// may survive into what a prospect receives.
//
// WHY IT EXISTS. substituteBookingLink replaces ONE named token, and for any body that
// does not contain that exact token it reports "no placeholder, nothing to do" and hands
// the body back untouched. So a body carrying a token the substitution does not know
// passes straight through: a placeholder renamed in the drafting prompt but not in the
// substitution, or the reverse, or a token the model invented. Nothing downstream
// objects, and the prospect receives the literal braces.
//
// It is deliberately NOT tied to any token name. It matches the SHAPE of a template
// token, single or double braces around a snake_case word, so drift between the prompt
// and the substitution fails closed here instead of shipping. That is also why it must
// run on the final assembled bytes, after substitution and sign-off, and before the
// provider call.

// The second alternative is the same token PERCENT-ENCODED. A link passed through the URL
// parser (buildProspectBookingLink does) comes out with { and } as %7B and %7D, so a token
// inside a stored booking URL would otherwise slip past as "https://…/%7Busername%7D" and
// reach the prospect as a broken link. Found by this file's own test on the automated path.
const TEMPLATE_TOKEN = /\{\{?\s*[a-z][a-z0-9_]*\s*\}\}?|%7B(?:%7B)?[a-z][a-z0-9_]*%7D(?:%7D)?/i

/**
 * Returns the first template token still present in the body, or null when there is
 * none. A non-null result means the body must not be sent.
 */
export function findUnfilledPlaceholder(body: string): string | null {
  const match = body.match(TEMPLATE_TOKEN)
  return match ? match[0] : null
}
