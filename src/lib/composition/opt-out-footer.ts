// Single source of truth for the outbound opt-out footer.
//
// Applied at COMPOSITION time, never at document generation time. Every send carries the
// footer regardless of which messaging document version the copy came from, so a document
// approved before this rule existed still ships a compliant email and no new document
// version is required to become compliant.
//
// The footer is a legal notice, not copy. It is appended after the sender sign-off and is
// deliberately excluded from every word budget. EMAIL_WORD_LIMITS in the messaging agent
// and BRIDGE_HEADROOM in compose-sequence both measure footer-free bodies, because a
// footer that consumed the budget would silently suppress the Email 1 bridge.

export const OPT_OUT_FOOTER = 'Not for you? Just reply stop.'

// Extra top margin so the footer reads as a notice rather than as a closing line.
// plainTextToHtml drops blank paragraphs, so the separation cannot come from newlines.
// It has to be carried on the footer paragraph itself. See plainTextToHtml.
export const OPT_OUT_FOOTER_MARGIN_PX = 32
