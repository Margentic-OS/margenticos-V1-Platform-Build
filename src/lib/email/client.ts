import { Resend } from 'resend'

if (!process.env.RESEND_API_KEY) {
  throw new Error('RESEND_API_KEY is required but not set.')
}

export const resendClient = new Resend(process.env.RESEND_API_KEY)
