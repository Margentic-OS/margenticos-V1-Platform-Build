import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  versionPendingTemplate,
  versionPendingText,
  versionPendingSubject,
} from '../version-pending'

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

  it('says what happens if the client does nothing', () => {
    expect(versionPendingTemplate(params)).toContain('approved automatically after three days')
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

  it('names the document in the subject', () => {
    expect(versionPendingSubject('Simcare', 'icp')).toBe('ICP has been updated')
    expect(versionPendingSubject('Simcare', 'tov')).toBe('Tone of Voice has been updated')
  })
})
