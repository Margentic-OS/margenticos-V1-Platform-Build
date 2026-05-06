'use server'

// Server action: sends a magic link to the provided email address.
// Supabase handles the email delivery and token generation.
// On click, the user is redirected to /auth/callback which completes the login.

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { getAppUrl } from '@/lib/urls/app-url'

export async function sendMagicLink(formData: FormData) {
  const email = (formData.get('email') as string)?.trim().toLowerCase()

  if (!email) {
    redirect('/login?error=email_required')
  }

  const supabase = await createClient()

  const rawNext = (formData.get('next') as string | null) ?? ''
  // Only allow paths within the client dashboard. Operator routes are excluded —
  // the operator layout handles role-based access after auth completes.
  const isValidNext =
    rawNext.startsWith('/dashboard/') && !rawNext.startsWith('/dashboard/operator')
  const safeNext = isValidNext ? rawNext : '/dashboard'

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

  redirect('/login?sent=true')
}
