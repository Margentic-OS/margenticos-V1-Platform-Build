// THE CLIENT'S WRITER PLAYBOOK, stored as data in the client's messaging document.
//
// Writer v2 (see src/agents/sequence-writer-agent.ts) writes every sequence from this and the
// prospect's facts. Nothing about any client is written in code: the market story, angles,
// offer, proof, never-claim list, calls to action, voice and approved examples all live here,
// under content.writer_playbook of the active messaging strategy document.
//
// WHY IT LIVES IN THE MESSAGING DOCUMENT. It reaches the writer the same way every other piece
// of client copy does: proposed as a document_suggestions row, approved by the operator, and
// versioned with the document so any earlier version can be restored. No new table.
//
// THE NEVER-CLAIM PATTERNS ARE DATA TOO. Each rule carries the regular expressions code tests
// every sentence against. A client whose never-claim list differs gets different patterns from
// its own playbook, never a list in this file.

export interface PatternRule {
  rule: string
  /** Case-insensitive regular expressions, tested against every sentence of every email. */
  patterns: string[]
}

export interface PlaybookExample {
  label: string
  /** 'approved' for the operator's hand-approved examples, 'prototype' for a strong writer
   *  output the operator chose to add. Both are tone only. */
  origin: 'approved' | 'prototype'
  emails: Array<{ subject?: string | null; body: string }>
}

export interface PlaybookAngle {
  name: string
  /** The pain, its consequence, how the offer helps, and the signals that make it relevant. */
  detail: string
  /** True for the angle about seeing everything before it goes out. The writer is told to use
   *  such an angle at most once per sequence and never as Email 3's default. */
  transparency?: boolean
}

export interface WriterPlaybook {
  version: number
  market_story: string
  angles: PlaybookAngle[]
  offer: string
  proof: string
  never_claim: PatternRule[]
  calls_to_action: { guidance: string; never: PatternRule[] }
  voice: string
  /** What makes a prospect personal for this client. Guidance for the writer, never a gate. */
  personal_guidance?: string | null
  examples: PlaybookExample[]
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

function patternRuleProblems(v: unknown, where: string): string[] {
  if (!Array.isArray(v)) return [`${where} is not a list`]
  return v.flatMap((r, i) => {
    const at = `${where}[${i}]`
    if (!r || typeof r !== 'object') return [`${at} is not an object`]
    const rule = r as Record<string, unknown>
    const out: string[] = []
    if (!isText(rule.rule)) out.push(`${at}.rule is empty`)
    if (!Array.isArray(rule.patterns)) return [...out, `${at}.patterns is not a list`]
    rule.patterns.forEach((p, j) => {
      if (!isText(p)) { out.push(`${at}.patterns[${j}] is empty`); return }
      try { new RegExp(p, 'i') } catch { out.push(`${at}.patterns[${j}] is not a valid regular expression`) }
    })
    return out
  })
}

/** Every reason a stored value is not a usable playbook. Empty means it is one. */
export function playbookProblems(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return ['writer_playbook is not an object']
  const p = raw as Record<string, unknown>
  const out: string[] = []
  if (!(typeof p.version === 'number' && Number.isInteger(p.version) && p.version > 0)) out.push('version is not a positive whole number')
  for (const k of ['market_story', 'offer', 'proof', 'voice'] as const) if (!isText(p[k])) out.push(`${k} is empty`)
  if (!Array.isArray(p.angles) || p.angles.length < 2) out.push('angles needs at least two entries')
  else p.angles.forEach((a, i) => {
    const angle = a as Record<string, unknown> | null
    if (!angle || !isText(angle.name) || !isText(angle.detail)) out.push(`angles[${i}] needs a name and a detail`)
  })
  out.push(...patternRuleProblems(p.never_claim, 'never_claim'))
  const cta = p.calls_to_action as Record<string, unknown> | undefined
  if (!cta || !isText(cta.guidance)) out.push('calls_to_action.guidance is empty')
  else out.push(...patternRuleProblems(cta.never, 'calls_to_action.never'))
  if (!Array.isArray(p.examples) || p.examples.length === 0) out.push('examples needs at least one entry')
  else p.examples.forEach((e, i) => {
    const ex = e as Record<string, unknown> | null
    if (!ex || !isText(ex.label)) out.push(`examples[${i}].label is empty`)
    if (!ex || (ex.origin !== 'approved' && ex.origin !== 'prototype')) out.push(`examples[${i}].origin must be approved or prototype`)
    const emails = ex?.emails
    if (!Array.isArray(emails) || emails.length < 1 || emails.length > 4) out.push(`examples[${i}].emails needs one to four emails`)
    else emails.forEach((m, j) => { if (!isText((m as Record<string, unknown> | null)?.body)) out.push(`examples[${i}].emails[${j}].body is empty`) })
  })
  return out
}

/** The playbook from a messaging document's content, or null with the reason. */
export function playbookFromDocumentContent(content: unknown): { playbook: WriterPlaybook | null; problem: string | null } {
  const raw = (content as Record<string, unknown> | null | undefined)?.writer_playbook
  if (raw === undefined || raw === null) return { playbook: null, problem: 'the messaging document has no writer_playbook' }
  const problems = playbookProblems(raw)
  if (problems.length > 0) return { playbook: null, problem: `writer_playbook is malformed: ${problems.join('; ')}` }
  return { playbook: raw as WriterPlaybook, problem: null }
}

/**
 * Everything the writer may cite as what the sender does, with the examples left out. A
 * sender claim must sit within this text, and a proper noun or number must appear in it or in
 * the prospect's facts: a name lifted from an example is copied, not sourced.
 */
export function playbookScopeText(p: WriterPlaybook): string {
  return [
    p.market_story,
    ...p.angles.flatMap(a => [a.name, a.detail]),
    p.offer,
    p.proof,
    ...p.never_claim.map(r => r.rule),
    p.calls_to_action.guidance,
    p.voice,
    p.personal_guidance ?? '',
  ].join('\n')
}

/** The playbook as the writer reads it, in the system prompt. */
export function renderPlaybook(p: WriterPlaybook): string {
  const L: string[] = []
  L.push('## Market story', p.market_story, '')
  L.push('## Angles')
  p.angles.forEach((a, i) => L.push(`${i + 1}. ${a.name}${a.transparency ? ' [TRANSPARENCY ANGLE]' : ''}: ${a.detail}`))
  L.push('', '## Offer', p.offer, '', '## Proof', p.proof, '')
  L.push('## Never claim', ...p.never_claim.map(r => `- ${r.rule}`), '')
  L.push('## Calls to action', p.calls_to_action.guidance, ...p.calls_to_action.never.map(r => `- Never: ${r.rule}`), '')
  L.push('## Voice', p.voice, '')
  if (p.personal_guidance) L.push('## What makes a prospect personal for this client', p.personal_guidance, '')
  L.push('## Approved examples (tone only; never copy their sentences, names or specifics)')
  for (const ex of p.examples) {
    L.push('', `### ${ex.label}`)
    ex.emails.forEach((e, i) => {
      L.push('', `Email ${i + 1}${e.subject ? ` (subject: ${e.subject})` : ''}:`, e.body)
    })
  }
  return L.join('\n')
}

/** Sentences of four or more words from the examples, for the copied-phrase report. */
export function exampleSentences(p: WriterPlaybook): string[] {
  return p.examples.flatMap(ex => ex.emails.flatMap(e => e.body.split(/\n+/)))
    .flatMap(l => l.split(/(?<=[.?!])\s+(?=[A-Z"“])/))
    .map(s => s.trim())
    .filter(s => s.split(/\s+/).length >= 4)
}
