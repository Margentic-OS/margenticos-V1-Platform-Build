'use server'

// Server action: sends a magic link to the provided email address.
// Supabase handles the email delivery and token generation.
// On click, the user is redirected to /auth/callback which completes the login.

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

export async function sendMagicLink(formData: FormData) {
  const email = (formData.get('email') as string)?.trim().toLowerCase()

  if (!email) {
    redirect('/login?error=email_required')
  }

  const supabase = await createClient()

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
    },
  })

  if (error) {
    logger.error('Magic link send failed', { email, error: error.message })
    redirect('/login?error=send_failed')
  }

  redirect('/login?sent=true')
}
