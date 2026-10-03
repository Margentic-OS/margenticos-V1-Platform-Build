import { describe, it, expect } from 'vitest'
import { writerV2Failures, transformOutput, transformBody, acronymOf, initialisms, type WriterOutput } from '../checks'
import { researchFact, factsForProspect } from '../facts'
import { playbookProblems, type WriterPlaybook } from '../playbook'

// Invented names only: this repository is public.
const PLAYBOOK: WriterPlaybook = {
  version: 1,
  market_story: 'Founder-led firms whose new business depends on the founder.',
  angles: [
    { name: 'Delivery eats the pipeline', detail: 'Outreach stops when a project lands.' },
    { name: 'Your name is on every email', detail: 'Nothing goes out unseen.', transparency: true },
  ],
  offer: 'We run outreach end to end and book meetings with the right buyers.',
  proof: 'Full visibility of every person contacted and every email sent.',
  never_claim: [{ rule: 'Results or guarantees', patterns: ['\\bguarantee'] }],
  calls_to_action: { guidance: 'Aim for a conversation.', never: [{ rule: 'Never mention call length', patterns: ['\\b\\d+\\s*-?\\s*min(?:ute)?s?\\b'] }] },
  voice: 'Warm and direct.',
  examples: [{ label: 'Example', origin: 'approved', emails: [{ body: 'Sam,\n\nWorth a chat about the Northgate launch?' }] }],
}

const TODAY = new Date(Date.UTC(2026, 9, 3))
const SENDER = { firstName: 'Dana', company: 'Testco' }
const PROSPECT = { firstName: 'Riley', lastName: 'Marlow', role: 'Founder', companyName: 'Kessel Human Resources Partners LLC', shortName: 'Kessel Human Resources Partners' }
const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ')

function facts() {
  return factsForProspect([
    { id: 'c1', observation: 'Spoke at the Vantor summit on hiring in June 2026', source: 'linkedin', provenance: 'post', date: '2026-06-12', is_composite: false } as never,
    { id: 'c2', observation: 'Founded the firm in 2009', source: 'website', provenance: 'about page', date: '2026-05-01', is_composite: false } as never,
    { id: 'c3', observation: 'Old award', source: 'website', provenance: 'news', date: '2024-01-01', is_composite: false } as never,
  ], null, 'Human Resources', TODAY)
}

function output(over: Partial<WriterOutput> = {}): WriterOutput {
  return {
    fact_used: { fact_id: 'R1', quote: 'Spoke at the Vantor summit' },
    link_sentence: 'x',
    angles: [1, 2, 3, 4].map(email => ({ email, angle: 'a' })),
    emails: [
      { email: 1, subject: 'the summit', body: `Riley,\n\nSaw you spoke at the Vantor summit in June.\n\n${words(40)}.\n\nWorth a chat?` },
      { email: 2, subject: null, body: `Riley,\n\n${words(35)}.\n\nWorth a chat?` },
      { email: 3, subject: null, body: `Riley,\n\n${words(35)}.\n\nWorth a chat?` },
      { email: 4, subject: null, body: 'Riley,\n\nLast one from me. Just reply if it moves up the list.' },
    ],
    prospect_claims: [{ email: 1, sentence: 'Saw you spoke at the Vantor summit in June.', fact_id: 'R1' }],
    sender_claims: [],
    ...over,
  }
}

const run = (out: WriterOutput, offered = facts()) => writerV2Failures({ output: out, offered, prospect: PROSPECT, sender: SENDER, playbook: PLAYBOOK })

describe('writer v2 facts', () => {
  it('keeps a dated fact in the window, marks it recent, and refuses founding dates and old facts', () => {
    const f = facts()
    expect(f[0]).toMatchObject({ id: 'R1', ineligible: null, recent: true })
    expect(f[1].ineligible).toMatch(/founding date/)
    expect(f[2].ineligible).toMatch(/older than 12 months/)
    expect(f[3]).toMatchObject({ id: 'RECORD', kind: 'record' })
  })
  it('an undated fact is not eligible', () => {
    expect(researchFact({ id: 'c', observation: 'x', source: 'website', provenance: 'p', date: null, is_composite: false } as never, 0, TODAY).ineligible).toBe('undated')
  })
})

describe('writer v2 checks', () => {
  it('passes a clean sequence', () => {
    expect(run(output())).toEqual([])
  })

  it('word bands are section 0 bands, counted with the two-line sign-off', () => {
    const long = output()
    long.emails[0].body = `Riley,\n\nSaw you spoke at the Vantor summit in June.\n\n${words(100)}.\n\nWorth a chat?`
    expect(run(long).join()).toMatch(/Email 1 is \d+ words with the sign-off; it must be 40 to 110/)
    const e4 = output()
    e4.emails[3].body = `Riley,\n\n${words(42)}.`
    expect(run(e4).join()).toMatch(/Email 4 is 45 words.*under 45/)
  })

  it('a claim resting on a fact not offered fails', () => {
    const offeredOnlyRecord = facts().filter(f => f.id === 'RECORD')
    expect(run(output(), offeredOnlyRecord).join()).toMatch(/not one of the facts given/)
  })

  it('a claim resting on an ineligible fact fails', () => {
    const out = output({ prospect_claims: [{ email: 1, sentence: 'Saw you spoke at the Vantor summit in June.', fact_id: 'R2' }] })
    expect(run(out).join()).toMatch(/may not be used: reads as a founding date/)
  })

  it('a wrong month fails', () => {
    const out = output()
    out.emails[0].body = out.emails[0].body.replace('in June', 'in March')
    out.prospect_claims = [{ email: 1, sentence: 'Saw you spoke at the Vantor summit in March.', fact_id: 'R1' }]
    expect(run(out).join()).toMatch(/says march, but R1 is dated 2026-06-12/)
  })

  it('an undeclared event-shaped sentence fails', () => {
    const out = output({ prospect_claims: [] })
    expect(run(out).join()).toMatch(/rests on no declared fact/)
  })

  it('a plain statement using the firm initials is caught like one using its name', () => {
    expect(acronymOf('Kessel Human Resources Partners')).toBe('KHRP')
    const out = output()
    out.emails[1].body = `Riley,\n\nKHRP is growing fast.\n\n${words(33)}.\n\nWorth a chat?`
    expect(run(out).join()).toMatch(/"KHRP is growing fast\." says something about the prospect/)
  })

  it('an abbreviation matches its full form, in both directions', () => {
    expect(initialisms('Human Resources').has('hr')).toBe(true)
    const out = output()
    out.emails[1].body = `Riley,\n\nPlenty of HR firms we talk to tell us the same.\n\n${words(30)}.\n\nWorth a chat?`
    expect(run(out)).toEqual([])
    const reverse = output()
    reverse.emails[2].body = `Riley,\n\nSomething Human Resources leads tell us a lot.\n\n${words(30)}.\n\nWorth a chat?`
    expect(run(reverse, facts().map(f => (f.id === 'RECORD' ? { ...f, evidence: 'HR' } : f)))).toEqual([])
  })

  it('a proper noun found in no input fails, and one lifted from an example is not sourced', () => {
    const out = output()
    out.emails[1].body = `Riley,\n\nThe Northgate launch went well for Zorbex.\n\n${words(30)}.\n\nWorth a chat?`
    const joined = run(out).join()
    expect(joined).toMatch(/names "Northgate"/)
    expect(joined).toMatch(/names "Zorbex"/)
  })

  it('never-claim and call-to-action patterns from the playbook fail a sentence', () => {
    const out = output()
    out.emails[2].body = `Riley,\n\nWe guarantee results.\n\n${words(30)}.\n\nWorth a 15-minute chat?`
    const joined = run(out).join()
    expect(joined).toMatch(/Results or guarantees/)
    expect(joined).toMatch(/Never mention call length/)
  })

  it('a sender claim citing a line not in the playbook fails', () => {
    const out = output({ sender_claims: [{ email: 2, sentence: 'x', playbook_line: 'we double your revenue' }] })
    expect(run(out).join()).toMatch(/cites a playbook line that is not in the playbook/)
  })

  it('Email 1 needs a subject and follow-ups have none', () => {
    const out = output()
    out.emails[0].subject = null
    out.emails[1].subject = 'hello'
    const joined = run(out).join()
    expect(joined).toMatch(/Email 1 has no subject/)
    expect(joined).toMatch(/must have no subject/)
  })
})

describe('writer v2 transforms', () => {
  it('removes every dash and leaves one blank line between paragraphs', () => {
    const t = transformBody('Riley,\nGood visibility — solid work.\n\n\nWorth a chat?')
    expect(t).not.toMatch(/[—–]/)
    expect(t).toBe('Riley,\n\nGood visibility, solid work.\n\nWorth a chat?')
  })
  it('keeps declared sentences matching the transformed body', () => {
    const out = output()
    out.emails[0].body = out.emails[0].body.replace('Saw you spoke at the Vantor summit in June.', 'Saw you spoke at the Vantor summit in June — nice.')
    out.prospect_claims = [{ email: 1, sentence: 'Saw you spoke at the Vantor summit in June — nice.', fact_id: 'R1' }]
    expect(run(transformOutput(out))).toEqual([])
  })
})

describe('writer v2 playbook', () => {
  it('a complete playbook has no problems; a broken pattern and missing parts are named', () => {
    expect(playbookProblems(PLAYBOOK)).toEqual([])
    const broken = { ...PLAYBOOK, offer: '', never_claim: [{ rule: 'x', patterns: ['('] }] }
    const problems = playbookProblems(broken).join()
    expect(problems).toMatch(/offer is empty/)
    expect(problems).toMatch(/not a valid regular expression/)
  })
})

describe('the playbook survives a rewrite of the messaging document', () => {
  it('puts the live playbook back, and leaves a document with none alone', async () => {
    const { carryWriterPlaybook } = await import('../playbook')
    const current = { variants: {}, writer_playbook: PLAYBOOK }
    expect(carryWriterPlaybook({ variants: { A: {} } }, current)).toEqual({ variants: { A: {} }, writer_playbook: PLAYBOOK })
    expect(carryWriterPlaybook({ variants: {}, writer_playbook: { ...PLAYBOOK, offer: 'edited by a revision' } }, current)).toMatchObject({ writer_playbook: PLAYBOOK })
    expect(carryWriterPlaybook({ variants: {} }, { variants: {} })).toEqual({ variants: {} })
  })
})
