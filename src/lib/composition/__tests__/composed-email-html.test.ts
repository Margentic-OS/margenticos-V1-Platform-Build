// The HTML a prospect actually receives. Two defects shipped on 2026-08-21, both gated here.
//
//   1. Every paragraph was double-spaced. The cause was not a <br> in our output.
//      plainTextToHtml joined its <p> elements with a newline, purely so the stored value
//      read nicely, and the outbound provider converts every newline inside a substituted
//      variable value into a <br> at send time. The delivered mail was <p>a</p><br><p>b</p>:
//      the <p> spacing plus the <br>, doubled. Verified against the live provider record
//      before the fix: the stored m_body_1 for shevonne@electroconsulting.au held six
//      literal newlines, and the delivered message held six <br> at those six positions.
//
//   2. The sent document had no <body>. The provider emits <html><head>...</head> and then
//      drops the campaign shell step body straight in. That step body is the only part of
//      the document our code controls, so the <body> has to come from there. The old
//      wrapper, <p>{{m_body_N}}</p>, was also invalid nesting: the value substituted into
//      it is itself a run of <p> elements, and a <p> may not contain a <p>.
//
// The bodies below are the real ones from that send, not invented fixtures.

import { describe, it, expect } from 'vitest'
import { plainTextToHtml, composedToVariables } from '../custom-variables'
import { OPT_OUT_FOOTER, OPT_OUT_FOOTER_MARGIN_PX } from '../opt-out-footer'
import type { ComposedEmail } from '../compose-sequence'

// The real email 1 that shipped to shevonne@electroconsulting.au on 2026-08-21, with
// {{first_name}} left unresolved so this also exercises the substitution.
const REAL_EMAIL_1 = [
  '{{first_name}}',
  'Your Founders Future episode traces the path from corporate HR to founding electro: consulting, and the thinking behind the practice.',
  'The founders who need that kind of help are usually searching elsewhere when the problem lands on their desk.',
  'We run outbound so qualified meetings land in the diary without you writing anything.',
  'Is getting in front of those founders before they go looking somewhere else something you are working on?',
  'Doug\nMargenticOS',
  OPT_OUT_FOOTER,
].join('\n\n')

// The wrapper buildShellSequences now writes, held as a literal so this file fails if the
// shell and the composition layer ever stop agreeing about what surrounds the body.
const SHELL_WRAPPER = '<body>{{m_body_1}}</body>'

// What the provider does at send time: substitute the value, then convert every newline in
// the result into a <br>. Verified against the live sent message for
// debra@uplevelhrconsulting.com on 2026-08-24, whose stored value carried newlines between
// paragraphs and whose delivered HTML carried <br> at exactly those positions.
function renderAsProviderWould(variableValue: string): string {
  return SHELL_WRAPPER.replace('{{m_body_1}}', variableValue).replace(/\n/g, '<br>')
}

// The real email 2 that shipped to debra@uplevelhrconsulting.com on 2026-08-24. Shorter,
// no observation slot, and the message whose delivered HTML confirmed the newline-to-<br>
// conversion.
const REAL_EMAIL_2 = [
  'Debra',
  'The pattern I see most often with consulting founders at your stage: outbound gets started when a big project ends, runs for a few weeks, then stops when something new lands. The pipeline never builds because the engine only fires in a panic.',
  "Close rate is usually fine. It's the conversation volume that's the problem.",
  'Does that sound like where you are?',
  'Doug\nMargenticOS',
  OPT_OUT_FOOTER,
].join('\n\n')

describe('composed email HTML — paragraph spacing', () => {
  it('puts no <br> between paragraphs', () => {
    for (const body of [REAL_EMAIL_1, REAL_EMAIL_2]) {
      const html = plainTextToHtml(body)
      expect(html).not.toMatch(/<\/p>\s*<br\s*\/?>/i)
      expect(html).not.toMatch(/<br\s*\/?>\s*<p[\s>]/i)
    }
  })

  it('leaves no newline for the provider to turn into a <br>', () => {
    // This is the actual regression. The provider does the newline-to-<br> conversion, so
    // the only defence is to emit no newline at all.
    for (const body of [REAL_EMAIL_1, REAL_EMAIL_2]) {
      expect(plainTextToHtml(body)).not.toContain('\n')
    }
  })

  it('joins </p> directly to the next <p> at every paragraph boundary', () => {
    const html = plainTextToHtml(REAL_EMAIL_2)

    expect(html).toContain(
      "<p>Close rate is usually fine. It's the conversation volume that's the problem.</p><p>Does that sound like where you are?</p>"
    )

    const boundaries = html.match(/<\/p>./g) ?? []
    expect(boundaries.length).toBeGreaterThan(0)
    for (const boundary of boundaries) expect(boundary).toBe('</p><')
  })

  it('no longer produces the exact shape that shipped on 2026-08-21', () => {
    // What the reader actually received. If this string ever comes back, the fix is gone.
    const shipped =
      '<p>Debra</p><br><p>The pattern I see most often with consulting founders at your stage'
    expect(plainTextToHtml(REAL_EMAIL_2)).not.toContain(shipped)
  })

  it('keeps the <br> inside the sign-off, which is a line break and not a paragraph gap', () => {
    // The two sign-off lines are one paragraph. This <br> is correct and must survive.
    for (const body of [REAL_EMAIL_1, REAL_EMAIL_2]) {
      expect(plainTextToHtml(body)).toContain('<p>Doug<br>MargenticOS</p>')
    }
  })

  it('still separates the footer from the sign-off now the joining newline is gone', () => {
    // The newline never provided that separation. The margin does, and it is the only thing
    // that does, because plainTextToHtml drops blank paragraphs.
    expect(plainTextToHtml(REAL_EMAIL_1)).toContain(
      `<p>Doug<br>MargenticOS</p><p style="margin-top:${OPT_OUT_FOOTER_MARGIN_PX}px">`
    )
  })
})

describe('assembled outbound email document', () => {
  it('contains a <body> tag', () => {
    const sent = renderAsProviderWould(plainTextToHtml(REAL_EMAIL_1))
    expect(sent).toContain('<body>')
    expect(sent).toContain('</body>')
  })

  it('does not nest a <p> inside a <p>', () => {
    const sent = renderAsProviderWould(plainTextToHtml(REAL_EMAIL_1))
    expect(sent).not.toMatch(/^<p[ >]/)
    expect(sent).toMatch(/^<body><p>/)
  })

  it('renders every paragraph singly spaced once the provider has finished with it', () => {
    const sent = renderAsProviderWould(plainTextToHtml(REAL_EMAIL_1))

    expect(sent).toContain('</p><p')
    expect(sent).not.toMatch(/<\/p><br\s*\/?><p/i)

    // Seven paragraphs in, seven <p> out, and the only <br> left is the sign-off's.
    expect(sent.match(/<p[ >]/g)).toHaveLength(7)
    expect(sent.match(/<br>/g)).toHaveLength(1)
  })

  it('carries the opt-out footer and its inline margin through to the sent document', () => {
    // This footer was silently missing from every stored email until a previous fix. It is
    // the compliance line and it must not regress, margin included.
    const sent = renderAsProviderWould(plainTextToHtml(REAL_EMAIL_1))
    expect(sent).toContain(
      `<p style="margin-top:${OPT_OUT_FOOTER_MARGIN_PX}px">${OPT_OUT_FOOTER}</p>`
    )
    // Last thing before the closing wrapper, nothing after it.
    expect(sent.endsWith(`${OPT_OUT_FOOTER}</p></body>`)).toBe(true)
  })

  it('holds through composedToVariables with the prospect name resolved', () => {
    const emails: ComposedEmail[] = [
      {
        sequence_position: 1,
        subject_line: 'diary filling itself',
        subject_char_count: 20,
        body: REAL_EMAIL_1,
        word_count: 0,
      },
    ]
    const vars = composedToVariables(emails, 'Shevonne')

    expect(vars.m_body_1).toContain('<p>Shevonne</p>')
    expect(vars.m_body_1).not.toContain('{{first_name}}')
    expect(vars.m_body_1).not.toContain('\n')
    expect(vars.m_body_1).not.toMatch(/<\/p><br\s*\/?><p/i)
    expect(vars.m_body_1).toContain(
      `<p style="margin-top:${OPT_OUT_FOOTER_MARGIN_PX}px">${OPT_OUT_FOOTER}</p>`
    )
  })
})
