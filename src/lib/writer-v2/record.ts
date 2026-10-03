// WHAT WRITER V2 STORES ON THE PROSPECT (prospects.writer_v2_sequence), and the one reader
// composition uses to decide whether a stored sequence may ship.

import type { TokenUsage } from '@/lib/agents/research/types'

export type WriterV2Tier = 'personalised' | 'semi_personalised' | 'template'

export interface WriterV2Attempt {
  tier: Exclude<WriterV2Tier, 'template'>
  /** Empty when the attempt passed. */
  failures: string[]
  usage: TokenUsage
  stop_reason: string | null
}

export interface WriterV2Record {
  /** The shape of this record, so a later reader can tell an old one. */
  record_version: 1
  written_at: string
  model: string
  tier: WriterV2Tier
  /** The four emails as the writer wrote them after the code transforms: greeting and body, no
   *  sign-off, no footer. Null for the template tier, which composes from the variant. */
  emails: Array<{ position: number; subject: string | null; body: string }> | null
  fact_used: { fact_id: string; quote: string } | null
  link_sentence: string | null
  angles: Array<{ email: number; angle: string }>
  /** Every attempt, passed or failed, in order. Two per tier at most. */
  attempts: WriterV2Attempt[]
  /** Report only: sentences sharing five or more words with an approved example. */
  copied_phrases: string[]
  playbook_version: number
  /** 'document' when the playbook came from the active messaging document. 'file' only for a
   *  trial run; composition never ships a sequence written from a file. */
  playbook_source: 'document' | 'file'
  messaging_doc_id: string | null
  research_result_id: string | null
}

export type ShippableWriterV2 =
  | { ok: true; record: WriterV2Record }
  | { ok: false; why: string }

/**
 * Whether a stored record may be composed and sent. A missing, malformed or trial record is
 * NOT shippable, and upload holds the prospect rather than falling back to old copy: with the
 * switch on, the old writer's columns are stale by construction.
 */
export function shippableWriterV2(raw: unknown): ShippableWriterV2 {
  if (raw === null || raw === undefined) return { ok: false, why: 'no writer v2 sequence has been written for this prospect yet' }
  const r = raw as Partial<WriterV2Record>
  if (r.record_version !== 1) return { ok: false, why: 'the stored writer v2 sequence is in a shape this code does not read' }
  if (r.playbook_source !== 'document') return { ok: false, why: 'the stored writer v2 sequence was written from a trial playbook file, not the approved messaging document' }
  if (r.tier === 'template') return { ok: true, record: r as WriterV2Record }
  if (r.tier !== 'personalised' && r.tier !== 'semi_personalised') return { ok: false, why: 'the stored writer v2 sequence has no tier' }
  const emails = r.emails ?? []
  const positions = emails.map(e => e.position).sort().join(',')
  if (positions !== '1,2,3,4' || emails.some(e => typeof e.body !== 'string' || !e.body.trim())) {
    return { ok: false, why: 'the stored writer v2 sequence does not hold four written emails' }
  }
  return { ok: true, record: r as WriterV2Record }
}
