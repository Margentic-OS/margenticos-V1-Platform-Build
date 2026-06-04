'use server'

// Server actions for passwordless login.
// sendMagicLink: sends an email with a sign-in link + 8-digit code.
// verifyOtpCode: verifies the code entered on the post-send screen.

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { getAppUrl } from '@/lib/urls/app-url'

function safeNextPath(raw: string | null): string {
  const r = raw ?? ''
  return r.startsWith('/dashboard/') && !r.startsWith('/dashboard/operator')
    ? r
    : '/dashboard'
}

export async function sendMagicLink(formData: FormData) {
  const email = (formData.get('email') as string)?.trim().toLowerCase()

  if (!email) {
    redirect('/login?error=email_required')
  }

  const supabase = await createClient()
  const safeNext = safeNextPath(formData.get('next') as string | null)

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${getAppUrl()}/auth/callback?next=${encodeURIComponent(safeNext)}`,
    },
  })

  if (error) {
    const isRateLimit = error.status === 429
    logger.error('Magic link send failed', { email, error: error.message, isRateLimit })
    redirect(isRateLimit ? '/login?error=rate_limited' : '/login?error=send_failed')
  }

  const nextParam = safeNext !== '/dashboard' ? `&next=${encodeURIComponent(safeNext)}` : ''
  redirect(`/login?sent=true&email=${encodeURIComponent(email)}${nextParam}`)
}

export async function verifyOtpCode(formData: FormData) {
  const email = (formData.get('email') as string)?.trim().toLowerCase()
  const token = (formData.get('token') as string)?.trim()

  if (!email || !token) {
    redirect('/login?error=code_invalid')
  }

  const supabase = await createClient()
  const safeNext = safeNextPath(formData.get('next') as string | null)

  const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' })

  if (error) {
    logger.error('OTP verify failed', { email, error: error.message })
    const encodedEmail = encodeURIComponent(email)
    const nextParam = safeNext !== '/dashboard' ? `&next=${encodeURIComponent(safeNext)}` : ''
    const errorCode = error.message?.toLowerCase().includes('expired') ? 'code_expired' : 'code_invalid'
    redirect(`/login?sent=true&email=${encodedEmail}${nextParam}&error=${errorCode}`)
  }

  redirect(safeNext)
}
