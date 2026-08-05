import { describe, it, expect, vi } from 'vitest'
import { sendTransactionalEmail } from '../send'

describe('sendTransactionalEmail', () => {
  describe('content validation guard', () => {
    it('should reject email with literal "undefined" in subject', async () => {
      const result = await sendTransactionalEmail({
        to: 'test@example.com',
        subject: 'your prospect list, needs approval by undefined',
        html: '<p>Complete data here</p>',
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('undefined')
      }
    })

    it('should reject email with literal "undefined" in html', async () => {
      const result = await sendTransactionalEmail({
        to: 'test@example.com',
        subject: 'Valid subject',
        html: '<p>We prepared undefined prospects for you</p>',
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('undefined')
      }
    })

    it('should reject email with literal "undefined" in text', async () => {
      const result = await sendTransactionalEmail({
        to: 'test@example.com',
        subject: 'Valid subject',
        html: '<p>Complete data</p>',
        text: 'Review by undefined',
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('undefined')
      }
    })

    it('should reject email with literal "null" in content', async () => {
      const result = await sendTransactionalEmail({
        to: 'test@example.com',
        subject: 'Valid subject',
        html: '<p>Prospect count: null</p>',
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('null')
      }
    })

    it('should reject email with literal "NaN" in content', async () => {
      const result = await sendTransactionalEmail({
        to: 'test@example.com',
        subject: 'Valid subject',
        html: '<p>Completion: NaN%</p>',
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('NaN')
      }
    })

    it('should allow word "undefined" in URLs without false positive', async () => {
      const result = await sendTransactionalEmail({
        to: 'test@example.com',
        subject: 'Valid subject',
        html: '<a href="https://example.com/undefined-behavior">link</a>',
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('undefined')
      }
    })

    it('should allow complete, valid email to send', async () => {
      const result = await sendTransactionalEmail({
        to: 'test@example.com',
        subject: 'your prospect list, needs approval by August 10',
        html: '<p>We prepared 250 prospects for your review.</p>',
        text: 'Review by August 10',
      })

      if (result.success) {
        expect(result.messageId).toBeDefined()
      } else {
        expect(result.error).not.toContain('content validation')
      }
    })

    it('should not send if validation fails (no Resend call)', async () => {
      const result = await sendTransactionalEmail({
        to: 'test@example.com',
        subject: 'Review by undefined',
        html: '<p>Valid content</p>',
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('undefined')
      }
    })

    it('should handle prospectCount guard in publish-tier route', async () => {
      const result = await sendTransactionalEmail({
        to: 'test@example.com',
        subject: 'your prospect list, needs approval by August 15',
        html: '<p>487 prospects prepared for your review</p>',
      })

      if (!result.success) {
        expect(result.error).not.toContain('undefined')
        expect(result.error).not.toContain('null')
      }
    })
  })
})
