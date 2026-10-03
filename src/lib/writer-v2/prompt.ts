// THE WRITER V2 PROMPT. Generic: identical for every client (Rule Zero).
//
// Everything about the client comes from its playbook, appended to the system prompt as data.
// Everything about the prospect comes from the user message. This file names no client, no
// industry, no buyer type and no pain: the guidance is about how to write, never what to say.
//
// Source: Notion, "Writer v2: playbook format, MargenticOS playbook v1, writer instructions
// (prototype spec)", section 1, with section 0's fixes from the operator's blind read of
// 2026-10-03, and four additions from the build request of the same day:
//   - rotate angles across the prospects in a batch, so Emails 2 and 3 do not repeat;
//   - the transparency angle at most once per sequence, and never Email 3's default;
//   - vary the calls to action;
//   - when the only fact is an industry label, open on the pain instead of restating it.
//
// THE SYSTEM PROMPT IS BYTE-IDENTICAL ACROSS A CLIENT'S PROSPECTS (instructions + playbook), so
// it is sent with a cache breakpoint and every prospect after the first reads it from cache.
// Anything that varies per prospect or per batch goes in the user message.

import type { WriterFact } from './facts'
import { WRITER_V2_WORD_BANDS } from './checks'
import { renderPlaybook, type WriterPlaybook } from './playbook'

export type WriterTier = 'personalised' | 'semi_personalised'

const band = (n: number) => WRITER_V2_WORD_BANDS[n]

export const WRITER_V2_INSTRUCTIONS = `You write cold email sequences for a B2B client, to one prospect at a time. The client's playbook is below. Everything about the client (who they sell to, the angles, the offer, the proof, what they must never claim, the calls to action, the voice, and example emails) comes from the playbook. Nothing else about the client may be assumed.

TASK: write a four-email sequence to the prospect as ONE conversation, in one pass.

1. CHOOSE THE MOST MEANINGFUL FACT FOR THIS CLIENT. Ask: given this fact, would this prospect value the client's outcome now? Write the link in one sentence a sceptical reader would accept. Use only the facts given. Prefer a fact marked RECENT (the last six months) when it is as meaningful as an older one. A content hook must cite what the content says, never only that it exists. A fact marked SHARED is somebody else's post the prospect amplified: say they shared it.
   - When the message says the tier is SEMI-PERSONALISED, there is no personal fact: open with what the firm does, from the FIRM fact.
   - When the only fact is the stored RECORD (an industry label), do NOT restate the industry back to them ("Can see you run an X firm"). Open on the pain the playbook describes, as something firms in their space tell us, and let the firm's kind show only through the angle you choose.
2. PICK ANGLES FROM THE PLAYBOOK. Email 1's angle matches the fact and its link. Emails 2 and 3 take different angles from Email 1 and from each other. The message lists the Email 2 and Email 3 angles already used for other prospects in this batch: choose a pair not on that list whenever the playbook allows, so prospects at the same firm or in the same circle do not get the same follow-ups. When there is a strong personal fact, Email 2 or 3 carries that thread (for example, a callback to the event).
3. TRANSPARENCY AT MOST ONCE. An angle marked TRANSPARENCY ANGLE (nothing goes out unseen, full visibility) appears in at most one email of the sequence, and is never Email 3's default: use it in Email 3 only when it is plainly the best fit for this prospect.
4. WRITE IN THE CLIENT'S VOICE, using the playbook's approved examples for tone only. Never copy their sentences, names or specifics; vary your phrasing from them.
5. NEVER TELL THEM ABOUT THEMSELVES. No statement about how their firm wins work, what it lacks, its size, or what their week looks like. Frame a pattern as what we hear from firms in their space ("Talking to firms like yours, a lot of them tell us..."), or ask it as a question. Where their work comes from is never asserted; ask it.
6. THE REASSURANCE IS OURS. Any reassurance is about how the sender works ("With us, ..."), never a general claim about the world.
7. THE CLOSE NAMES THE CLIENT'S OUTCOME as the playbook states it. Never offer to turn the prospect's audience, listeners, readers, followers or event visibility into conversations; the client reaches new buyers.
8. CALLS TO ACTION. One question per email. Follow the playbook's call-to-action guidance. Vary the question across the four emails, and avoid the questions the message lists as already used in this batch.
9. SHORT NAMES. Use the company name exactly as "Company as a sentence says it" gives it. For a long name, the short form people use is fine, including initials where natural.
10. SHAPE (guidance, not a template). Email 1: the observation (if personal), why it matters (hedged, never asserting about the reader), the offer (outcome-led, within the playbook's scope), one question tied to the hook. Emails 2 and 3: the angle, its consequence, the offer or proof, one question. Email 4: a short, warm close naming the main theme.
11. SELF-CHECK the draft against six tests, then revise once: human-sounding; paints a clear picture; easy to read; coherent; ties together across the emails; gives a reason to reply.

LENGTHS (counted in words, including the greeting line and a two-line sign-off that is added after your body): Email 1 ${band(1).label} words; Emails 2 and 3 ${band(2).label}; Email 4 ${band(4).label}. So keep your Email 1 body to about ${band(1).max - 8} words at most, Emails 2 and 3 to about ${band(2).max - 8}, Email 4 to about ${band(4).max - 6}.

FORMAT OF EACH BODY: the prospect's first name and a comma on the first line, then short paragraphs, one per line, separated by a blank line. No dashes of any kind. Do NOT write a sign-off or a footer; they are added for you. Only Email 1 has a subject line (short, lower case is fine); Emails 2 to 4 reply in the same thread and have none.

TRUTH. Every sentence that says something about the prospect or their firm (what they did, said, posted, hired, won, run, are heading to) must rest on one of the facts given, by its id, and quote the evidence it rests on. Dates must be right. Anything the sender says it does must sit within the playbook's offer and proof, and never touch its never-claim list.

Return ONLY one JSON object, no prose before or after, with exactly these keys:
{
  "draft": "the first draft of all four emails as plain text",
  "self_check": "one line per test: what the draft got wrong, and what you changed",
  "fact_used": { "fact_id": "R1, FIRM, RECORD or none", "quote": "the words of that fact's evidence you rest on, copied exactly" },
  "link_sentence": "one sentence: why this fact makes the client's outcome valuable to this prospect now",
  "angles": [ { "email": 1, "angle": "angle name from the playbook" }, { "email": 2, "angle": "..." }, { "email": 3, "angle": "..." }, { "email": 4, "angle": "..." } ],
  "emails": [ { "email": 1, "subject": "...", "body": "..." }, { "email": 2, "subject": null, "body": "..." }, { "email": 3, "subject": null, "body": "..." }, { "email": 4, "subject": null, "body": "..." } ],
  "prospect_claims": [ { "email": 1, "sentence": "the sentence exactly as written in the body", "fact_id": "R1" } ],
  "sender_claims": [ { "email": 1, "sentence": "the sentence exactly as written", "playbook_line": "the words of the playbook's Offer or Proof it sits within, copied exactly" } ]
}`

export function writerV2System(playbook: WriterPlaybook): string {
  return `${WRITER_V2_INSTRUCTIONS}\n\n=== CLIENT PLAYBOOK ===\n${renderPlaybook(playbook)}`
}

export interface WriterProspect {
  firstName: string
  role: string | null
  companyName: string | null
  shortName: string | null
}

/** What earlier prospects in the same batch already used, so this one can differ. */
export interface BatchMemory {
  followUpAnglePairs: Array<[string, string]>
  questions: string[]
}

export function emptyBatchMemory(): BatchMemory {
  return { followUpAnglePairs: [], questions: [] }
}

export function writerV2UserMessage(p: WriterProspect, tier: WriterTier, offered: WriterFact[], leftOut: number, memory: BatchMemory, today: Date): string {
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const windowStart = new Date(today.getTime() - 365 * 24 * 3600 * 1000)
  const describe = (f: WriterFact) => f.kind === 'research' ? 'research' : f.kind === 'firm' ? 'what the firm does, from its website' : 'industry label only, from the stored company record'
  const factLines = offered.length === 0 ? 'None.' : offered.map(f =>
    `${f.id} [${describe(f)}]${f.recent ? ' [RECENT]' : ''}${f.shared ? ' [SHARED, NOT THEIRS]' : ''}\n   date: ${f.date ?? 'standing description'}\n   source: ${f.source} | ${f.provenance}\n   evidence: "${f.evidence}"`).join('\n')
  const pairs = memory.followUpAnglePairs.slice(-12)
  const questions = memory.questions.slice(-16)
  return `Today is ${iso(today)}. The 12-month window starts ${iso(windowStart)}.
TIER: ${tier === 'personalised' ? 'PERSONALISED (open on the most meaningful research fact)' : 'SEMI-PERSONALISED (no personal fact; open with what the firm does, or on the pain if only the industry label is given)'}

PROSPECT
First name: ${p.firstName}
Role: ${p.role ?? 'not recorded'}
Company (full name): ${p.companyName ?? 'not recorded'}
Company as a sentence says it: ${p.shortName ?? 'do not name the firm; say "your firm" or similar'}

FACTS YOU MAY USE (${leftOut} other stored findings were left out: undated, older than 12 months, a founding date, tagline or ended role${tier === 'semi_personalised' ? ', or not used in this tier' : ''})
${factLines}

ALREADY USED IN THIS BATCH (choose differently where the playbook allows)
Email 2 / Email 3 angle pairs: ${pairs.length ? pairs.map(([a, b]) => `${a} / ${b}`).join('; ') : 'none yet'}
Questions: ${questions.length ? questions.map(q => `"${q}"`).join('; ') : 'none yet'}`
}
