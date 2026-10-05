// A STORED WRITER V2 SEQUENCE, AS COMPOSED EMAILS.
//
// The writer stores each email as greeting plus body, without the sign-off or footer. This
// adds the two-line sign-off every email carries (sender first name, sender company name,
// read per client from the organisation record) and puts the merge tag back on the greeting
// line, so the stored send record has the same form as an old-path one and the provider
// variables resolve it the same way. The footer is NOT added here: composeSequence adds it
// through finaliseForReading, its one call site for the footer, like every other email.

import type { ComposedEmail } from './compose-sequence'
import { countWords } from './personalization'
import type { WriterV2Record } from '@/lib/writer-v2/record'

export interface WriterV2Sender { firstName: string; company: string }

export function composeWriterV2Emails(record: WriterV2Record, sender: WriterV2Sender, prospectFirstName: string | null): ComposedEmail[] {
  if (!record.emails) throw new Error('composeWriterV2Emails: a template-tier record has no written emails')
  return [...record.emails].sort((a, b) => a.position - b.position).map(e => {
    const lines = e.body.trim().split('\n')
    // The greeting line names the prospect; it becomes the merge tag when it is exactly
    // their first name, so the record of what was sent is not tied to one rendering of it.
    if (prospectFirstName && lines[0]?.trim() === `${prospectFirstName.trim()},`) lines[0] = '{{first_name}},'
    const body = `${lines.join('\n').trim()}\n\n${sender.firstName}\n${sender.company}`
    const subject = e.position === 1 ? e.subject : null
    return {
      sequence_position: e.position,
      subject_line: subject,
      subject_char_count: subject ? subject.length : 0,
      body,
      word_count: countWords(body.replace('{{first_name}}', prospectFirstName ?? 'there')),
    }
  })
}
