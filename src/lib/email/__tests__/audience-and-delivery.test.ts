// Every email template, rendered, put through the REAL validator.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS
//
// On 2026-09-05 an operator alert about a failed agent was rejected one millisecond
// after the failure, by the validator, on the template's own branding line:
//
//   sendTransactionalEmail: content validation failed
//   subject: "Tone of voice agent failed: MargenticOS"
//   error:   Email contains em dash (—) — use colon or comma instead
//
// `MargenticOS — Operator Alert` is hardcoded in agent-failure.ts. suggestion-ready.ts
// carries the same line. So BOTH notifications from /api/suggestions/regenerate had been
// discarded before reaching Resend, for the entire life of that code. The route's comment
// says it exists because the 2026-08-28 failure produced "no signal anywhere except a row
// in agent_runs". It has never produced a signal either.
//
// Nothing caught it because nothing rendered a template and asked the validator what it
// thought. Every existing test fed the validator hand-written strings. The templates and
// the rule that judges them were never introduced to each other.
//
// THIS FILE IS THAT INTRODUCTION. It renders all twenty templates with real parameters and
// asserts the verdict the production validator gives for the audience each is actually
// sent to.
// ═══════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

import { validateEmailContent, type EmailAudience } from '../send'

import { agentFailureTemplate, agentFailureSubject } from '../templates/agent-failure'
import { suggestionReadyTemplate, suggestionReadySubject } from '../templates/suggestion-ready'
import { allDocsGeneratedTemplate, allDocsGeneratedSubject, allDocsGeneratedTemplateText } from '../templates/all-docs-generated'
import { approvalReminderTemplate, approvalReminderSubject } from '../templates/approval-reminder'
import { clientRevisionNotifyTemplate, clientRevisionNotifySubject, clientRevisionNotifyTemplateText } from '../templates/client-revision-notify'
import { intakeCompleteTemplate, intakeCompleteSubject } from '../templates/intake-complete'
import { messagingRevisionStagedTemplate, messagingRevisionStagedSubject, messagingRevisionStagedTemplateText } from '../templates/messaging-revision-staged'
import { multiUserSignupAttemptTemplate, multiUserSignupAttemptSubject } from '../templates/multi-user-signup-attempt'
import { operatorReplyTemplate, operatorReplySubject, operatorReplyTemplateText } from '../templates/operator-reply'
import { revisionGateFailureTemplate, revisionGateFailureSubject } from '../templates/revision-gate-failure'
import { unmatchedBookingTemplate, unmatchedBookingSubject, type UnmatchedBookingNotice } from '../templates/unmatched-booking'

import { clientWelcomeTemplate, clientWelcomeSubject, clientWelcomeTemplateText } from '../templates/client-welcome'
import { docsReadyTemplate, docsReadySubject, docsReadyTemplateText } from '../templates/docs-ready'
import { firstMeetingTemplate, firstMeetingSubject, firstMeetingTemplateText } from '../templates/first-meeting'
import { intakeNudgeTemplate, intakeNudgeSubject, intakeNudgeTemplateText } from '../templates/intake-nudge'
import { listReadyTemplate, listReadySubject, listReadyTemplateText } from '../templates/list-ready'
import { meetingConfirmationTemplate, meetingConfirmationSubject } from '../templates/meeting-confirmation'
import { revisionProcessedTemplate, revisionProcessedSubject } from '../templates/revision-processed'
import { versionUpdatedTemplate, versionUpdatedSubject, versionUpdatedText } from '../templates/version-updated'
import { warmingCompleteTemplate, warmingCompleteSubject, warmingCompleteTemplateText } from '../templates/warming-complete'
import { warmupHalfwayTemplate, warmupHalfwaySubject, warmupHalfwayTemplateText } from '../templates/warmup-halfway'

interface RenderedTemplate {
  /** The template's own filename, so the exhaustiveness check can compare against disk. */
  file: string
  audience: EmailAudience
  subject: string
  html: string
  text?: string
}

// Real parameters, not placeholders. A template only shows its true rendered output when
// the values it interpolates are the shape production passes it.
const ORG = 'Apex Consulting'
const ORG_ID = '0ed34697-0fa9-4f08-ac15-d3504ac45caf'
const NOTE = 'Please make the second paragraph less formal.'

const UNMATCHED_BOOKING: UnmatchedBookingNotice = {
  reason: 'no_prospect',
  organisationName: ORG,
  bookingUid: 'bFJeNb2uX8ANpT3JL5EfXw',
  hostRef: null,
  attendeeEmail: null,
  attendeeName: null,
  startTime: null,
}

// ─── OPERATOR-FACING ─────────────────────────────────────────────────────────
// Verified by reading each call site's `to:` on 2026-09-07. Every one of these resolves to
// RESEND_OPERATOR_EMAIL or a users row with role 'operator'. None can reach a client.
const OPERATOR_TEMPLATES: RenderedTemplate[] = [
  {
    file: 'agent-failure.ts',
    audience: 'operator',
    subject: agentFailureSubject(ORG, 'tov'),
    html: agentFailureTemplate({
      orgName: ORG,
      orgId: ORG_ID,
      docType: 'tov',
      // The real error string from the 2026-09-05 run, so this test carries the actual
      // payload that was discarded rather than a stand-in for it.
      error: 'TOV agent: Claude returned content that is not valid JSON. Raw response has been logged. Do not write to the database.',
    }),
  },
  {
    file: 'suggestion-ready.ts',
    audience: 'operator',
    subject: suggestionReadySubject(ORG, 'tov'),
    html: suggestionReadyTemplate({ orgName: ORG, orgId: ORG_ID, docType: 'tov' }),
  },
  {
    file: 'all-docs-generated.ts',
    audience: 'operator',
    subject: allDocsGeneratedSubject(ORG),
    html: allDocsGeneratedTemplate({ orgName: ORG, orgId: ORG_ID }),
    text: allDocsGeneratedTemplateText({ orgName: ORG, orgId: ORG_ID }),
  },
  {
    file: 'approval-reminder.ts',
    audience: 'operator',
    subject: approvalReminderSubject(ORG),
    html: approvalReminderTemplate({ orgName: ORG, docType: 'icp', autoApprovesAt: '9 September 2026 at 14:00' }),
  },
  {
    file: 'client-revision-notify.ts',
    audience: 'operator',
    subject: clientRevisionNotifySubject(ORG, 'positioning'),
    html: clientRevisionNotifyTemplate({ orgName: ORG, orgId: ORG_ID, docType: 'positioning', revisionNote: NOTE }),
    text: clientRevisionNotifyTemplateText({ orgName: ORG, orgId: ORG_ID, docType: 'positioning', revisionNote: NOTE }),
  },
  {
    file: 'intake-complete.ts',
    audience: 'operator',
    subject: intakeCompleteSubject(ORG),
    html: intakeCompleteTemplate({ orgName: ORG, orgId: ORG_ID }),
  },
  {
    file: 'messaging-revision-staged.ts',
    audience: 'operator',
    subject: messagingRevisionStagedSubject(ORG),
    html: messagingRevisionStagedTemplate({ orgName: ORG, orgId: ORG_ID, revisionNote: NOTE }),
    text: messagingRevisionStagedTemplateText({ orgName: ORG, orgId: ORG_ID, revisionNote: NOTE }),
  },
  {
    file: 'multi-user-signup-attempt.ts',
    audience: 'operator',
    subject: multiUserSignupAttemptSubject(ORG),
    html: multiUserSignupAttemptTemplate({
      attemptedEmail: 'someone@apexconsulting.com',
      orgId: ORG_ID,
      orgName: ORG,
      attemptedAt: '7 September 2026 at 15:04',
    }),
  },
  {
    file: 'operator-reply.ts',
    audience: 'operator',
    subject: operatorReplySubject({ clientName: ORG, prospectName: 'Jordan Reid', prospectCompany: 'Northwind', classifiedIntent: 'positive' }),
    html: operatorReplyTemplate({ clientName: ORG, prospectName: 'Jordan Reid', prospectCompany: 'Northwind', classifiedIntent: 'positive' }),
    text: operatorReplyTemplateText({ clientName: ORG, prospectName: 'Jordan Reid', prospectCompany: 'Northwind', classifiedIntent: 'positive' }),
  },
  {
    file: 'revision-gate-failure.ts',
    audience: 'operator',
    subject: revisionGateFailureSubject(ORG, 'messaging'),
    html: revisionGateFailureTemplate({ orgName: ORG, orgId: ORG_ID, docType: 'messaging', revisionNote: NOTE }),
  },
  {
    // Sent with audience 'operator' by send-unmatched-booking-notification.ts, to
    // RESEND_OPERATOR_EMAIL only. Rendered with every optional field empty, so a missing
    // value is proved to read as words rather than as a literal null.
    file: 'unmatched-booking.ts',
    audience: 'operator',
    subject: unmatchedBookingSubject(UNMATCHED_BOOKING),
    html: unmatchedBookingTemplate(UNMATCHED_BOOKING),
  },
]

// ─── CUSTOMER-FACING ─────────────────────────────────────────────────────────
// These reach a client or a prospect, so the full rule set applies, dashes included.
// version-updated is here deliberately even though an operator also receives it: it CAN
// reach a client, and the stricter audience is the safe classification for a template with
// two recipients.
const CUSTOMER_TEMPLATES: RenderedTemplate[] = [
  {
    file: 'client-welcome.ts',
    audience: 'customer',
    subject: clientWelcomeSubject(ORG),
    html: clientWelcomeTemplate({ founderFirstName: 'Alex', orgName: ORG, otpCode: '123456', loginUrl: 'https://app.margenticos.com/login?email=a%40b.com&invite=1' }),
    text: clientWelcomeTemplateText({ founderFirstName: 'Alex', orgName: ORG, otpCode: '123456', loginUrl: 'https://app.margenticos.com/login?email=a%40b.com&invite=1' }),
  },
  {
    file: 'docs-ready.ts',
    audience: 'customer',
    subject: docsReadySubject(),
    html: docsReadyTemplate({ orgName: ORG, orgId: ORG_ID }),
    text: docsReadyTemplateText({ orgName: ORG, orgId: ORG_ID }),
  },
  {
    file: 'first-meeting.ts',
    audience: 'customer',
    subject: firstMeetingSubject('Northwind'),
    html: firstMeetingTemplate({ prospectName: 'Jordan Reid', prospectTitle: 'Head of Ops', prospectCompany: 'Northwind', meetingTime: '30 September 2026 at 2:00 PM' }),
    text: firstMeetingTemplateText({ prospectName: 'Jordan Reid', prospectTitle: 'Head of Ops', prospectCompany: 'Northwind', meetingTime: '30 September 2026 at 2:00 PM' }),
  },
  {
    file: 'intake-nudge.ts',
    audience: 'customer',
    subject: intakeNudgeSubject(),
    html: intakeNudgeTemplate({ clientFirstName: 'Alex', completionPercent: 60, intakeUrl: 'https://app.margenticos.com/intake', kickoffDate: '30 September' }),
    text: intakeNudgeTemplateText({ clientFirstName: 'Alex', completionPercent: 60, intakeUrl: 'https://app.margenticos.com/intake', kickoffDate: '30 September' }),
  },
  {
    file: 'list-ready.ts',
    audience: 'customer',
    subject: listReadySubject('30 September'),
    html: listReadyTemplate({ clientFirstName: 'Alex', prospectCount: 42, reviewUrl: 'https://app.margenticos.com/dashboard/prospects', lockDate: '30 September' }),
    text: listReadyTemplateText({ clientFirstName: 'Alex', prospectCount: 42, reviewUrl: 'https://app.margenticos.com/dashboard/prospects', lockDate: '30 September' }),
  },
  {
    file: 'meeting-confirmation.ts',
    audience: 'customer',
    subject: meetingConfirmationSubject(),
    html: meetingConfirmationTemplate({
      clientName: 'Alex',
      prospectName: 'Jordan Reid',
      meetingDate: 'Monday, 29 September at 2:00 PM',
      windowClosesDate: 'Wednesday, 1 October',
      confirmationUrl: 'https://app.margenticos.com/confirm-meeting/abc123',
      companyName: ORG,
    }),
  },
  {
    file: 'revision-processed.ts',
    audience: 'customer',
    subject: revisionProcessedSubject(ORG, 'icp'),
    html: revisionProcessedTemplate({ orgName: ORG, docType: 'icp' }),
  },
  {
    file: 'version-updated.ts',
    audience: 'customer',
    subject: versionUpdatedSubject(ORG, 'icp'),
    html: versionUpdatedTemplate({ docType: 'icp', recipientFirstName: 'Alex', senderFirstName: 'Doug', senderCompanyName: 'MargenticOS' }),
    text: versionUpdatedText({ docType: 'icp', recipientFirstName: 'Alex', senderFirstName: 'Doug', senderCompanyName: 'MargenticOS' }),
  },
  {
    file: 'warming-complete.ts',
    audience: 'customer',
    subject: warmingCompleteSubject('30 September'),
    html: warmingCompleteTemplate({ sendDate: '30 September' }),
    text: warmingCompleteTemplateText({ sendDate: '30 September' }),
  },
  {
    file: 'warmup-halfway.ts',
    audience: 'customer',
    subject: warmupHalfwaySubject(),
    html: warmupHalfwayTemplate({ sendDate: '30 September' }),
    text: warmupHalfwayTemplateText({ sendDate: '30 September' }),
  },
]

const ALL_TEMPLATES = [...OPERATOR_TEMPLATES, ...CUSTOMER_TEMPLATES]

describe('every template passes the validator for the audience it is actually sent to', () => {
  for (const t of ALL_TEMPLATES) {
    it(`${t.file} (${t.audience}) renders to something the validator will send`, () => {
      const verdict = validateEmailContent(t.subject, t.html, t.text, t.audience)
      expect(verdict).toBeNull()
    })
  }
})

describe('the classification is checked against the world, not against itself', () => {
  // Straight from CLAUDE.md: a registry test that only reads the registry proves nothing.
  // This reads the directory. Add a template and forget to classify it and this fails,
  // which is the moment somebody has to decide who the email is for.
  it('every file in templates/ is classified as operator or customer', () => {
    const dir = join(__dirname, '..', 'templates')
    const onDisk = readdirSync(dir)
      .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .sort()

    // Guard the guard. If the read ever returns nothing, this suite would pass over an
    // empty set and report success for a directory it never looked at.
    expect(onDisk.length).toBeGreaterThan(15)

    const classified = ALL_TEMPLATES.map(t => t.file).sort()
    expect(classified).toEqual(onDisk)
  })

  it('no template is classified twice', () => {
    const files = ALL_TEMPLATES.map(t => t.file)
    expect(new Set(files).size).toBe(files.length)
  })
})

describe('the operator exemption is load-bearing, not decorative', () => {
  // This is the assertion that fails if somebody deletes the audience branch from
  // validateEmailContent and goes back to one universal rule. It uses a fixed literal
  // rather than a template's contents, so removing a dash from a template later does not
  // make this test lie about what the validator does.
  const BRANDING = 'MargenticOS — Operator Alert'

  it('rejects the operator branding line when the audience is customer', () => {
    const verdict = validateEmailContent('subject', `<p>${BRANDING}</p>`, undefined, 'customer')
    expect(verdict).toContain('em dash')
  })

  it('accepts the same line when the audience is operator', () => {
    const verdict = validateEmailContent('subject', `<p>${BRANDING}</p>`, undefined, 'operator')
    expect(verdict).toBeNull()
  })

  it('defaults to customer, so an unlabelled email gets the strict rules', () => {
    const withoutAudience = validateEmailContent('subject', `<p>${BRANDING}</p>`)
    expect(withoutAudience).toContain('em dash')
  })
})

describe('every operator send site carries the label', () => {
  // The classification above is only worth anything if the call sites agree with it. This
  // reads the source of every route that sends to the operator and asserts the label is
  // actually passed. Drop `audience: 'operator'` from any of them and this goes red.
  //
  // Scanned rather than executed because these live inside route handlers with auth,
  // database and agent dependencies, and the thing being checked is one literal argument.
  it("every `to: operatorEmail` send passes audience: 'operator'", () => {
    const root = join(__dirname, '..', '..', '..')
    const offenders: string[] = []
    let sitesFound = 0

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__tests__') continue
          walk(full)
          continue
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue

        const src = readFileSync(full, 'utf-8')
        if (!src.includes('to: operatorEmail,')) continue

        // Each send call is an object literal. Take the window from the recipient line to
        // the end of that call and require the label inside it.
        const lines = src.split('\n')
        lines.forEach((line, i) => {
          if (!line.trim().startsWith('to: operatorEmail,')) return
          sitesFound++
          const window = lines.slice(i, i + 12).join('\n')
          if (!window.includes("audience: 'operator'")) {
            offenders.push(`${full.replace(root, 'src')}:${i + 1}`)
          }
        })
      }
    }

    walk(root)

    // Guard the guard. If the walk stops finding call sites, this test would pass over an
    // empty set and report that every site is labelled while checking none of them.
    expect(sitesFound).toBeGreaterThanOrEqual(13)
    expect(offenders).toEqual([])
  })
})

describe('rendering checks apply to operator mail too', () => {
  // The exemption is scoped to style. A template handed a missing variable is a bug in an
  // operator alert exactly as much as in a client email, and must still be caught.
  it.each(['undefined', 'null', 'NaN'])('rejects literal "%s" even for an operator', (token) => {
    const verdict = validateEmailContent('subject', `<p>Client ${token} failed</p>`, undefined, 'operator')
    expect(verdict).toContain(token)
  })
})

describe('the validator is deterministic across calls', () => {
  // The patterns were declared with the `g` flag and used with .test(). A global regex
  // carries lastIndex between calls, so the SAME pattern against the SAME string returned
  // true, then false, then true. The patterns are module-level, so that state persisted
  // across emails: the validator blocked roughly every other offending email and passed
  // the ones in between.
  //
  // Restore any `g` flag in send.ts and this test goes red on the second iteration.
  // THE OFFENDING CHARACTER MUST BE IN THE SUBJECT, and this is not a detail.
  //
  // The first version of this test put the dash in the html and passed with the `g` flag
  // restored, so it asserted determinism while being structurally incapable of detecting
  // its absence. The reason: the validator checks [subject, html, text] in order, and a
  // clean subject is itself a failed .test() that resets lastIndex to 0 before the html is
  // ever looked at. The state never survives to the next call.
  //
  // Only a match on the FIRST string checked leaves lastIndex non-zero on return. Measured
  // with the g flag restored: dash in subject gives em dash, null, em dash, null. Dash in
  // html gives em dash four times.
  //
  // /api/resend-test is the real instance: its subject is "MargenticOS — Resend wiring
  // verified", so that endpoint's verdict genuinely alternated between calls.
  it('returns the same verdict for the same input, ten times running', () => {
    const subject = 'MargenticOS — Resend wiring verified'
    const verdicts = Array.from({ length: 10 }, () =>
      validateEmailContent(subject, '<p>clean body</p>', undefined, 'customer'),
    )
    expect(new Set(verdicts).size).toBe(1)
    expect(verdicts[0]).toContain('em dash')
  })

  it('is deterministic for the clean case too', () => {
    const verdicts = Array.from({ length: 10 }, () =>
      validateEmailContent('clean subject', '<p>Nothing wrong here</p>', undefined, 'customer'),
    )
    expect(new Set(verdicts).size).toBe(1)
    expect(verdicts[0]).toBeNull()
  })
})
