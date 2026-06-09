'use server'

// Server actions for passwordless login.
// sendMagicLink: sends an email with a 6-digit OTP code (no link — immune to Outlook Safe Links prefetch).
// verifyOtpCode: verifies the code entered on the post-send screen.
//   isInvite=true uses type:'invite' for first-time account setup from a welcome email.
//   isInvite=false uses type:'email' for returning-user sign-in.

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

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

  // No emailRedirectTo — sends a 6-digit OTP code only, no clickable link.
  // Clickable links in auth emails are consumed by Outlook Safe Links prefetch,
  // which scans links before the user sees them (common in B2B Office 365 tenants).
  //
  // shouldCreateUser: false — only users pre-provisioned via generateLink (invited
  // by the operator) can sign in. An unregistered email causes Supabase to return
  // a 422 (otp_disabled). The error block below converts that to a neutral success
  // redirect so callers cannot distinguish registered from unregistered emails.
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  })

  if (error) {
    // 422 means the email is not registered (shouldCreateUser:false, otp_disabled).
    // Treat it identically to success so callers cannot probe whether an email has an account.
    const isUnknownEmail = error.status === 422
    if (isUnknownEmail) {
      logger.info('OTP send skipped: unregistered email', { status: error.status })
    } else {
      const isRateLimit = error.status === 429
      logger.error('OTP send failed', { email, error: error.message, isRateLimit })
      redirect(isRateLimit ? '/login?error=rate_limited' : '/login?error=send_failed')
    }
  }

  const nextParam = safeNext !== '/dashboard' ? `&next=${encodeURIComponent(safeNext)}` : ''
  redirect(`/login?sent=true&email=${encodeURIComponent(email)}${nextParam}`)
}

export async function verifyOtpCode(formData: FormData) {
  const email = (formData.get('email') as string)?.trim().toLowerCase()
  const token = (formData.get('token') as string)?.trim()
  const isInvite = formData.get('invite') === '1'

  if (!email || !token) {
    redirect('/login?error=code_invalid')
  }

  const supabase = await createClient()
  const safeNext = safeNextPath(formData.get('next') as string | null)

  const { error } = await supabase.auth.verifyOtp({
    email,
    token,
    type: isInvite ? 'invite' : 'email',
  })

  if (error) {
    logger.error('OTP verify failed', { email, type: isInvite ? 'invite' : 'email', error: error.message })
    const encodedEmail = encodeURIComponent(email)
    const nextParam = safeNext !== '/dashboard' ? `&next=${encodeURIComponent(safeNext)}` : ''
    const inviteParam = isInvite ? '&invite=1' : ''
    const errorCode = error.message?.toLowerCase().includes('expired') ? 'code_expired' : 'code_invalid'
    redirect(`/login?sent=true&email=${encodedEmail}${nextParam}${inviteParam}&error=${errorCode}`)
  }

  redirect(safeNext)
}
