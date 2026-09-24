import { describe, it } from 'vitest'
import { findActivityVerdicts } from '@/lib/style/activity-verdict'
import { checkActivityVerdict } from '@/lib/style/activity-verdict'

const drafts = [
  'We run the outreach for you, and it runs with no extra work from you.',
  'There is no software for you to learn.',
  'Nothing about your marketing changes.',
  'Your outreach does not stop when a project lands.',
  'You take the calls that come from it.',
  'We write the emails, send them, and hand you the replies worth answering.',
]

describe('probe', () => {
  it('scan', () => {
    for (const d of drafts) {
      const hits = findActivityVerdicts(d, '')
      console.log(JSON.stringify({ d, hits: hits.map(h => [h.kind, h.matched]) }))
    }
    console.log('BLOCK MSG:', JSON.stringify(checkActivityVerdict(drafts[0], '', { prospectId: 'x' }, 'block')))
  })
})
