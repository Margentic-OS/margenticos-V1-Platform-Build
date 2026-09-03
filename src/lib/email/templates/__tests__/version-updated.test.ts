import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  versionUpdatedTemplate,
  versionUpdatedText,
  versionUpdatedSubject,
} from '../version-updated'
import { DOCUMENT_META, DOCUMENT_ORDER } from '@/lib/document-labels'

// RULE ZERO: a real client's name must not sit in a fixture. The subject ignores this
// argument entirely, which is itself part of what the assertions below check.
const ORG_NAME = 'An organisation'
const ORIGINAL = process.env.NEXT_PUBLIC_APP_URL
beforeEach(() => { process.env.NEXT_PUBLIC_APP_URL = 'https://app.margenticos.com' })
afterEach(() => { process.env.NEXT_PUBLIC_APP_URL = ORIGINAL })

const params = {
  docType: 'icp',
  recipientFirstName: 'Jordan',
  senderFirstName: 'Doug',
  senderCompanyName: 'MargenticOS',
  clientId: null,
}

describe('version_pending notification', () => {
  it('links to the document that changed, not to the route that 404s', () => {
    const html = versionUpdatedTemplate(params)
    expect(html).toContain('https://app.margenticos.com/dashboard/strategy/icp')
    expect(html).not.toContain('/dashboard/documents')
  })

  it('deep links per document type', () => {
    for (const [docType, path] of [
      ['positioning', 'strategy/positioning'],
      ['tov', 'strategy/tov'],
      ['messaging', 'strategy/messaging'],
    ]) {
      expect(versionUpdatedTemplate({ ...params, docType })).toContain(path)
    }
  })

  it('carries ?client= only for an operator recipient', () => {
    expect(versionUpdatedTemplate(params)).not.toContain('client=')
    expect(versionUpdatedTemplate({ ...params, clientId: 'org-uuid' })).toContain('client=org-uuid')
  })

  it('greets the recipient by name and is signed by a person, not a Team', () => {
    const html = versionUpdatedTemplate(params)
    expect(html).toContain('Hi Jordan,')
    expect(html).toContain('Doug')
    expect(html).toContain('MargenticOS')
    expect(html).not.toContain('Team')
  })

  it('falls back to a plain greeting rather than inventing a name', () => {
    const html = versionUpdatedTemplate({ ...params, recipientFirstName: null })
    expect(html).toContain('Hi,')
    expect(html).not.toContain('Hi null')
  })

  // The send path rejects both dash characters outright. A template that trips that
  // validator sends nothing at all, and the failure is only visible in a log line.
  it('contains no em dash or en dash, in either format', () => {
    for (const body of [versionUpdatedTemplate(params), versionUpdatedText(params)]) {
      expect(body).not.toMatch(/[—–]/)
    }
  })

  it('has a plain text version carrying the same link', () => {
    const text = versionUpdatedText(params)
    expect(text).toContain('https://app.margenticos.com/dashboard/strategy/icp')
    expect(text).toContain('Hi Jordan,')
    expect(text).toContain('Doug\nMargenticOS')
  })

  it('names the document in the subject, using the name the client will see on the page', () => {
    expect(versionUpdatedSubject(ORG_NAME, 'icp')).toBe('Prospect profile has been updated')
    expect(versionUpdatedSubject(ORG_NAME, 'tov')).toBe('Voice guide has been updated')
  })

  // THE DRIFT GUARD. This template used to carry its own { icp: 'ICP', tov: 'Tone of Voice' }
  // map, so a client got an email about their "ICP" and landed on a page titled "Prospect
  // profile". Asserting the four strings by hand would just be a THIRD list. This asserts
  // AGREEMENT with the source the UI reads, so renaming a document in one place cannot
  // leave the email behind.
  it('uses the same label the dashboard uses, for every document type', () => {
    for (const docType of DOCUMENT_ORDER) {
      const uiLabel = DOCUMENT_META[docType].label
      expect(versionUpdatedSubject(ORG_NAME, docType)).toBe(`${uiLabel} has been updated`)
      expect(versionUpdatedTemplate({ ...params, docType })).toContain(`Your ${uiLabel} has been updated`)
      expect(versionUpdatedText({ ...params, docType })).toContain(`Read your ${uiLabel}:`)
    }
  })

  it('never sends the internal vocabulary to a client', () => {
    for (const docType of DOCUMENT_ORDER) {
      const html = versionUpdatedTemplate({ ...params, docType })
      const text = versionUpdatedText({ ...params, docType })
      for (const internal of ['ICP', 'Tone of Voice', 'Ideal Client Profile']) {
        expect(html, `${docType} html leaks "${internal}"`).not.toContain(internal)
        expect(text, `${docType} text leaks "${internal}"`).not.toContain(internal)
      }
    }
  })

  // THE REGRESSION THIS GUARDS. Until 2026-09-03 this email told a client that silence
  // for three days counted as approval. strategy-doc-auto-approve made that true. The
  // cron is unscheduled and client approval is removed (ADR-047), so the sentence would
  // now be a promise about a process that does not exist: it asks the client to act by a
  // deadline that never arrives. Asserting on the ABSENCE of the old vocabulary is the
  // point, because the failure mode is copy that survives the mechanism it described.
  it('makes no promise about an approval window, because there is no longer one', () => {
    for (const body of [versionUpdatedTemplate(params), versionUpdatedText(params)]) {
      expect(body).not.toContain('three days')
      expect(body).not.toContain('approval')
      expect(body).not.toContain('approve')
      expect(body).not.toContain('Approve')
    }
  })

  it('tells the client the version is already in force', () => {
    const html = versionUpdatedTemplate(params)
    expect(html).toContain('This is the version we are working from now.')
    expect(html).toContain('There is nothing you need to click')
  })
})
