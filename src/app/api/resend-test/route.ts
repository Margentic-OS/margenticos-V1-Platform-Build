import { NextResponse } from 'next/server'
import { sendTransactionalEmail } from '@/lib/email/send'

export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const result = await sendTransactionalEmail({
    to: 'doug@margenticos.com',
    subject: 'MargenticOS — Resend wiring verified',
    html: '<p>Resend is wired and working. Transactional email is live for MargenticOS.</p>',
    text: 'Resend is wired and working. Transactional email is live for MargenticOS.',
  })

  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 500 })
  }

  return NextResponse.json({ success: true, messageId: result.messageId })
}
