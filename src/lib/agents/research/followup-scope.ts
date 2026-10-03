// WHAT THE SENDER MAY SAY IT DOES, IN A PERSONALISED FOLLOW-UP. Operator instruction,
// 2026-10-03.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS. A personalised Email 2, written after a prospect spoke at an event, said
// the sender would go and contact the people who saw them there. That is not what this
// client does: its brief says it finds THE CLIENT'S buyers. The follow-up checker asked only
// whether claims about the PROSPECT were supported, so a claim about the SENDER passed
// unread. The template path already checks every line against the brief's scope; the
// personalised follow-ups did not, and they are the copy written per prospect, which is
// exactly where an invented service turns up.
//
// THE SCOPE COMES FROM THE CLIENT, NEVER FROM HERE. Rule Zero: nothing in this file names a
// market, a buyer or a service. What a sender does, what it never claims and what a reader
// can get are read from that client's own brief at run time.
// ═════════════════════════════════════════════════════════════════════════════

/** The parts of a client's brief that bound what a follow-up may say the sender does. */
export interface FollowupScope {
  /** scope.does: statements of what the sender does. */
  does: Array<{ id: string; statement: string }>
  /** scope.never_claims: what the sender never claims, with the phrases code refuses outright. */
  never_claims: Array<{ id: string; statement: string; phrases: string[] }>
  /** outcomes: what the reader can get, which a follow-up never presents as already theirs. */
  outcomes: Array<{ id: string; statement: string }>
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

function readItems(raw: unknown): Array<{ id: string; statement: string }> {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(item => {
    const o = item as Record<string, unknown> | null
    return o && isText(o.id) && isText(o.statement) ? [{ id: o.id, statement: o.statement }] : []
  })
}

/**
 * The scope inside a messaging document, or null when there is none.
 *
 * READ NARROWLY, NOT THROUGH readBrief, for the reason readCompetitorCategories gives in
 * brief.ts: readBrief returns NO brief on any validation problem, and the validator carries
 * copy rules. Read through it, a wording fault anywhere in the brief, or a field added to
 * the shape, would switch the scope check off with no error. What the sender may say it does
 * is not a copy question, so it does not inherit copy rules. An item missing its id or its
 * statement is dropped; the rest still bind.
 *
 * NULL WHEN scope.does IS EMPTY. A scope with nothing in it would refuse every sentence about
 * the sender, which is a broken brief, not a rule. With no scope the follow-ups behave as
 * they did before this existed.
 */
export function followupScopeFromMessaging(content: unknown): FollowupScope | null {
  if (!content || typeof content !== 'object') return null
  const brief = (content as Record<string, unknown>).outbound_brief
  if (!brief || typeof brief !== 'object') return null
  const b = brief as Record<string, unknown>
  const scope = (b.scope && typeof b.scope === 'object' ? b.scope : {}) as Record<string, unknown>
  const does = readItems(scope.does)
  if (does.length === 0) return null
  const neverClaims = Array.isArray(scope.never_claims)
    ? scope.never_claims.flatMap(item => {
        const o = item as Record<string, unknown> | null
        if (!o || !isText(o.id) || !isText(o.statement)) return []
        const phrases = Array.isArray(o.phrases) ? o.phrases.filter(isText).map(p => p.toLowerCase()) : []
        return [{ id: o.id, statement: o.statement, phrases }]
      })
    : []
  return { does, never_claims: neverClaims, outcomes: readItems(b.outcomes) }
}

/**
 * Every never_claims phrase in a piece of copy. WHOLE WORDS, case-insensitive, any run of
 * whitespace inside a phrase: the same matching the template validator uses, so a phrase
 * refused in a template is refused here and nowhere else.
 *
 * FREE AND FIRST. A phrase the client has said it never uses needs no model to recognise,
 * so the follow-up fails on it without paying for the checker.
 */
export function findNeverClaimPhrases(
  text: string,
  scope: FollowupScope,
): Array<{ id: string; statement: string; phrase: string }> {
  const lower = text.replace(/[‘’]/g, "'").toLowerCase()
  const hits: Array<{ id: string; statement: string; phrase: string }> = []
  for (const rule of scope.never_claims) {
    for (const phrase of rule.phrases) {
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
      if (new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(lower)) {
        hits.push({ id: rule.id, statement: rule.statement, phrase })
      }
    }
  }
  return hits
}

/** The reason a never_claims phrase fails a follow-up. Named per email, as every follow-up failure is. */
export function neverClaimPhraseFailure(
  position: 2 | 3,
  hit: { id: string; statement: string; phrase: string },
): string {
  return `email ${position} holds "${hit.phrase}", which this client never claims (${hit.id}: ${hit.statement})`
}

/**
 * The scope as the follow-up WRITER sees it, in the user message.
 *
 * NOT IN THE SYSTEM PROMPT, because it differs per client and that prompt is a cached
 * constant. The system prompt carries the rule that this block exists to be obeyed; the
 * content arrives here. Kept in step with what the checker is shown: the same statements,
 * the same phrases, the same outcomes.
 */
export function scopeBlockForWriter(scope: FollowupScope): string {
  return [
    `## What the sender does, and what it never claims`,
    ``,
    `Every sentence about what the sender does or will do says one of the things below, and`,
    `nothing beyond it. Work that resembles one of them but is done for different people, or`,
    `on a different thing, is not one of them. If what you want to say is not here, leave it out.`,
    ``,
    `What the sender does:`,
    ...scope.does.map(d => `- ${d.statement}`),
    ...(scope.never_claims.length > 0 ? [
      ``,
      `What the sender never claims, in any wording:`,
      ...scope.never_claims.map(n =>
        `- ${n.statement}${n.phrases.length > 0 ? ` (never these words: ${n.phrases.map(p => `"${p}"`).join(', ')})` : ''}`,
      ),
    ] : []),
    ...(scope.outcomes.length > 0 ? [
      ``,
      `What the reader can get from it. Something they CAN get, never something they already have:`,
      ...scope.outcomes.map(o => `- ${o.statement}`),
    ] : []),
  ].join('\n')
}

/** The scope as the follow-up CHECKER sees it: the same items, with the ids its answer cites. */
export function scopeBlockForChecker(scope: FollowupScope): string {
  return [
    `## The sender's scope`,
    ``,
    `What the sender does:`,
    JSON.stringify(scope.does),
    ``,
    `What the sender never claims:`,
    JSON.stringify(scope.never_claims.map(n => ({ id: n.id, statement: n.statement }))),
    ``,
    `Outcomes the reader can get:`,
    JSON.stringify(scope.outcomes),
  ].join('\n')
}
