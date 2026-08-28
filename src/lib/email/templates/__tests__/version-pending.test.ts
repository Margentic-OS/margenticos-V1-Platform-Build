import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  versionPendingTemplate,
  versionPendingText,
  versionPendingSubject,
} from '../version-pending'
import { DOCUMENT_META, DOCUMENT_ORDER } from '@/lib/document-labels'

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
    const html = versionPendingTemplate(params)
    expect(html).toContain('https://app.margenticos.com/dashboard/strategy/icp')
    expect(html).not.toContain('/dashboard/documents')
  })

  it('deep links per document type', () => {
    for (const [docType, path] of [
      ['positioning', 'strategy/positioning'],
      ['tov', 'strategy/tov'],
      ['messaging', 'strategy/messaging'],
    ]) {
      expect(versionPendingTemplate({ ...params, docType })).toContain(path)
    }
  })

  it('carries ?client= only for an operator recipient', () => {
    expect(versionPendingTemplate(params)).not.toContain('client=')
    expect(versionPendingTemplate({ ...params, clientId: 'org-uuid' })).toContain('client=org-uuid')
  })

  it('greets the recipient by name and is signed by a person, not a Team', () => {
    const html = versionPendingTemplate(params)
    expect(html).toContain('Hi Jordan,')
    expect(html).toContain('Doug')
    expect(html).toContain('MargenticOS')
    expect(html).not.toContain('Team')
  })

  it('falls back to a plain greeting rather than inventing a name', () => {
    const html = versionPendingTemplate({ ...params, recipientFirstName: null })
    expect(html).toContain('Hi,')
    expect(html).not.toContain('Hi null')
  })

  // The send path rejects both dash characters outright. A template that trips that
  // validator sends nothing at all, and the failure is only visible in a log line.
  it('contains no em dash or en dash, in either format', () => {
    for (const body of [versionPendingTemplate(params), versionPendingText(params)]) {
      expect(body).not.toMatch(/[—–]/)
    }
  })

  it('has a plain text version carrying the same link', () => {
    const text = versionPendingText(params)
    expect(text).toContain('https://app.margenticos.com/dashboard/strategy/icp')
    expect(text).toContain('Hi Jordan,')
    expect(text).toContain('Doug\nMargenticOS')
  })

  it('names the document in the subject, using the name the client will see on the page', () => {
    expect(versionPendingSubject('Simcare', 'icp')).toBe('Prospect profile has been updated')
    expect(versionPendingSubject('Simcare', 'tov')).toBe('Voice guide has been updated')
  })

  // THE DRIFT GUARD. This template used to carry its own { icp: 'ICP', tov: 'Tone of Voice' }
  // map, so a client got an email about their "ICP" and landed on a page titled "Prospect
  // profile". Asserting the four strings by hand would just be a THIRD list. This asserts
  // AGREEMENT with the source the UI reads, so renaming a document in one place cannot
  // leave the email behind.
  it('uses the same label the dashboard uses, for every document type', () => {
    for (const docType of DOCUMENT_ORDER) {
      const uiLabel = DOCUMENT_META[docType].label
      expect(versionPendingSubject('Simcare', docType)).toBe(`${uiLabel} has been updated`)
      expect(versionPendingTemplate({ ...params, docType })).toContain(`Your ${uiLabel} has been updated`)
      expect(versionPendingText({ ...params, docType })).toContain(`Review your ${uiLabel}:`)
    }
  })

  it('never sends the internal vocabulary to a client', () => {
    for (const docType of DOCUMENT_ORDER) {
      const html = versionPendingTemplate({ ...params, docType })
      const text = versionPendingText({ ...params, docType })
      for (const internal of ['ICP', 'Tone of Voice', 'Ideal Client Profile']) {
        expect(html, `${docType} html leaks "${internal}"`).not.toContain(internal)
        expect(text, `${docType} text leaks "${internal}"`).not.toContain(internal)
      }
    }
  })

  it('states the three-day rule as a commitment rather than a default to ignore', () => {
    const html = versionPendingTemplate(params)
    expect(html).toContain('If we do not hear from you within three days we will take that as approval and move ahead.')
    expect(html).not.toContain('If you do nothing')
  })
})
